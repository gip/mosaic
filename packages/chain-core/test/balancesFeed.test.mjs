import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PollingBalancesFeed } from '../dist/index.js';

const XRP = { symbol: 'XRP', kind: 'native' };
const RLUSD = { symbol: 'RLUSD', kind: 'issued', code: 'RLUSD', issuer: 'rMxCK' };

const REQ = {
  network: 'testnet',
  addresses: ['rAlice', 'rBob'],
  assets: [XRP, RLUSD],
};

function makeSnapshot(tag) {
  return {
    network: REQ.network,
    accounts: REQ.addresses.map((address) => ({
      address,
      funded: true,
      balances: [
        { asset: XRP, amount: tag },
        { asset: RLUSD, amount: '0' },
      ],
    })),
    timestamp: Date.now(),
  };
}

const drain = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

test('polls on interval: connecting → live, snapshots tracked in latest', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const fetcher = async (req, opts) => {
    calls.push(opts);
    return makeSnapshot(String(calls.length));
  };
  const feed = new PollingBalancesFeed(fetcher, REQ, { intervalMs: 10_000 });
  const events = [];
  feed.subscribe((e) => events.push(e));

  assert.equal(feed.status, 'idle');
  feed.start();
  feed.start(); // idempotent
  assert.equal(feed.status, 'connecting');
  await drain();
  assert.equal(feed.status, 'live');
  assert.equal(calls.length, 1);
  assert.equal(feed.latest.accounts[0].balances[0].amount, '1');

  t.mock.timers.tick(10_000);
  await drain();
  assert.equal(calls.length, 2);
  assert.equal(feed.latest.accounts[0].balances[0].amount, '2');
  assert.deepEqual(
    events.map((e) => e.type),
    ['status', 'status', 'balances', 'balances'],
  );
});

test('failed poll keeps latest, reports reconnecting, backs off, recovers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let failNext = false;
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    if (failNext) {
      failNext = false;
      throw new Error('rpc down');
    }
    return makeSnapshot(String(calls));
  };
  const feed = new PollingBalancesFeed(fetcher, REQ, { intervalMs: 10_000 });
  const events = [];
  feed.subscribe((e) => events.push(e));
  feed.start();
  await drain();
  assert.equal(feed.status, 'live');

  failNext = true;
  t.mock.timers.tick(10_000);
  await drain();
  assert.equal(feed.status, 'reconnecting');
  assert.equal(events.filter((e) => e.type === 'error').length, 1);
  assert.equal(feed.latest.accounts[0].balances[0].amount, '1'); // last good survives

  // backoff retry after 1s, then success
  t.mock.timers.tick(1_000);
  await drain();
  assert.equal(feed.status, 'live');
  assert.equal(calls, 3);
});

test('stop() cancels polling, aborts in-flight fetch, ignores stale results', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal = null;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const fetcher = async (_req, opts) => {
    signal = opts.signal;
    await gate;
    return makeSnapshot('late');
  };
  const feed = new PollingBalancesFeed(fetcher, REQ);
  const events = [];
  feed.subscribe((e) => events.push(e));
  feed.start();
  await drain();

  feed.stop();
  assert.equal(feed.status, 'idle');
  assert.equal(signal.aborted, true);

  release();
  await drain();
  t.mock.timers.tick(120_000);
  await drain();
  assert.equal(feed.latest, null); // stale result dropped
  assert.equal(events.filter((e) => e.type === 'balances').length, 0);
});

test('refresh() works without polling and emits the snapshot', async () => {
  const fetcher = async () => makeSnapshot('once');
  const feed = new PollingBalancesFeed(fetcher, REQ);
  const events = [];
  feed.subscribe((e) => events.push(e));

  const snapshot = await feed.refresh();
  assert.equal(snapshot.accounts[1].address, 'rBob');
  assert.equal(feed.latest, snapshot);
  assert.deepEqual(
    events.map((e) => e.type),
    ['balances'],
  );
  assert.equal(feed.status, 'idle');
});

test('throwing listeners are isolated', async () => {
  const fetcher = async () => makeSnapshot('x');
  const feed = new PollingBalancesFeed(fetcher, REQ);
  const seen = [];
  feed.subscribe(() => {
    throw new Error('bad listener');
  });
  const unsubscribe = feed.subscribe((e) => seen.push(e));
  await feed.refresh();
  assert.equal(seen.filter((e) => e.type === 'balances').length, 1);
  unsubscribe();
  await feed.refresh();
  assert.equal(seen.filter((e) => e.type === 'balances').length, 1);
});
