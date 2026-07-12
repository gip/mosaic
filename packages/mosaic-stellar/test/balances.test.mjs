import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBalancesFeed, fetchBalances } from '../dist/index.js';

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

const XLM = { symbol: 'XLM', kind: 'native' };
const USDC = { symbol: 'USDC', kind: 'issued', code: 'USDC', issuer: USDC_ISSUER };

const REQ = {
  network: 'mainnet',
  addresses: ['GALICE', 'GBOB'],
  assets: [XLM, USDC],
};

test('happy path: parses native and credit balances, normalizes 7-dp strings', async () => {
  const calls = [];
  const fetchMock = async (url) => {
    const u = new URL(String(url));
    calls.push(u);
    if (u.pathname === '/accounts/GALICE') {
      return new Response(
        JSON.stringify({
          balances: [
            { balance: '0.0000001', liquidity_pool_id: 'abc', asset_type: 'liquidity_pool_shares' },
            {
              balance: '12.5000000',
              asset_type: 'credit_alphanum4',
              asset_code: 'USDC',
              asset_issuer: USDC_ISSUER,
            },
            // Same code, different issuer: must not match.
            {
              balance: '999.0000000',
              asset_type: 'credit_alphanum4',
              asset_code: 'USDC',
              asset_issuer: 'GEVIL',
            },
            { balance: '100.0000000', asset_type: 'native' },
          ],
        }),
      );
    }
    return new Response(JSON.stringify({ balances: [{ balance: '3.1400000', asset_type: 'native' }] }));
  };

  const snapshot = await fetchBalances(REQ, { fetch: fetchMock });

  assert.equal(calls[0].origin, 'https://horizon.stellar.org');
  const [alice, bob] = snapshot.accounts;
  assert.equal(alice.funded, true);
  assert.deepEqual(alice.balances, [
    { asset: XLM, amount: '100' },
    { asset: USDC, amount: '12.5' },
  ]);
  assert.deepEqual(bob.balances, [
    { asset: XLM, amount: '3.14' },
    { asset: USDC, amount: '0' },
  ]);
});

test('404 accounts report funded: false with zero balances', async () => {
  const fetchMock = async (url) => {
    if (String(url).includes('GALICE')) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify({ balances: [{ balance: '1.0000000', asset_type: 'native' }] }));
  };
  const snapshot = await fetchBalances(REQ, { fetch: fetchMock });
  const [alice, bob] = snapshot.accounts;
  assert.equal(alice.funded, false);
  assert.deepEqual(alice.balances, [
    { asset: XLM, amount: '0' },
    { asset: USDC, amount: '0' },
  ]);
  assert.equal(bob.funded, true);
});

test('non-404 Horizon errors and bad shapes reject the fetch', async () => {
  await assert.rejects(
    fetchBalances(REQ, { fetch: async () => new Response('oops', { status: 500 }) }),
    /Horizon responded 500/,
  );
  await assert.rejects(
    fetchBalances(REQ, { fetch: async () => new Response(JSON.stringify({ nope: true })) }),
    /unexpected response shape/,
  );
});

test('httpEndpoint override and testnet default', async () => {
  const calls = [];
  const fetchMock = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ balances: [] }));
  };
  await fetchBalances({ ...REQ, addresses: ['GALICE'] }, { fetch: fetchMock, httpEndpoint: 'https://my.horizon/' });
  assert.equal(calls[0], 'https://my.horizon/accounts/GALICE');
  await fetchBalances({ ...REQ, network: 'testnet', addresses: ['GALICE'] }, { fetch: fetchMock });
  assert.equal(calls[1], 'https://horizon-testnet.stellar.org/accounts/GALICE');
});

test('createBalancesFeed constructs synchronously without network I/O', () => {
  const feed = createBalancesFeed(REQ);
  assert.equal(feed.status, 'idle');
  assert.equal(feed.latest, null);
});
