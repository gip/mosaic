import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter, normalizeCurrency, toXrplAmountSpec } from '../dist/xrpl/index.js';

const ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
const RLUSD_HEX = `524C555344${'0'.repeat(30)}`;

const REQ = {
  chain: 'xrpl',
  network: 'mainnet',
  base: { kind: 'native' },
  quote: { kind: 'issued', code: 'RLUSD', issuer: ISSUER },
};

// Offers giving base (XRP) for quote → asks; the reverse → bids.
const ASK_OFFER = {
  TakerGets: '2000000000',
  TakerPays: { currency: RLUSD_HEX, issuer: ISSUER, value: '4400' },
};
const BID_OFFER = {
  TakerGets: { currency: RLUSD_HEX, issuer: ISSUER, value: '2100' },
  TakerPays: '1000000000',
};
const FUNDED_ASK = {
  TakerGets: '9000000000',
  TakerPays: { currency: RLUSD_HEX, issuer: ISSUER, value: '99999' },
  taker_gets_funded: '500000000',
  taker_pays_funded: { currency: RLUSD_HEX, issuer: ISSUER, value: '1150' },
};
const EMPTY_OFFER = {
  TakerGets: '123456',
  TakerPays: { currency: RLUSD_HEX, issuer: ISSUER, value: '1' },
  taker_gets_funded: '0',
  taker_pays_funded: { currency: RLUSD_HEX, issuer: ISSUER, value: '0' },
};

const drain = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

test('normalizeCurrency: ASCII, hex, and long codes', () => {
  assert.equal(normalizeCurrency('USD'), 'USD');
  assert.equal(normalizeCurrency('RLUSD'), RLUSD_HEX);
  assert.equal(normalizeCurrency(RLUSD_HEX.toLowerCase()), RLUSD_HEX);
  assert.throws(() => normalizeCurrency('XRP'), /cannot use the currency code 'XRP'/);
  assert.throws(() => normalizeCurrency('xrp'), /cannot use the currency code 'XRP'/);
  assert.throws(() => normalizeCurrency(''));
  assert.deepEqual(toXrplAmountSpec({ kind: 'native' }), { currency: 'XRP' });
  assert.deepEqual(toXrplAmountSpec(REQ.quote), { currency: RLUSD_HEX, issuer: ISSUER });
});

test('fetchOrderBook: two swapped book_offers calls, normalized + sorted', async () => {
  const calls = [];
  const fetchMock = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    const params = body.params[0];
    const offers =
      params.taker_gets.currency === 'XRP' ? [FUNDED_ASK, ASK_OFFER, EMPTY_OFFER] : [BID_OFFER];
    return new Response(JSON.stringify({ result: { status: 'success', offers } }));
  };

  const adapter = createAdapter();
  const snapshot = await adapter.fetchOrderBook(REQ, {
    depth: 20,
    fetch: fetchMock,
    httpEndpoint: 'https://xrplcluster.com',
  });

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, 'https://xrplcluster.com');
    assert.equal(call.body.method, 'book_offers');
    assert.equal(call.body.params[0].ledger_index, 'validated');
    assert.equal(call.body.params[0].limit, 20);
  }
  const directions = calls.map((c) => c.body.params[0]);
  assert.deepEqual(directions[0].taker_gets, { currency: 'XRP' });
  assert.deepEqual(directions[0].taker_pays, { currency: RLUSD_HEX, issuer: ISSUER });
  assert.deepEqual(directions[1].taker_gets, { currency: RLUSD_HEX, issuer: ISSUER });
  assert.deepEqual(directions[1].taker_pays, { currency: 'XRP' });

  // Funded amounts win, zero-funded offers are dropped, asks sorted ascending.
  assert.deepEqual(snapshot.asks, [
    { price: '2.2', amount: '2000' },
    { price: '2.3', amount: '500' },
  ]);
  assert.deepEqual(snapshot.bids, [{ price: '2.1', amount: '1000' }]);
});

test('fetchOrderBook: HTTP endpoint override and RPC errors', async () => {
  const calls = [];
  const okFetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ result: { status: 'success', offers: [] } }));
  };
  const adapter = createAdapter();
  await adapter.fetchOrderBook(REQ, { depth: 5, fetch: okFetch, httpEndpoint: 'https://rpc.example.com' });
  assert.equal(calls[0], 'https://rpc.example.com');

  await assert.rejects(
    adapter.fetchOrderBook(REQ, {
      depth: 5,
      httpEndpoint: 'https://rpc.example.com',
      fetch: async () =>
        new Response(
          JSON.stringify({ result: { status: 'error', error: 'invalidParams', error_message: 'bad taker' } }),
        ),
    }),
    /XRPL request failed: bad taker/,
  );
});

