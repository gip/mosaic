import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, Wallet } from 'xrpl';
import {
  createAdapter,
  normalizeCurrency,
  normalizeXrplAssetAmount,
  prepareXrplCancel,
  prepareXrplOrder,
  submitXrplTransaction,
  toXrplAmountSpec,
} from '../dist/index.js';

const ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
const RLUSD_HEX = `524C555344${'0'.repeat(30)}`;

const REQ = {
  chain: 'xrpl',
  network: 'mainnet',
  base: { kind: 'native' },
  quote: { kind: 'issued', code: 'RLUSD', issuer: ISSUER },
  fundedAccounts: { base: 'rXrpFunded', quote: 'rRlusdFunded' },
};

test('limit orders map sell to exact-spend tfSell and buy to exact-receive', async () => {
  const prepared = [];
  const clientFactory = () => ({
    connect: async () => {},
    disconnect: async () => {},
    autofill: async (transaction) => {
      const result = { ...transaction, Sequence: 7, Fee: '12', LastLedgerSequence: 99 };
      prepared.push(result);
      return result;
    },
  });
  const intent = {
    chain: 'xrpl', network: 'testnet', sourceAddress: 'rSource', sourceKind: 'vault', side: 'sell',
    base: { kind: 'native' }, quote: { kind: 'issued', code: 'RLUSD', issuer: ISSUER },
    baseSymbol: 'XRP', quoteSymbol: 'RLUSD', amount: '2.5', limitPrice: '3',
  };
  await prepareXrplOrder(intent, '7.5', 1234, clientFactory);
  await prepareXrplOrder({ ...intent, side: 'buy' }, '7.5', 1234, clientFactory);
  assert.deepEqual(prepared[0].TakerGets, '2500000');
  assert.deepEqual(prepared[0].TakerPays, { currency: RLUSD_HEX, issuer: ISSUER, value: '7.5' });
  assert.equal(prepared[0].Flags, 0x00080000);
  assert.equal(prepared[0].SourceTag, 1234);
  assert.deepEqual(prepared[1].TakerGets, { currency: RLUSD_HEX, issuer: ISSUER, value: '7.5' });
  assert.deepEqual(prepared[1].TakerPays, '2500000');
  assert.equal(prepared[1].Flags, 0);
  assert.equal(prepared[1].SourceTag, 1234);
  assert.doesNotThrow(() => encode({ ...prepared[0], Account: ISSUER, SigningPubKey: '' }));

  const issued = { kind: 'issued', code: 'USD', issuer: 'rUsdIssuer' };
  await prepareXrplOrder({ ...intent, base: issued, baseSymbol: 'USD' }, '7.5', 1234, clientFactory);
  assert.deepEqual(prepared[2].TakerGets, { currency: 'USD', issuer: 'rUsdIssuer', value: '2.5' });

  await prepareXrplCancel('testnet', intent.sourceAddress, 7, 1234, clientFactory);
  assert.equal(prepared[3].TransactionType, 'OfferCancel');
  assert.equal(prepared[3].SourceTag, 1234);
});

test('XRPL order amounts are quantized before Xaman payload encoding', async () => {
  const transactions = [];
  const clientFactory = () => ({
    connect: async () => {},
    disconnect: async () => {},
    autofill: async (transaction) => {
      const prepared = { ...transaction, Sequence: 8, Fee: '12', LastLedgerSequence: 100 };
      transactions.push(prepared);
      return prepared;
    },
  });
  const intent = {
    chain: 'xrpl', network: 'testnet', sourceAddress: ISSUER, sourceKind: 'root', side: 'sell',
    base: { kind: 'native' }, quote: { kind: 'issued', code: 'RLUSD', issuer: ISSUER },
    baseSymbol: 'XRP', quoteSymbol: 'RLUSD', amount: '1.23456789', limitPrice: '1',
  };

  await prepareXrplOrder(intent, '0.123456789012345678901', 0, clientFactory);
  await prepareXrplOrder({ ...intent, side: 'buy' }, '0.123456789012345678901', 0, clientFactory);

  assert.equal(transactions[0].TakerGets, '1234567');
  assert.equal(transactions[0].TakerPays.value, '0.1234567890123457');
  assert.equal(transactions[1].TakerGets.value, '0.1234567890123456');
  assert.doesNotThrow(() => encode({ ...transactions[0], SigningPubKey: '' }));
  assert.doesNotThrow(() => encode({ ...transactions[1], SigningPubKey: '' }));
  assert.equal(normalizeXrplAssetAmount({ kind: 'native' }, '0.0000001', 'ceil'), '0.000001');
  assert.throws(() => normalizeXrplAssetAmount({ kind: 'native' }, '0.0000001'), /positive decimal/);
});

