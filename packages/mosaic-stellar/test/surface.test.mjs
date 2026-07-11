import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter, createOrderBookFeed } from '../dist/index.js';

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

const STELLAR_REQ = {
  chain: 'stellar',
  network: 'mainnet',
  base: { kind: 'native' },
  quote: { kind: 'issued', code: 'USDC', issuer: USDC_ISSUER },
  fundedAccounts: { base: null, quote: null },
};

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

  const adapter = createAdapter();
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

test('createOrderBookFeed constructs synchronously without network I/O', () => {
  const feed = createOrderBookFeed(STELLAR_REQ);
  assert.equal(feed.status, 'idle');
  assert.equal(feed.latest, null);
});
