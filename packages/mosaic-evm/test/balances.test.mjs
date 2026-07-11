import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBalancesFeed, fetchBalances } from '../dist/index.js';

const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ALICE = '0xAb5801a7D398351b8bE11C439e05C5b3259aeC9B';
const BOB = '0x00000000219ab540356cBB839Cbe05303d7705Fa';

const ETH = { symbol: 'ETH', kind: 'native' };
const USDC = { symbol: 'USDC', kind: 'issued', code: 'USDC', issuer: USDC_CONTRACT };

const REQ = {
  network: 'mainnet',
  addresses: [ALICE, BOB],
  assets: [ETH, USDC],
};

const DECIMALS_SELECTOR = '0x313ce567';
const BALANCE_OF_SELECTOR = '0x70a08231';
const word = (v) => '0x' + v.toString(16).padStart(64, '0');

/** Scripted batch JSON-RPC endpoint; answers out of id order on purpose. */
function makeRpc(script) {
  const batches = [];
  const fetchMock = async (url, init) => {
    const batch = JSON.parse(init.body);
    batches.push({ url: String(url), batch });
    const replies = batch.map((call) => ({ jsonrpc: '2.0', id: call.id, ...script(call) }));
    replies.reverse();
    return new Response(JSON.stringify(replies));
  };
  return { batches, fetchMock };
}

function defaultScript(call) {
  if (call.method === 'eth_getBalance') {
    // 1.5 ETH for alice, 2 wei for bob.
    return { result: call.params[0] === ALICE ? word(1_500_000_000_000_000_000n) : '0x2' };
  }
  assert.equal(call.method, 'eth_call');
  assert.equal(call.params[1], 'latest');
  assert.equal(call.params[0].to, USDC_CONTRACT);
  if (call.params[0].data === DECIMALS_SELECTOR) return { result: word(6n) };
  assert.equal(call.params[0].data.slice(0, 10), BALANCE_OF_SELECTOR);
  const holder = '0x' + call.params[0].data.slice(-40);
  return { result: holder === ALICE.toLowerCase() ? word(12_500_000n) : word(0n) };
}

test('single batch: native wei, balanceOf per token, decimals resolved and applied', async () => {
  const { batches, fetchMock } = makeRpc(defaultScript);
  const snapshot = await fetchBalances(REQ, { fetch: fetchMock, httpEndpoint: 'https://rpc.one' });

  assert.equal(batches.length, 1);
  assert.equal(batches[0].url, 'https://rpc.one');
  // decimals() + (getBalance + balanceOf) × 2 addresses
  assert.equal(batches[0].batch.length, 5);

  const [alice, bob] = snapshot.accounts;
  assert.equal(alice.funded, true);
  assert.deepEqual(alice.balances, [
    { asset: ETH, amount: '1.5' },
    { asset: USDC, amount: '12.5' },
  ]);
  assert.deepEqual(bob.balances, [
    { asset: ETH, amount: '0.000000000000000002' },
    { asset: USDC, amount: '0' },
  ]);
});

test('decimals() is fetched once per endpoint+contract across refreshes', async () => {
  const { batches, fetchMock } = makeRpc(defaultScript);
  const opts = { fetch: fetchMock, httpEndpoint: 'https://rpc.two' };
  await fetchBalances(REQ, opts);
  await fetchBalances(REQ, opts);

  const decimalsCalls = batches.flatMap(({ batch }) =>
    batch.filter((c) => c.method === 'eth_call' && c.params[0].data === DECIMALS_SELECTOR),
  );
  assert.equal(decimalsCalls.length, 1);
  assert.equal(batches[1].batch.length, 4); // second run: no decimals() call
});

test("decimals() returning '0x' (no contract) rejects and is not cached", async () => {
  let calls = 0;
  const { fetchMock } = makeRpc((call) => {
    if (call.params?.[0]?.data === DECIMALS_SELECTOR) {
      calls += 1;
      return { result: '0x' };
    }
    return defaultScript(call);
  });
  const opts = { fetch: fetchMock, httpEndpoint: 'https://rpc.three' };
  await assert.rejects(fetchBalances(REQ, opts), /did not report decimals/);
  await assert.rejects(fetchBalances(REQ, opts), /did not report decimals/);
  assert.equal(calls, 2); // the failure was not cached
});

test('per-call RPC errors and non-array bodies reject', async () => {
  const { fetchMock } = makeRpc((call) =>
    call.method === 'eth_getBalance' ? { error: { code: -32000, message: 'header not found' } } : defaultScript(call),
  );
  await assert.rejects(
    fetchBalances(REQ, { fetch: fetchMock, httpEndpoint: 'https://rpc.four' }),
    /header not found/,
  );
  await assert.rejects(
    fetchBalances(REQ, { fetch: async () => new Response('{}'), httpEndpoint: 'https://rpc.five' }),
    /unexpected batch response shape/,
  );
});

test('invalid addresses are rejected before any request', async () => {
  await assert.rejects(
    fetchBalances(
      { ...REQ, addresses: ['not-an-address'] },
      {
        fetch: async () => {
          throw new Error('must not fetch');
        },
        httpEndpoint: 'https://rpc.six',
      },
    ),
    /invalid EVM address/,
  );
});

test('dex factories throw UnsupportedChainError synchronously; balances feed constructs', async () => {
  const { createOrderBookFeed, createQuoteSurfaceFeed, UnsupportedChainError } = {
    ...(await import('../dist/index.js')),
    ...(await import('@mosaic/chain-core')),
  };
  const dexReq = { chain: 'evm', network: 'mainnet', base: { kind: 'native' }, quote: { kind: 'native' }, fundedAccounts: { base: null, quote: null } };
  for (const factory of [createOrderBookFeed, createQuoteSurfaceFeed]) {
    assert.throws(
      () => factory(dexReq),
      (err) => {
        assert.ok(err instanceof UnsupportedChainError);
        assert.equal(err.code, 'UNSUPPORTED_CHAIN');
        assert.equal(err.chain, 'evm');
        return true;
      },
    );
  }
  const feed = createBalancesFeed(REQ);
  assert.equal(feed.status, 'idle');
  assert.equal(feed.latest, null);
});
