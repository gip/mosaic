import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter, createOrderBookFeed } from '../dist/index.js';

const RLUSD_ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
const RLUSD_HEX = `524C555344${'0'.repeat(30)}`;
const XRP_FUNDED_ACCOUNT = 'rXrpFunded';
const RLUSD_FUNDED_ACCOUNT = 'rRlusdFunded';

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
  const adapter = createAdapter();
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
  const adapter = createAdapter();
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
  const adapter = createAdapter();
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

test('createOrderBookFeed constructs synchronously without network I/O', () => {
  const feed = createOrderBookFeed(XRPL_REQ);
  assert.equal(feed.status, 'idle');
  assert.equal(feed.latest, null);
  assert.equal(feed.request.chain, 'xrpl');
});
