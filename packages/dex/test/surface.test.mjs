import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SurfaceFeed, UnsupportedChainError, createQuoteSurfaceFeed } from '../dist/index.js';
import { createAdapter as createStellarAdapter } from '../dist/stellar/index.js';
import { createAdapter as createXrplAdapter } from '../dist/xrpl/index.js';

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const RLUSD_ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
const RLUSD_HEX = `524C555344${'0'.repeat(30)}`;
const XRP_FUNDED_ACCOUNT = 'rXrpFunded';
const RLUSD_FUNDED_ACCOUNT = 'rRlusdFunded';

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
  fundedAccounts: { base: XRP_FUNDED_ACCOUNT, quote: RLUSD_FUNDED_ACCOUNT },
};

const drain = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

/* ------------------------------------------------ stellar pathfinding */

test('stellar fetchQuoteSurface: URLs, best-record picking, empty-size skipping', async () => {
  const calls = [];
  const fetchMock = async (url) => {
    const u = new URL(String(url));
    calls.push(u);
    const size = u.searchParams.get('source_amount') ?? u.searchParams.get('destination_amount');
    if (size === '200') return new Response(JSON.stringify({ _embedded: { records: [] } }));
    const records = u.pathname.endsWith('strict-send')
      ? [
          { source_amount: '100', destination_amount: '19.5' },
          { source_amount: '100', destination_amount: '19.9' },
        ]
      : [
          { source_amount: '20.5', destination_amount: '100' },
          { source_amount: '20.1', destination_amount: '100' },
        ];
    return new Response(JSON.stringify({ _embedded: { records } }));
  };

  const adapter = createStellarAdapter();
  const surface = await adapter.fetchQuoteSurface(STELLAR_REQ, {
    sizes: ['100', '200'],
    referencePrice: '0.2',
    quoteAmounts: ['20', '40'],
    fetch: fetchMock,
    webSocket: WebSocket,
  });

  const send = calls.find((u) => u.pathname === '/paths/strict-send');
  assert.equal(send.origin, 'https://horizon.stellar.org');
  assert.equal(send.searchParams.get('source_asset_type'), 'native');
  assert.equal(send.searchParams.get('source_amount'), '100');
  assert.equal(send.searchParams.get('destination_assets'), `USDC:${USDC_ISSUER}`);
  const recv = calls.find((u) => u.pathname === '/paths/strict-receive');
  assert.equal(recv.searchParams.get('destination_asset_type'), 'native');
  assert.equal(recv.searchParams.get('destination_amount'), '100');
  assert.equal(recv.searchParams.get('source_assets'), `USDC:${USDC_ISSUER}`);

  // Sell picks max destination_amount; buy picks min source_amount; the
  // empty 200-size records are skipped entirely.
  assert.deepEqual(surface.sell, [{ amount: '100', total: '19.9', avgPrice: '0.199', quoteAmount: '20' }]);
  assert.deepEqual(surface.buy, [{ amount: '100', total: '20.1', avgPrice: '0.201', quoteAmount: '20' }]);
});

/* --------------------------------------------------- xrpl pathfinding */

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    FakeWebSocket.instances.push(this);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
    this.onclose?.();
  }
  respond(id, result) {
    this.onmessage?.({ data: JSON.stringify({ id, status: 'success', type: 'response', result }) });
  }
  pushFull(id, alternatives) {
    this.onmessage?.({ data: JSON.stringify({ id, type: 'path_find', full_reply: true, alternatives }) });
  }
}

function openXrplSurface(events, opts = {}) {
  FakeWebSocket.instances = [];
  const adapter = createXrplAdapter();
  const handle = adapter.openSurfaceStream(
    XRPL_REQ,
    {
      sizes: ['100'],
      referencePrice: '2',
      fetch: async () => {
        throw new Error('HTTP must not be used');
      },
      webSocket: FakeWebSocket,
      ...opts,
    },
    (e) => events.push(e),
  );
  return { handle, ws: FakeWebSocket.instances[0] };
}

