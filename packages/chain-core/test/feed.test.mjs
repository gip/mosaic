import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamingFeed } from '../dist/index.js';

const REQ = {
  chain: 'stellar',
  network: 'mainnet',
  base: { kind: 'native' },
  quote: { kind: 'issued', code: 'USDC', issuer: 'GA5Z' },
  fundedAccounts: { base: null, quote: null },
};

function makeSnapshot(tag) {
  return {
    ...REQ,
    bids: [{ price: '1', amount: tag }],
    asks: [{ price: '2', amount: tag }],
    timestamp: Date.now(),
  };
}

function makeFakeAdapter() {
  const streams = [];
  const fetchOptions = [];
  const adapter = {
    async fetchOrderBook(_req, opts) {
      fetchOptions.push(opts);
      return makeSnapshot('refresh');
    },
    openStream(_req, opts, emit) {
      const stream = { emit, opts, closed: false };
      streams.push(stream);
      return {
        close() {
          stream.closed = true;
        },
      };
    },
  };
  return { adapter, streams, fetchOptions };
}

test('uses a default retrieval depth of 500 offers per side', async () => {
  const { adapter, streams, fetchOptions } = makeFakeAdapter();
  const feed = new StreamingFeed(adapter, REQ);

  feed.start();
  assert.equal(streams[0].opts.depth, 500);

  await feed.refresh();
  assert.equal(fetchOptions[0].depth, 500);
  feed.stop();
});

test('start(): connecting → live on first snapshot; latest tracks snapshots', () => {
  const { adapter, streams } = makeFakeAdapter();
  const feed = new StreamingFeed(adapter, REQ);
  const events = [];
  feed.subscribe((e) => events.push(e));

  assert.equal(feed.status, 'idle');
  feed.start();
  feed.start(); // idempotent
  assert.equal(streams.length, 1);
  assert.equal(feed.status, 'connecting');

  streams[0].emit({ type: 'snapshot', snapshot: makeSnapshot('a') });
  assert.equal(feed.status, 'live');
  assert.equal(feed.latest.bids[0].amount, 'a');
  assert.deepEqual(
    events.map((e) => e.type),
    ['status', 'status', 'snapshot'],
  );
});

test('stream close → reconnecting with exponential backoff, reset on snapshot', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { adapter, streams } = makeFakeAdapter();
  const feed = new StreamingFeed(adapter, REQ);
  feed.start();

  streams[0].emit({ type: 'closed' });
  assert.equal(feed.status, 'reconnecting');
  assert.equal(streams[0].closed, true);
  assert.equal(streams.length, 1);
  t.mock.timers.tick(1_000);
  assert.equal(streams.length, 2);

  // Second failure: backoff doubled to 2s.
  streams[1].emit({ type: 'closed' });
  t.mock.timers.tick(1_000);
  assert.equal(streams.length, 2);
  t.mock.timers.tick(1_000);
  assert.equal(streams.length, 3);

  // A snapshot resets the backoff to 1s.
  streams[2].emit({ type: 'snapshot', snapshot: makeSnapshot('b') });
  assert.equal(feed.status, 'live');
  streams[2].emit({ type: 'closed' });
  t.mock.timers.tick(1_000);
  assert.equal(streams.length, 4);

  // latest survives the drops.
  assert.equal(feed.latest.bids[0].amount, 'b');
});

test('stop() closes the stream, cancels reconnect, ignores stale events', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { adapter, streams } = makeFakeAdapter();
  const feed = new StreamingFeed(adapter, REQ);
  const events = [];
  feed.subscribe((e) => events.push(e));

  feed.start();
  streams[0].emit({ type: 'closed' });
  feed.stop();
  assert.equal(feed.status, 'idle');
  t.mock.timers.tick(120_000);
  assert.equal(streams.length, 1);

  // Events from the abandoned stream are dropped.
  const before = events.length;
  streams[0].emit({ type: 'snapshot', snapshot: makeSnapshot('stale') });
  assert.equal(events.length, before);
  assert.equal(feed.latest, null);
});

test('stream errors surface as events without breaking the stream', () => {
  const { adapter, streams } = makeFakeAdapter();
  const feed = new StreamingFeed(adapter, REQ);
  const events = [];
  feed.subscribe((e) => events.push(e));
  feed.start();

  streams[0].emit({ type: 'error', error: new Error('transient') });
  assert.equal(events.at(-1).type, 'error');
  assert.equal(feed.status, 'connecting');
  streams[0].emit({ type: 'snapshot', snapshot: makeSnapshot('after-error') });
  assert.equal(feed.status, 'live');
});

test('unsubscribe stops delivery; throwing listeners are isolated', () => {
  const { adapter, streams } = makeFakeAdapter();
  const feed = new StreamingFeed(adapter, REQ);
  const seen = [];
  feed.subscribe(() => {
    throw new Error('bad listener');
  });
  const unsubscribe = feed.subscribe((e) => seen.push(e));
  feed.start();
  streams[0].emit({ type: 'snapshot', snapshot: makeSnapshot('x') });
  assert.equal(seen.filter((e) => e.type === 'snapshot').length, 1);

  unsubscribe();
  streams[0].emit({ type: 'snapshot', snapshot: makeSnapshot('y') });
  assert.equal(seen.filter((e) => e.type === 'snapshot').length, 1);
});

test('refresh() works without streaming and emits the snapshot', async () => {
  const { adapter } = makeFakeAdapter();
  const feed = new StreamingFeed(adapter, REQ);
  const events = [];
  feed.subscribe((e) => events.push(e));

  const snapshot = await feed.refresh();
  assert.equal(snapshot.bids[0].amount, 'refresh');
  assert.equal(feed.latest, snapshot);
  assert.deepEqual(
    events.map((e) => e.type),
    ['snapshot'],
  );
  assert.equal(feed.status, 'idle');
});

test('a synchronously-throwing adapter stops the feed with an error event', () => {
  const adapter = {
    async fetchOrderBook() {
      throw new Error('unused');
    },
    openStream() {
      throw new Error('bad asset spec');
    },
  };
  const feed = new StreamingFeed(adapter, REQ);
  const events = [];
  feed.subscribe((e) => events.push(e));
  feed.start();
  assert.equal(feed.status, 'idle');
  assert.deepEqual(
    events.map((e) => e.type),
    ['status', 'error', 'status'],
  );
  assert.match(events[1].error.message, /bad asset spec/);
});