test('submission rejects missing or changed SourceTag before connecting', async () => {
  const wallet = Wallet.generate();
  const transaction = {
    TransactionType: 'OfferCancel', Account: wallet.address, OfferSequence: 1,
    Fee: '12', Sequence: 1, LastLedgerSequence: 100,
  };
  const untagged = wallet.sign(transaction).tx_blob;
  const wrongTag = wallet.sign({ ...transaction, SourceTag: 8 }).tx_blob;
  const tagged = wallet.sign({ ...transaction, SourceTag: 7 }).tx_blob;
  let connections = 0;
  const clientFactory = () => ({
    connect: async () => { connections += 1; },
    disconnect: async () => {},
    submitAndWait: async () => ({
      result: { hash: 'ABC', ledger_index: 99, meta: { TransactionResult: 'tesSUCCESS' } },
    }),
  });

  await assert.rejects(() => submitXrplTransaction('testnet', untagged, 7, clientFactory), /SourceTag/);
  await assert.rejects(() => submitXrplTransaction('testnet', wrongTag, 7, clientFactory), /SourceTag/);
  assert.equal(connections, 0);
  assert.deepEqual(await submitXrplTransaction('testnet', tagged, 7, clientFactory), {
    hash: 'ABC', ledger: '99', resultCode: 'tesSUCCESS',
  });
  assert.equal(connections, 1);
});

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
const ROUNDING_DUST_BID = {
  TakerGets: { currency: RLUSD_HEX, issuer: ISSUER, value: '28914.641897' },
  TakerPays: '28914641897',
  taker_gets_funded: { currency: RLUSD_HEX, issuer: ISSUER, value: '0.00000133549997' },
  taker_pays_funded: '1',
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
    { price: '11.111', amount: '500' },
  ]);
  assert.deepEqual(snapshot.bids, [{ price: '2.1', amount: '1000' }]);
});

test('normalization: funded rounding changes size, never the original offer price', async () => {
  const adapter = createAdapter();
  const snapshot = await adapter.fetchOrderBook(REQ, {
    depth: 20,
    httpEndpoint: 'https://rpc.example.com',
    fetch: async (_url, init) => {
      const params = JSON.parse(init.body).params[0];
      const offers = params.taker_gets.currency === 'XRP' ? [] : [ROUNDING_DUST_BID];
      return new Response(JSON.stringify({ result: { status: 'success', offers } }));
    },
  });

  // Dividing the independently rounded funded fields would incorrectly
  // produce 1.33549997 and turn this one-drop dust offer into the best bid.
  assert.deepEqual(snapshot.bids, [{ price: '1', amount: '0.000001' }]);
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

test('openStream: subscribes for changes, then fetches a funded snapshot pinned to one ledger', async () => {
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
      both: true,
    },
  ]);

  // Raw subscription snapshots can include unfunded offers, so the adapter
  // ignores them and sources displayed data from book_offers instead.
  ws.reply(sub.id, { asks: [BID_OFFER], bids: [ASK_OFFER] });
  await drain();
  const askReq = ws.sent[1];
  assert.equal(askReq.command, 'book_offers');
  assert.equal(askReq.ledger_index, 'validated');
  ws.reply(askReq.id, { ledger_index: 123, offers: [ASK_OFFER, FUNDED_ASK] });
  await drain();
  const bidReq = ws.sent[2];
  assert.equal(bidReq.command, 'book_offers');
  assert.equal(bidReq.ledger_index, 123);
  ws.reply(bidReq.id, { ledger_index: 123, offers: [BID_OFFER] });
  await drain();

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'snapshot');
  assert.deepEqual(events[0].snapshot.asks, [
    { price: '2.2', amount: '2000' },
    { price: '11.111', amount: '500' },
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
  ws.reply(ws.sent[0].id, {});
  await drain();
  ws.reply(ws.sent[1].id, { ledger_index: 123, offers: [] });
  await drain();
  ws.reply(ws.sent[2].id, { ledger_index: 123, offers: [] });
  await drain();
  assert.equal(events.length, 1);

  // A burst of transactions in one ledger → a single refetch pair.
  for (let i = 0; i < 3; i++) ws.onmessage({ data: JSON.stringify({ type: 'transaction' }) });
  assert.equal(ws.sent.length, 3);
  t.mock.timers.tick(300);
  assert.equal(ws.sent.length, 4);
  const askReq = ws.sent[3];
  assert.equal(askReq.command, 'book_offers');
  assert.deepEqual(askReq.taker_gets, { currency: 'XRP' });
  ws.reply(askReq.id, { status: 'success', ledger_index: 124, offers: [ASK_OFFER] });
  await drain();
  const bidReq = ws.sent[4];
  assert.deepEqual(bidReq.taker_gets, { currency: RLUSD_HEX, issuer: ISSUER });
  assert.equal(bidReq.ledger_index, 124);
  ws.reply(bidReq.id, { status: 'success', ledger_index: 124, offers: [BID_OFFER] });
  await drain();
  assert.equal(events.length, 2);
  assert.deepEqual(events[1].snapshot.asks, [{ price: '2.2', amount: '2000' }]);
  assert.deepEqual(events[1].snapshot.bids, [{ price: '2.1', amount: '1000' }]);

  // Quiet period → no further requests.
  t.mock.timers.tick(10_000);
  assert.equal(ws.sent.length, 5);
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
