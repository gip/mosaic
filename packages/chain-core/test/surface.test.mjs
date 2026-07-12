import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SurfaceFeed } from '../dist/index.js';

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const RLUSD_ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';

const STELLAR_REQ = {
  chain: 'stellar',
  network: 'mainnet',
  base: { kind: 'native' },
  quote: { kind: 'issued', code: 'USDC', issuer: USDC_ISSUER },
  fundedAccounts: { base: null, quote: null },
};

const XRPL_REQ = {
  chain: 'xrpl',
  network: 'testnet',
  base: { kind: 'native' },
  quote: { kind: 'issued', code: 'RLUSD', issuer: RLUSD_ISSUER },
  fundedAccounts: { base: 'rXrpFunded', quote: 'rRlusdFunded' },
};

const drain = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

const BOOK = {
  ...STELLAR_REQ,
  bids: [
    { price: '0.19', amount: '600' },
    { price: '0.18', amount: '400' },
  ],
  asks: [
    { price: '0.21', amount: '500' },
    { price: '0.22', amount: '700' },
  ],
  timestamp: 0,
};

function makeSurface(tag) {
  return {
    ...STELLAR_REQ,
    sell: [{ amount: '1', total: tag, avgPrice: tag }],
    buy: [{ amount: '1', total: tag, avgPrice: tag }],
    timestamp: Date.now(),
  };
}

test('polling mode: derives ladder from the book, polls on interval, backs off on errors', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const surfaceCalls = [];
  let failNext = false;
  const adapter = {
    async fetchOrderBook() {
      return BOOK;
    },
    openStream() {
      throw new Error('unused');
    },
    async fetchQuoteSurface(_req, opts) {
      if (failNext) {
        failNext = false;
        throw new Error('horizon down');
      }
      surfaceCalls.push(opts);
      return makeSurface(String(surfaceCalls.length));
    },
    // no openSurfaceStream → polling mode
  };
  const feed = new SurfaceFeed(adapter, STELLAR_REQ, { intervalMs: 5_000 });
  const events = [];
  feed.subscribe((e) => events.push(e));

  feed.start();
  assert.equal(feed.status, 'connecting');
  await drain();
  assert.equal(feed.status, 'live');
  assert.equal(surfaceCalls.length, 1);
  // ladder: fractions of min(bid depth 1000, ask depth 1200) = 1000
  assert.deepEqual(surfaceCalls[0].sizes, ['200', '400', '600', '800', '1000']);
  assert.equal(surfaceCalls[0].referencePrice, '0.2'); // mid of 0.19 / 0.21

  t.mock.timers.tick(5_000);
  await drain();
  assert.equal(surfaceCalls.length, 2);

  // failure → error event + reconnecting + 1s backoff retry
  failNext = true;
  t.mock.timers.tick(5_000);
  await drain();
  assert.equal(feed.status, 'reconnecting');
  assert.equal(events.filter((e) => e.type === 'error').length, 1);
  t.mock.timers.tick(1_000);
  await drain();
  assert.equal(feed.status, 'live');
  assert.equal(surfaceCalls.length, 3);

  feed.stop();
  t.mock.timers.tick(60_000);
  await drain();
  assert.equal(surfaceCalls.length, 3);
});

test('empty book falls back to a 1-unit pathfinding probe and geometric ladder', async () => {
  const surfaceCalls = [];
  const adapter = {
    async fetchOrderBook() {
      return { ...BOOK, bids: [], asks: [] };
    },
    openStream() {
      throw new Error('unused');
    },
    async fetchQuoteSurface(_req, opts) {
      surfaceCalls.push(opts);
      if (opts.sizes.length === 1 && opts.sizes[0] === '1') {
        // the probe
        return { ...makeSurface('probe'), buy: [{ amount: '1', total: '0.5', avgPrice: '0.5' }] };
      }
      return makeSurface('real');
    },
  };
  const feed = new SurfaceFeed(adapter, STELLAR_REQ, {});
  const surface = await feed.refresh();
  assert.equal(surface.buy[0].total, 'real');
  const real = surfaceCalls.at(-1);
  assert.equal(real.referencePrice, '0.5'); // from the probe
  assert.deepEqual(real.sizes, ['1', '10', '100', '1000', '10000']);
});

test('quoteAmounts derive a matching base-size ladder and reach the adapter unchanged', async () => {
  const surfaceCalls = [];
  const adapter = {
    async fetchOrderBook() {
      return BOOK;
    },
    openStream() {
      throw new Error('unused');
    },
    async fetchQuoteSurface(_req, opts) {
      surfaceCalls.push(opts);
      return makeSurface('quoted');
    },
  };
  const feed = new SurfaceFeed(adapter, STELLAR_REQ, { quoteAmounts: ['1', '10', '100'] });

  await feed.refresh();

  assert.equal(surfaceCalls.length, 1);
  assert.equal(surfaceCalls[0].referencePrice, '0.2');
  assert.deepEqual(surfaceCalls[0].sizes, ['5', '50', '500']);
  assert.deepEqual(surfaceCalls[0].quoteAmounts, ['1', '10', '100']);
});

test('quoteAmounts are capped at chain-safe base precision', async () => {
  const surfaceCalls = [];
  const adapter = {
    async fetchOrderBook() {
      return { ...BOOK, bids: [{ price: '0.18', amount: '1000' }], asks: [{ price: '0.2', amount: '1000' }] };
    },
    openStream() {
      throw new Error('unused');
    },
    async fetchQuoteSurface(_req, opts) {
      surfaceCalls.push(opts);
      return makeSurface('quoted');
    },
  };
  const feed = new SurfaceFeed(adapter, STELLAR_REQ, { quoteAmounts: ['1'] });

  await feed.refresh();

  assert.deepEqual(surfaceCalls[0].sizes, ['5.263157']);
});

test('quoteAmounts and sampleSizes cannot be combined', () => {
  assert.throws(
    () => new SurfaceFeed({}, STELLAR_REQ, { sampleSizes: ['1'], quoteAmounts: ['1'] }),
    /quoteAmounts cannot be combined with sampleSizes/,
  );
});

test('streaming mode: adapter stream drives the feed, closed → reconnect', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const streams = [];
  const adapter = {
    async fetchOrderBook() {
      return BOOK;
    },
    openStream() {
      throw new Error('unused');
    },
    async fetchQuoteSurface() {
      throw new Error('unused in streaming mode');
    },
    openSurfaceStream(_req, opts, emit) {
      const s = { emit, opts, closed: false };
      streams.push(s);
      return {
        close() {
          s.closed = true;
        },
      };
    },
  };
  const feed = new SurfaceFeed(adapter, XRPL_REQ, { sampleSizes: ['5'], referencePrice: '2' });
  const events = [];
  feed.subscribe((e) => events.push(e));
  feed.start();
  await drain();
  assert.equal(streams.length, 1);
  assert.deepEqual(streams[0].opts.sizes, ['5']); // explicit options skip derivation

  streams[0].emit({ type: 'surface', surface: makeSurface('s1') });
  assert.equal(feed.status, 'live');
  assert.equal(feed.latest.buy[0].total, 's1');

  streams[0].emit({ type: 'closed' });
  assert.equal(feed.status, 'reconnecting');
  assert.equal(streams[0].closed, true);
  t.mock.timers.tick(1_000);
  assert.equal(streams.length, 2);

  feed.stop();
  assert.equal(feed.status, 'idle');
});