test('fetchOrderBook: defaults to an ephemeral WebSocket (browser-safe, no CORS)', async () => {
  FakeWebSocket.instances = [];
  const adapter = createAdapter();
  const promise = adapter.fetchOrderBook(
    { ...REQ, network: 'testnet' },
    {
      depth: 5,
      fetch: async () => {
        throw new Error('HTTP must not be used by default');
      },
      webSocket: FakeWebSocket,
    },
  );
  await drain();
  const ws = FakeWebSocket.instances[0];
  assert.equal(ws.url, 'wss://s.altnet.rippletest.net:51233');
  ws.onopen();
  assert.equal(ws.sent.length, 2);
  assert.equal(ws.sent[0].command, 'book_offers');
  assert.deepEqual(ws.sent[0].taker_gets, { currency: 'XRP' });
  assert.deepEqual(ws.sent[1].taker_gets, { currency: RLUSD_HEX, issuer: ISSUER });
  ws.reply(ws.sent[0].id, { offers: [ASK_OFFER] });
  ws.reply(ws.sent[1].id, { offers: [BID_OFFER] });
  const snapshot = await promise;
  assert.equal(ws.closed, true);
  assert.deepEqual(snapshot.asks, [{ price: '2.2', amount: '2000' }]);
  assert.deepEqual(snapshot.bids, [{ price: '2.1', amount: '1000' }]);
});

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
  reply(id, result) {
    this.onmessage?.({ data: JSON.stringify({ id, status: 'success', type: 'response', result }) });
  }
}

function openFakeStream(events) {
  FakeWebSocket.instances = [];
  const adapter = createAdapter();
  const handle = adapter.openStream(
    REQ,
    {
      depth: 20,
      fetch: async () => {
        throw new Error('HTTP must not be used by the stream');
      },
      webSocket: FakeWebSocket,
    },
    (e) => events.push(e),
  );
  return { handle, ws: FakeWebSocket.instances[0] };
}

test('openStream: subscribes with snapshot+both, classifies offers ignoring rippled labels', async () => {
  const events = [];
  const { handle, ws } = openFakeStream(events);
  assert.equal(ws.url, 'wss://xrplcluster.com');

  ws.onopen();
  assert.equal(ws.sent.length, 1);
  const sub = ws.sent[0];
  assert.equal(sub.command, 'subscribe');
  assert.deepEqual(sub.books, [
    {
      taker_gets: { currency: 'XRP' },
      taker_pays: { currency: RLUSD_HEX, issuer: ISSUER },
      snapshot: true,
      both: true,
    },
  ]);

  // rippled's asks/bids labels are inverted relative to the request; the
  // adapter must orient offers by their TakerGets side, not by the label.
  ws.reply(sub.id, { asks: [BID_OFFER], bids: [ASK_OFFER, FUNDED_ASK] });
  await drain();

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'snapshot');
  assert.deepEqual(events[0].snapshot.asks, [
    { price: '2.2', amount: '2000' },
    { price: '2.3', amount: '500' },
  ]);
  assert.deepEqual(events[0].snapshot.bids, [{ price: '2.1', amount: '1000' }]);

  handle.close();
  assert.equal(ws.closed, true);
  // Deliberate close emits nothing further.
  assert.equal(events.length, 1);
});

test('openStream: transaction events coalesce into one debounced book_offers refetch', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  const { ws } = openFakeStream(events);
  ws.onopen();
  ws.reply(ws.sent[0].id, { asks: [], bids: [] });
  await drain();
  assert.equal(events.length, 1);

  // A burst of transactions in one ledger → a single refetch pair.
  for (let i = 0; i < 3; i++) ws.onmessage({ data: JSON.stringify({ type: 'transaction' }) });
  assert.equal(ws.sent.length, 1);
  t.mock.timers.tick(300);
  assert.equal(ws.sent.length, 3);
  const [askReq, bidReq] = ws.sent.slice(1);
  assert.equal(askReq.command, 'book_offers');
  assert.deepEqual(askReq.taker_gets, { currency: 'XRP' });
  assert.deepEqual(bidReq.taker_gets, { currency: RLUSD_HEX, issuer: ISSUER });

  ws.reply(askReq.id, { status: 'success', offers: [ASK_OFFER] });
  ws.reply(bidReq.id, { status: 'success', offers: [BID_OFFER] });
  await drain();
  assert.equal(events.length, 2);
  assert.deepEqual(events[1].snapshot.asks, [{ price: '2.2', amount: '2000' }]);
  assert.deepEqual(events[1].snapshot.bids, [{ price: '2.1', amount: '1000' }]);

  // Quiet period → no further requests.
  t.mock.timers.tick(10_000);
  assert.equal(ws.sent.length, 3);
});

test('openStream: unexpected socket close emits closed for the feed to reconnect', async () => {
  const events = [];
  const { ws } = openFakeStream(events);
  ws.onopen();
  ws.onclose(); // server drop, not handle.close()
  assert.deepEqual(
    events.map((e) => e.type),
    ['closed'],
  );
});

test('openStream: invalid issued code throws synchronously', () => {
  const adapter = createAdapter();
  assert.throws(
    () =>
      adapter.openStream(
        { ...REQ, quote: { kind: 'issued', code: 'XRP', issuer: ISSUER } },
        { depth: 20, fetch: async () => new Response('{}'), webSocket: FakeWebSocket },
        () => {},
      ),
    /cannot use the currency code 'XRP'/,
  );
});
