import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter } from '../dist/index.js';

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

const REQ = {
  chain: 'stellar',
  network: 'mainnet',
  base: { kind: 'native' },
  quote: { kind: 'issued', code: 'USDC', issuer: USDC_ISSUER },
  fundedAccounts: { base: null, quote: null },
};

// Trimmed live capture of GET /order_book (XLM/USDC, July 2026).
const HORIZON_BOOK = {
  bids: [
    { price_r: { n: 370951, d: 2000000 }, price: '0.1854755', amount: '370.9456847' },
    { price_r: { n: 185469, d: 1000000 }, price: '0.1854690', amount: '523.0225800' },
  ],
  asks: [
    { price_r: { n: 18578729, d: 100000000 }, price: '0.1857873', amount: '7998.5705444' },
    { price_r: { n: 371609, d: 2000000 }, price: '0.1858045', amount: '2000.0000000' },
  ],
  base: { asset_type: 'native' },
  counter: { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER },
};

function jsonFetch(body, capture) {
  return async (url, init) => {
    capture?.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status: 200 });
  };
}

test('fetchOrderBook builds the Horizon URL and caps depth at Horizon\'s limit', async () => {
  const calls = [];
  const adapter = createAdapter();
  await adapter.fetchOrderBook(REQ, { depth: 500, fetch: jsonFetch(HORIZON_BOOK, calls) });
  const url = new URL(calls[0].url);
  assert.equal(url.origin, 'https://horizon.stellar.org');
  assert.equal(url.pathname, '/order_book');
  assert.equal(url.searchParams.get('selling_asset_type'), 'native');
  assert.equal(url.searchParams.get('buying_asset_type'), 'credit_alphanum4');
  assert.equal(url.searchParams.get('buying_asset_code'), 'USDC');
  assert.equal(url.searchParams.get('buying_asset_issuer'), USDC_ISSUER);
  assert.equal(url.searchParams.get('limit'), '200');
});

test('long asset codes map to credit_alphanum12; testnet and overrides apply', async () => {
  const calls = [];
  const adapter = createAdapter();
  const req = {
    ...REQ,
    network: 'testnet',
    quote: { kind: 'issued', code: 'YUSDC', issuer: USDC_ISSUER },
  };
  await adapter.fetchOrderBook(req, { depth: 5, fetch: jsonFetch(HORIZON_BOOK, calls) });
  let url = new URL(calls[0].url);
  assert.equal(url.origin, 'https://horizon-testnet.stellar.org');
  assert.equal(url.searchParams.get('buying_asset_type'), 'credit_alphanum12');
  assert.equal(url.searchParams.get('limit'), '5');

  await adapter.fetchOrderBook(req, {
    depth: 5,
    fetch: jsonFetch(HORIZON_BOOK, calls),
    httpEndpoint: 'https://horizon.example.com/',
  });
  url = new URL(calls[1].url);
  assert.equal(url.origin, 'https://horizon.example.com');
});

test('normalization: asks pass through, bids convert quote amount to base via price_r', async () => {
  const adapter = createAdapter();
  const snapshot = await adapter.fetchOrderBook(REQ, { depth: 20, fetch: jsonFetch(HORIZON_BOOK) });
  assert.deepEqual(snapshot.asks[0], { price: '0.1857873', amount: '7998.5705444' });
  // 370.9456847 USDC × 2000000/370951 = base (XLM) amount, exact rational math.
  assert.deepEqual(snapshot.bids[0], { price: '0.1854755', amount: '1999.971342306665839' });
  assert.deepEqual(snapshot.bids[1], { price: '0.1854690', amount: '2820' });
  assert.equal(snapshot.chain, 'stellar');
  assert.equal(snapshot.base.kind, 'native');
});

test('fetchOrderBook throws on non-2xx and bad shapes', async () => {
  const adapter = createAdapter();
  await assert.rejects(
    adapter.fetchOrderBook(REQ, { depth: 20, fetch: async () => new Response('nope', { status: 429 }) }),
    /Horizon responded 429/,
  );
  await assert.rejects(
    adapter.fetchOrderBook(REQ, { depth: 20, fetch: jsonFetch({ hello: true }) }),
    /unexpected response shape/,
  );
});

function sseFetch(chunks, capture) {
  const encoder = new TextEncoder();
  return async (url, init) => {
    capture?.push({ url: String(url), init });
    const body = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
      cancel() {},
    });
    return new Response(body, { status: 200 });
  };
}

test('openStream: parses SSE snapshots, skips hello, signals closed at stream end', async () => {
  const calls = [];
  const secondBook = { ...HORIZON_BOOK, asks: HORIZON_BOOK.asks.slice(0, 1) };
  const chunks = [
    'retry: 1000\nevent: open\ndata: "hello"\n\n',
    `data: ${JSON.stringify(HORIZON_BOOK)}\n`,
    `\ndata: ${JSON.stringify(secondBook)}\n\ndata: "byebye"\n\n`,
  ];
  const adapter = createAdapter();
  const events = [];
  const done = new Promise((resolve) => {
    adapter.openStream(REQ, { depth: 500, fetch: sseFetch(chunks, calls), webSocket: WebSocket }, (e) => {
      events.push(e);
      if (e.type === 'closed') resolve();
    });
  });
  await done;

  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('cursor'), 'now');
  assert.equal(url.searchParams.get('limit'), '200');
  assert.equal(calls[0].init.headers.accept, 'text/event-stream');
  assert.deepEqual(
    events.map((e) => e.type),
    ['snapshot', 'snapshot', 'closed'],
  );
  assert.equal(events[0].snapshot.asks.length, 2);
  assert.equal(events[1].snapshot.asks.length, 1);
  assert.deepEqual(events[0].snapshot.bids[0], { price: '0.1854755', amount: '1999.971342306665839' });
});

test('openStream: close() aborts silently, fetch failure emits error then closed', async () => {
  const adapter = createAdapter();

  // A stream that never ends until aborted; close() must produce no events.
  const events = [];
  const hangingFetch = async (_url, init) =>
    new Response(
      new ReadableStream({
        start(controller) {
          init.signal.addEventListener('abort', () => controller.error(init.signal.reason));
        },
      }),
      { status: 200 },
    );
  const handle = adapter.openStream(REQ, { depth: 20, fetch: hangingFetch, webSocket: WebSocket }, (e) =>
    events.push(e),
  );
  await new Promise((r) => setTimeout(r, 10));
  handle.close();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(events, []);

  // A failing fetch reports error + closed so the feed can reconnect.
  const failEvents = [];
  const done = new Promise((resolve) => {
    adapter.openStream(
      REQ,
      { depth: 20, fetch: async () => new Response('down', { status: 503 }), webSocket: WebSocket },
      (e) => {
        failEvents.push(e);
        if (e.type === 'closed') resolve();
      },
    );
  });
  await done;
  assert.deepEqual(
    failEvents.map((e) => e.type),
    ['error', 'closed'],
  );
  assert.match(failEvents[0].error.message, /Horizon responded 503/);
});
