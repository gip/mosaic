import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_ASSETS, BUILTIN_CHAINS, defaultCatalogSnapshot } from '../dist/index.js';

test('built-in chain and asset IDs and deployments are unique', () => {
  assert.equal(BUILTIN_CHAINS.length, 6);
  assert.equal(BUILTIN_ASSETS.length, 5);
  assert.equal(new Set(BUILTIN_CHAINS.map(({ id }) => id)).size, BUILTIN_CHAINS.length);
  // Each chainKey groups exactly one chain per network.
  for (const { chainKey } of BUILTIN_CHAINS) {
    const group = BUILTIN_CHAINS.filter((chain) => chain.chainKey === chainKey);
    assert.equal(new Set(group.map(({ network }) => network)).size, group.length);
    assert.ok(group.every(({ family }) => family === group[0].family));
  }
  assert.equal(new Set(BUILTIN_ASSETS.map(({ id }) => id)).size, BUILTIN_ASSETS.length);
  for (const asset of BUILTIN_ASSETS) {
    assert.equal(new Set(asset.deployments.map(({ chainId }) => chainId)).size, asset.deployments.length);
    for (const deployment of asset.deployments) {
      assert.ok(BUILTIN_CHAINS.some(({ id }) => id === deployment.chainId));
      assert.equal(deployment.kind === 'issued', typeof deployment.address === 'string');
    }
  }
});

test('official stablecoin deployment addresses are pinned', () => {
  const usdc = BUILTIN_ASSETS.find(({ id }) => id === 'usdc');
  const rlusd = BUILTIN_ASSETS.find(({ id }) => id === 'rlusd');
  assert.equal(usdc.deployments.find(({ chainId }) => chainId === 'base-mainnet').address, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  assert.equal(usdc.deployments.find(({ chainId }) => chainId === 'xrpl-testnet').address, 'rHuGNhqTG32mfmAvWA8hUyWRLV3tCSwKQt');
  assert.equal(rlusd.deployments.find(({ chainId }) => chainId === 'xrpl-testnet').address, 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV');
  assert.deepEqual(rlusd.deployments.map(({ chainId }) => chainId), ['xrpl-mainnet', 'xrpl-testnet']);
});

test('anonymous defaults enable every built-in chain and allow every asset', () => {
  const catalog = defaultCatalogSnapshot();
  assert.ok(catalog.chains.every(({ enabled }) => enabled));
  assert.ok(catalog.assets.every(({ trustState }) => trustState === 'allowed'));
});