test('xrpl surface stream: funded-account exact-receive cycle, surface assembly', async () => {
  const events = [];
  const { handle, ws } = openXrplSurface(events, { quoteAmounts: ['200'] });
  assert.equal(ws.url, 'wss://s.altnet.rippletest.net:51233');

  ws.onopen();
  // 1: subscribe ledger stream
  assert.deepEqual(ws.sent[0].streams, ['ledger']);
  ws.respond(ws.sent[0].id, {});
  await drain();

  // 2: buy — receive 100 XRP (drops), pay from the supplied RLUSD account.
  const buyReq = ws.sent[1];
  assert.equal(buyReq.command, 'path_find');
  assert.equal(buyReq.subcommand, 'create');
  assert.equal(buyReq.destination_amount, '100000000');
  assert.deepEqual(buyReq.source_currencies, [{ currency: RLUSD_HEX, issuer: RLUSD_ISSUER }]);
  assert.equal(buyReq.source_account, RLUSD_FUNDED_ACCOUNT);
  assert.equal(buyReq.destination_account, XRP_FUNDED_ACCOUNT);
  ws.respond(buyReq.id, {
    full_reply: true,
    alternatives: [
      { source_amount: { currency: RLUSD_HEX, issuer: RLUSD_ISSUER, value: '215' } },
      { source_amount: { currency: RLUSD_HEX, issuer: RLUSD_ISSUER, value: '210' } },
    ],
  });
  await drain();

  // 3: sell — receive 100 × 2 = 200 RLUSD, paid by the supplied XRP account.
  const sellReq = ws.sent[2];
  assert.deepEqual(sellReq.destination_amount, { currency: RLUSD_HEX, issuer: RLUSD_ISSUER, value: '200' });
  assert.deepEqual(sellReq.source_currencies, [{ currency: 'XRP' }]);
  assert.equal(sellReq.source_account, XRP_FUNDED_ACCOUNT);
  assert.equal(sellReq.destination_account, RLUSD_FUNDED_ACCOUNT);
  // partial reply first, then the async full reply completes the sample
  ws.respond(sellReq.id, { full_reply: false, alternatives: [] });
  await drain();
  assert.equal(events.length, 0);
  ws.pushFull(sellReq.id, [{ source_amount: '105000000' }]);
  await drain();

  // cycle ends: path_find close sent, surface emitted
  assert.equal(ws.sent[3].subcommand, 'close');
  assert.equal(events.length, 1);
  const surface = events[0].surface;
  assert.deepEqual(surface.buy, [
    { amount: '100', total: '210', avgPrice: '2.1', quoteAmount: '200' },
  ]);
  assert.deepEqual(surface.sell, [
    { amount: '105', total: '200', avgPrice: '1.904761904761904', quoteAmount: '200' },
  ]);

  // a ledger close triggers the next cycle
  ws.onmessage({ data: JSON.stringify({ type: 'ledgerClosed' }) });
  assert.equal(ws.sent[4].subcommand, 'create');

  handle.close();
  assert.equal(ws.closed, true);
});

test('xrpl surface stream: settles on the first reply carrying alternatives (no full reply)', async () => {
  const events = [];
  const { handle, ws } = openXrplSurface(events);
  ws.onopen();
  ws.respond(ws.sent[0].id, {});
  await drain();

  // buy: xrplcluster style — the create response has alternatives but
  // full_reply false, and no async update ever follows.
  const buyReq = ws.sent[1];
  ws.respond(buyReq.id, {
    full_reply: false,
    alternatives: [{ source_amount: { currency: RLUSD_HEX, issuer: RLUSD_ISSUER, value: '210' } }],
  });
  await drain();

  // sell: empty partial response, then an async *partial* update with routes.
  const sellReq = ws.sent[2];
  ws.respond(sellReq.id, { full_reply: false, alternatives: [] });
  await drain();
  assert.equal(events.length, 0);
  ws.onmessage({
    data: JSON.stringify({
      id: sellReq.id,
      type: 'path_find',
      full_reply: false,
      alternatives: [{ source_amount: '105000000' }],
    }),
  });
  await drain();

  assert.equal(events.length, 1);
  const surface = events[0].surface;
  assert.deepEqual(surface.buy, [{ amount: '100', total: '210', avgPrice: '2.1' }]);
  assert.deepEqual(surface.sell, [{ amount: '105', total: '200', avgPrice: '1.904761904761904' }]);
  handle.close();
});

test('xrpl surface stream: all-failed cycle emits error; socket drop emits closed', async () => {
  const events = [];
  const { ws } = openXrplSurface(events);
  ws.onopen();
  ws.respond(ws.sent[0].id, {});
  await drain();
  // buy create fails hard
  const buyReq = ws.sent[1];
  ws.onmessage({
    data: JSON.stringify({ id: buyReq.id, type: 'response', status: 'error', error: 'noPermission' }),
  });
  await drain();
  // sell create fails too
  const sellReq = ws.sent[2];
  ws.onmessage({
    data: JSON.stringify({ id: sellReq.id, type: 'response', status: 'error', error: 'noPermission' }),
  });
  await drain();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'error');
  assert.match(events[0].error.message, /noPermission/);

  ws.onclose(); // server drop
  assert.equal(events.at(-1).type, 'closed');
});

test('xrpl surface stream: rejects missing funded accounts', () => {
  const adapter = createXrplAdapter();
  assert.throws(
    () =>
      adapter.openSurfaceStream(
        { ...XRPL_REQ, fundedAccounts: { base: 'rXrpFunded', quote: null } },
        { sizes: ['1'], referencePrice: '1', fetch, webSocket: FakeWebSocket },
        () => {},
      ),
    /funded account for both the base and quote assets/,
  );
});

test('xrpl surface stream: rejects an issuer as its asset-funded account', () => {
  const adapter = createXrplAdapter();
  assert.throws(
    () =>
      adapter.openSurfaceStream(
        { ...XRPL_REQ, fundedAccounts: { base: XRP_FUNDED_ACCOUNT, quote: RLUSD_ISSUER } },
        { sizes: ['1'], referencePrice: '1', fetch, webSocket: FakeWebSocket },
        () => {},
      ),
    /quote funded account must not be the asset issuer/,
  );
});

/* ------------------------------------------------------- surface feed */

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

test('createQuoteSurfaceFeed: evm rejects with UnsupportedChainError', async () => {
  await assert.rejects(createQuoteSurfaceFeed({ ...STELLAR_REQ, chain: 'evm' }), (err) => {
    assert.ok(err instanceof UnsupportedChainError);
    assert.equal(err.code, 'UNSUPPORTED_CHAIN');
    return true;
  });
});
