import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { privateKeyToAccount } from 'viem/accounts';
import { deriveKeypair, deriveAddress, generateSeed, sign as rippleSign } from 'ripple-keypairs';
import {
  eip712TypedData,
  stellarAddressFromPublicKey,
  backupWrapMessage,
  zoneRootCommitmentHex,
} from '@mosaic/zone-keys';
import {
  sep53Digest,
  stellarSigningPayload,
  xrplSignInTxJson,
  xrplSigningPayload,
  encodeXrplSignIn,
} from '@mosaic/zone-keys/verify';
import { AuthService } from '../dist/auth.js';
import { MemoryStore, PostgresStore, hashToken } from '../dist/store.js';
import { startHttpServer } from '../dist/http.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const evmAccount = privateKeyToAccount('0x' + '42'.repeat(32));
const stellarPriv = new Uint8Array(32).fill(0x55);
const stellarAddress = stellarAddressFromPublicKey(ed25519.getPublicKey(stellarPriv));
const xrplKeypair = deriveKeypair(generateSeed({ entropy: new Uint8Array(16).fill(7), algorithm: 'ecdsa-secp256k1' }));
const xrplAddress = deriveAddress(xrplKeypair.publicKey);

const allowAuthority = async () => ({ authoritative: true, reason: 'test' });
const testnetVaultKey = new Uint8Array(32).fill(0x19);

/** Signs any payload the server creates, like a Xaman wallet would. */
class FakeXaman {
  constructor(keypair, account) {
    this.keypair = keypair;
    this.account = account;
    this.payloads = new Map();
  }
  async createSignInPayload(message) {
    const uuid = `fake-${this.payloads.size}-${Math.random().toString(36).slice(2)}`;
    this.payloads.set(uuid, message);
    return { uuid, qrPng: 'https://example/qr.png', websocketStatus: 'wss://example', deeplink: 'https://example' };
  }
  async getPayloadResult(uuid) {
    const message = this.payloads.get(uuid);
    if (!message) throw new Error('not found');
    const tx = { ...xrplSignInTxJson(message), Account: this.account, SigningPubKey: this.keypair.publicKey };
    const signature = rippleSign(xrplSigningPayload(tx), this.keypair.privateKey);
    return { uuid, signed: true, resolved: true, hex: encodeXrplSignIn({ ...tx, TxnSignature: signature }), account: this.account };
  }
}

async function evmSign(message) {
  return evmAccount.signTypedData(eip712TypedData(message, 84532));
}

function stellarSign(message) {
  const digest = sep53Digest(stellarSigningPayload(message));
  return Buffer.from(ed25519.sign(digest, stellarPriv)).toString('base64');
}

// ------------------------------------------------------------- AuthService

test('evm login: challenge → sign → verify → session', async () => {
  const store = new MemoryStore();
  const auth = new AuthService(store);
  const challenge = await auth.challenge({ chain: 'evm', address: evmAccount.address, network: 'testnet' });
  assert.equal(challenge.evmChainId, 84532);
  const signature = await evmSign(challenge.message);
  const result = await auth.verify({ challengeId: challenge.challengeId, signature: { type: 'evm', signature } });
  assert.equal(result.address, evmAccount.address);
  const session = await auth.requireSession(result.token);
  assert.equal(session.chain, 'evm');
});

test('stellar login round-trip', async () => {
  const auth = new AuthService(new MemoryStore());
  const challenge = await auth.challenge({ chain: 'stellar', address: stellarAddress, network: 'mainnet' });
  const result = await auth.verify({
    challengeId: challenge.challengeId,
    signature: { type: 'stellar', signatureB64: stellarSign(challenge.message) },
  });
  assert.equal(result.address, stellarAddress);
  assert.equal(result.network, 'mainnet');
});

test('xrpl login via fake Xaman payload; address learned from the signed blob', async () => {
  const xaman = new FakeXaman(xrplKeypair, xrplAddress);
  const auth = new AuthService(new MemoryStore(), xaman, { checkAuthority: allowAuthority });
  const challenge = await auth.challenge({ chain: 'xrpl', network: 'testnet' });
  assert.ok(challenge.xaman.uuid);
  const result = await auth.verify({ challengeId: challenge.challengeId });
  assert.equal(result.address, xrplAddress);
});

test('xrpl login rejected when signing key is not authoritative', async () => {
  const xaman = new FakeXaman(xrplKeypair, xrplAddress);
  const deny = async () => ({ authoritative: false, reason: 'master key disabled' });
  const auth = new AuthService(new MemoryStore(), xaman, { checkAuthority: deny });
  const challenge = await auth.challenge({ chain: 'xrpl', network: 'testnet' });
  await assert.rejects(() => auth.verify({ challengeId: challenge.challengeId }), /not authoritative/);
});

test('nonce replay: a challenge can be consumed exactly once', async () => {
  const auth = new AuthService(new MemoryStore());
  const challenge = await auth.challenge({ chain: 'evm', address: evmAccount.address, network: 'testnet' });
  const signature = await evmSign(challenge.message);
  await auth.verify({ challengeId: challenge.challengeId, signature: { type: 'evm', signature } });
  await assert.rejects(
    () => auth.verify({ challengeId: challenge.challengeId, signature: { type: 'evm', signature } }),
    /unknown or already-used/,
  );
});

test('expired challenge rejected', async () => {
  const store = new MemoryStore();
  const auth = new AuthService(store);
  const past = new Date(Date.now() - 60_000).toISOString();
  await store.createChallenge({
    id: 'expired-1',
    purpose: 'session-auth',
    chain: 'evm',
    address: evmAccount.address,
    network: 'testnet',
    message: {},
    nonce: 'nonce-expired-1',
    issuedAt: past,
    expiresAt: past,
  });
  await assert.rejects(
    () => auth.verify({ challengeId: 'expired-1', signature: { type: 'evm', signature: '0x00' } }),
    /expired/,
  );
});

test('purpose confusion: a backup-wrap signature cannot log in', async () => {
  const auth = new AuthService(new MemoryStore());
  const challenge = await auth.challenge({ chain: 'evm', address: evmAccount.address, network: 'testnet' });
  // sign backup-wrap instead of the issued session-auth message
  const wrongPurpose = backupWrapMessage({
    rootChain: 'evm',
    rootAddress: evmAccount.address,
    zone: 'top',
    network: 'testnet',
  });
  const signature = await evmSign(wrongPurpose);
  await assert.rejects(
    () => auth.verify({ challengeId: challenge.challengeId, signature: { type: 'evm', signature } }),
    /verification failed/,
  );
});

test('wrong wallet signature rejected', async () => {
  const auth = new AuthService(new MemoryStore());
  const challenge = await auth.challenge({ chain: 'evm', address: evmAccount.address, network: 'testnet' });
  const otherAccount = privateKeyToAccount('0x' + '43'.repeat(32));
  const signature = await otherAccount.signTypedData(eip712TypedData(challenge.message, 84532));
  await assert.rejects(
    () => auth.verify({ challengeId: challenge.challengeId, signature: { type: 'evm', signature } }),
    /verification failed/,
  );
});

test('catalog preferences default, isolate owners, normalize EVM addresses, and merge custom chains', async () => {
  const store = new MemoryStore();
  const upperOwner = { chain: 'evm', address: '0xAbCDEF' };
  const lowerOwner = { chain: 'evm', address: '0xabcdef' };
  const otherOwner = { chain: 'stellar', address: stellarAddress };

  const defaults = await store.listCatalog(upperOwner);
  assert.equal(defaults.chains.length, 6);
  assert.ok(defaults.chains.every((chain) => chain.enabled));
  assert.ok(defaults.assets.every((asset) => asset.trustState === 'allowed'));

  // One toggle flips every network variant of the logical chain.
  const updated = await store.setChainEnabled(upperOwner, 'xrpl', false);
  assert.deepEqual(updated.map(({ id, enabled }) => [id, enabled]).sort(), [['xrpl-mainnet', false], ['xrpl-testnet', false]]);
  await store.setAssetTrust(upperOwner, 'rlusd', 'hidden');
  const lower = await store.listCatalog(lowerOwner);
  assert.equal(lower.chains.find((chain) => chain.id === 'xrpl-mainnet').enabled, false);
  assert.equal(lower.chains.find((chain) => chain.id === 'xrpl-testnet').enabled, false);
  assert.equal(lower.assets.find((asset) => asset.id === 'rlusd').trustState, 'hidden');
  assert.equal((await store.listCatalog(otherOwner)).chains.find((chain) => chain.id === 'xrpl-mainnet').enabled, true);
  assert.equal((await store.listCatalog(otherOwner)).assets.find((asset) => asset.id === 'rlusd').trustState, 'allowed');

  // Custom chains are single-network singletons keyed by their own id.
  await store.upsertCustomChain({ id: 'optimism-mainnet', name: 'Optimism', network: 'mainnet', evmChainId: 10, enabled: true });
  const withCustom = await store.listCatalog(upperOwner);
  const optimism = withCustom.chains.find((chain) => chain.id === 'optimism-mainnet');
  assert.equal(optimism.source, 'database');
  assert.equal(optimism.chainKey, 'optimism-mainnet');
  assert.equal(optimism.enabled, false);
  const customUpdated = await store.setChainEnabled(upperOwner, 'optimism-mainnet', true);
  assert.deepEqual(customUpdated.map(({ id, enabled }) => [id, enabled]), [['optimism-mainnet', true]]);
  await assert.rejects(
    () => store.upsertCustomChain({ id: 'base-mainnet', name: 'Fake Base', network: 'mainnet', evmChainId: 999, enabled: true }),
    /conflicts with built-in/,
  );
  await assert.rejects(
    () => store.upsertCustomChain({ id: 'base', name: 'Fake Base Key', network: 'mainnet', evmChainId: 998, enabled: true }),
    /conflicts with built-in/,
  );
  await assert.rejects(() => store.setChainEnabled(upperOwner, 'unknown', true), /unknown chain/);
  await assert.rejects(() => store.setAssetTrust(upperOwner, 'unknown', 'allowed'), /unknown asset/);
  await assert.rejects(() => store.setAssetTrust(upperOwner, 'usdc', 'maybe'), /invalid asset trust state/);
});

test('the root wallet family keeps at least one enabled chain', async () => {
  const store = new MemoryStore();
  const evmOwner = { chain: 'evm', address: '0xabcdef' };
  const stellarOwner = { chain: 'stellar', address: stellarAddress };

  await assert.rejects(() => store.setChainEnabled(evmOwner, 'base', false), /cannot disable every evm chain/);
  await assert.rejects(() => store.setChainEnabled(stellarOwner, 'stellar', false), /cannot disable every stellar chain/);
  // Other families toggle freely, and a second enabled evm chain unlocks base — per network.
  await store.setChainEnabled(evmOwner, 'stellar', false);
  await store.upsertCustomChain({ id: 'optimism-mainnet', name: 'Optimism', network: 'mainnet', evmChainId: 10, enabled: true });
  await store.setChainEnabled(evmOwner, 'optimism-mainnet', true);
  // base-sepolia would still be the last enabled testnet evm chain.
  await assert.rejects(() => store.setChainEnabled(evmOwner, 'base', false), /cannot disable every evm chain on testnet/);
});

test('wallet settings default to 3 minutes, validate options, normalize EVM addresses, and isolate owners', async () => {
  const store = new MemoryStore();
  const upperOwner = { chain: 'evm', address: '0xAbCDEF' };
  const lowerOwner = { chain: 'evm', address: '0xabcdef' };
  const otherOwner = { chain: 'stellar', address: stellarAddress };

  assert.deepEqual(await store.getWalletSettings(upperOwner), { lockReminderMinutes: 3 });
  await store.setWalletSettings(upperOwner, { lockReminderMinutes: 10 });
  assert.deepEqual(await store.getWalletSettings(lowerOwner), { lockReminderMinutes: 10 });
  assert.deepEqual(await store.getWalletSettings(otherOwner), { lockReminderMinutes: 3 });
  await store.setWalletSettings(otherOwner, { lockReminderMinutes: 0 });
  assert.deepEqual(await store.getWalletSettings(otherOwner), { lockReminderMinutes: 0 });
  await assert.rejects(() => store.setWalletSettings(upperOwner, { lockReminderMinutes: 2 }), /invalid lockReminderMinutes/);
  await assert.rejects(() => store.setWalletSettings(upperOwner, { lockReminderMinutes: -1 }), /invalid lockReminderMinutes/);
});

test('vault chain settings copy the account settings at creation and diverge independently', async () => {
  const store = new MemoryStore();
  const owner = { chain: 'evm', address: '0xabcdef' };
  await store.setChainEnabled(owner, 'xrpl', false);

  const zone = await store.createZone({
    rootChain: 'evm', rootAddress: '0xAbCdEf', zone: 'top', network: 'testnet',
    commitment: 'ab'.repeat(32), policyHash: 'ph', localSignerPublicKey: 'k',
    authorizeMessage: {}, authorizeSignature: {}, xrplSignInTemplate: null, layer1Enabled: true,
  });

  // Only the vault-network chains are copied, with the account values, in product order.
  const settings = await store.listZoneChainSettings(zone.id);
  assert.deepEqual(
    settings.map(({ chainId, chainKey, enabled }) => [chainId, chainKey, enabled]),
    [['xrpl-testnet', 'xrpl', false], ['stellar-testnet', 'stellar', true], ['base-sepolia', 'base', true]],
  );
  assert.ok(settings.every(({ network }) => network === 'testnet'));

  // Vault toggles do not touch the account settings, and vice versa.
  const toggled = await store.setZoneChainEnabled(zone.id, 'xrpl', true);
  assert.equal(toggled.find(({ chainKey }) => chainKey === 'xrpl').enabled, true);
  assert.equal((await store.listCatalog(owner)).chains.find(({ id }) => id === 'xrpl-testnet').enabled, false);
  await store.setChainEnabled(owner, 'stellar', false);
  assert.equal((await store.listZoneChainSettings(zone.id)).find(({ chainKey }) => chainKey === 'stellar').enabled, true);

  await assert.rejects(() => store.setZoneChainEnabled(zone.id, 'unknown', true), /unknown chain/);
  await assert.rejects(() => store.listZoneChainSettings('00000000-0000-0000-0000-000000000000'), /zone not found/);
});

test('vaults without stored chain settings lazily copy the account settings on first read', async () => {
  const store = new MemoryStore();
  const owner = { chain: 'evm', address: '0xabcdef' };
  const zone = await store.createZone({
    rootChain: 'evm', rootAddress: '0xabcdef', zone: 'legacy', network: 'testnet',
    commitment: 'ab'.repeat(32), policyHash: 'ph', localSignerPublicKey: 'k',
    authorizeMessage: {}, authorizeSignature: {}, xrplSignInTemplate: null, layer1Enabled: true,
  });
  // Simulate a vault that predates zone_chain_settings (TS-private, runtime-visible).
  store.zoneChainSettings.delete(zone.id);

  await store.setChainEnabled(owner, 'xrpl', false);
  const seeded = await store.listZoneChainSettings(zone.id);
  assert.equal(seeded.find(({ chainKey }) => chainKey === 'xrpl').enabled, false);
  // The first read pins the copy; later account changes no longer apply.
  await store.setChainEnabled(owner, 'xrpl', true);
  assert.equal((await store.listZoneChainSettings(zone.id)).find(({ chainKey }) => chainKey === 'xrpl').enabled, false);
});

test('MemoryStore lists zones deterministically and scopes unlock metadata to the owner and network', async () => {
  const store = new MemoryStore();
  const base = {
    rootChain: 'evm', rootAddress: evmAccount.address, network: 'testnet',
    commitment: 'ab'.repeat(32), policyHash: 'policy', localSignerPublicKey: 'browser:test',
    authorizeMessage: {}, authorizeSignature: {}, xrplSignInTemplate: null, layer1Enabled: true,
  };
  const later = await store.createZone({ ...base, zone: 'later' });
  const earlier = await store.createZone({ ...base, zone: 'earlier' });
  later.createdAt = '2026-02-01T00:00:00.000Z';
  earlier.createdAt = '2026-01-01T00:00:00.000Z';
  assert.deepEqual((await store.listZones('evm', evmAccount.address, 'testnet')).map(({ zone }) => zone), ['earlier', 'later']);
  assert.equal(await store.markZoneUnlocked('evm', '0x0000000000000000000000000000000000000000', 'earlier', 'testnet'), undefined);
  assert.equal(await store.markZoneUnlocked('evm', evmAccount.address, 'earlier', 'mainnet'), undefined);
  const unlocked = await store.markZoneUnlocked('evm', evmAccount.address, 'earlier', 'testnet');
  assert.ok(unlocked.lastUnlockedAt);
  assert.deepEqual((await store.listZoneAddresses(earlier.id)).map(({ chain, index, name }) => [chain, index, name]), [
    ['evm', 0, '#0'], ['stellar', 0, '#0'], ['xrpl', 0, '#0'],
  ]);
  const evm1 = await store.createZoneAddress(earlier.id, 'evm');
  const evm2 = await store.createZoneAddress(earlier.id, 'evm', 'treasury');
  const xrpl1 = await store.createZoneAddress(earlier.id, 'xrpl');
  assert.deepEqual([evm1.index, evm1.name, evm2.index, evm2.name, xrpl1.index, xrpl1.name], [1, '#1', 2, 'treasury', 1, '#1']);
  await assert.rejects(() => store.createZoneAddress(earlier.id, 'evm', 'treasury'), /already exists/);
});

// -------------------------------------------------- end-to-end over HTTP

async function connectClient(url) {
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? '{}';
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    if (result.isError) throw new Error(text, { cause: error });
    throw error;
  }
  if (result.isError) throw new Error(data.error?.message ?? text);
  return data;
}

test('full zone lifecycle over HTTP: login → zone_begin → zone_create → blobs → logout', async () => {
  const store = new MemoryStore();
  const xaman = new FakeXaman(xrplKeypair, xrplAddress);
  const auth = new AuthService(store, xaman, { checkAuthority: allowAuthority });
  const server = await startHttpServer({ store, auth, xaman, testnetVaultKey, bind: '127.0.0.1:0' });
  const client = await connectClient(server.url);
  try {
    // login (evm)
    const challenge = await call(client, 'auth_challenge', {
      chain: 'evm',
      network: 'testnet',
      address: evmAccount.address,
    });
    const loginSig = await evmSign(challenge.message);
    const { token } = await call(client, 'auth_verify', {
      challengeId: challenge.challengeId,
      signature: { type: 'evm', signature: loginSig },
    });
    assert.ok(token);

    // catalog defaults and trust updates are authenticated and wallet-scoped
    const catalog = await call(client, 'catalog_list', { token });
    assert.equal(catalog.chains.length, 6);
    assert.equal(catalog.assets.find((asset) => asset.id === 'rlusd').trustState, 'allowed');
    const hidden = await call(client, 'asset_trust_set', { token, assetId: 'rlusd', state: 'hidden' });
    assert.equal(hidden.trustState, 'hidden');
    const disabled = await call(client, 'chain_enabled_set', { token, chainKey: 'xrpl', enabled: false });
    assert.deepEqual(disabled.map(({ id, enabled }) => [id, enabled]).sort(), [['xrpl-mainnet', false], ['xrpl-testnet', false]]);
    await assert.rejects(() => call(client, 'catalog_list', {}), /missing session token|invalid/i);
    await assert.rejects(
      () => call(client, 'asset_trust_set', { token, assetId: 'rlusd', state: 'maybe' }),
      /invalid|expected/i,
    );

    // no zone yet
    const missing = await call(client, 'zone_get', { token, zone: 'top' });
    assert.equal(missing.exists, false);
    assert.deepEqual(await call(client, 'zone_list', { token }), []);

    // authorize-zone
    const begin = await call(client, 'zone_begin', { token, zone: 'top' });
    const commitment = 'ab'.repeat(32);
    const { authorizeZoneMessage } = await import('@mosaic/zone-keys');
    const message = authorizeZoneMessage(
      { rootChain: 'evm', rootAddress: evmAccount.address, zone: 'top', network: 'testnet' },
      {
        localSignerPublicKey: 'browser-host-1',
        policyHash: 'ph-1',
        zoneRootCommitment: commitment,
        nonce: begin.nonce,
        issuedAt: begin.issuedAt,
        expiresAt: begin.expiresAt,
      },
    );
    const zoneSig = await evmSign(message);
    const created = await call(client, 'zone_create', {
      token,
      challengeId: begin.challengeId,
      zone: 'top',
      localSignerPublicKey: 'browser-host-1',
      policyHash: 'ph-1',
      zoneRootCommitment: commitment,
      signature: { type: 'evm', signature: zoneSig },
    });
    assert.ok(created.zoneId);

    const listed = await call(client, 'zone_list', { token });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].zone, 'top');
    assert.equal(listed[0].commitment, commitment);
    assert.equal(listed[0].lastUnlockedAt, undefined);
    assert.deepEqual(listed[0].addresses.map(({ chain, index, name }) => [chain, index, name]), [
      ['evm', 0, '#0'], ['stellar', 0, '#0'], ['xrpl', 0, '#0'],
    ]);
    // Vault chains copied the account settings (xrpl disabled above) at creation, in product order.
    assert.deepEqual(listed[0].chains.map(({ chainId, enabled }) => [chainId, enabled]), [
      ['xrpl-testnet', false], ['stellar-testnet', true], ['base-sepolia', true],
    ]);

    // Per-vault toggles are independent of the account settings.
    const vaultChains = await call(client, 'zone_chain_set', { token, zone: 'top', chainKey: 'xrpl', enabled: true });
    assert.equal(vaultChains.find(({ chainKey }) => chainKey === 'xrpl').enabled, true);
    assert.equal(
      (await call(client, 'catalog_list', { token })).chains.find(({ id }) => id === 'xrpl-testnet').enabled,
      false,
    );
    await assert.rejects(() => call(client, 'zone_chain_set', { token, zone: 'top', chainKey: 'nope', enabled: true }), /unknown chain/);

    const evmAddress1 = await call(client, 'zone_address_create', { token, zone: 'top', chain: 'evm' });
    const evmAddress2 = await call(client, 'zone_address_create', { token, zone: 'top', chain: 'evm', name: 'trading' });
    const xrplAddress1 = await call(client, 'zone_address_create', { token, zone: 'top', chain: 'xrpl' });
    assert.deepEqual([evmAddress1.index, evmAddress1.name, evmAddress2.index, evmAddress2.name, xrplAddress1.index, xrplAddress1.name], [1, '#1', 2, 'trading', 1, '#1']);
    await assert.rejects(() => call(client, 'zone_address_create', { token, zone: 'top', chain: 'evm', name: 'trading' }), /already exists/);

    // Testnet sandbox vaults require no authorize-zone or backup signatures;
    // the server envelope-encrypts the secret and releases it only to the owner session.
    const testnetSecret = new Uint8Array(32).fill(7);
    const testnetCommitment = zoneRootCommitmentHex(testnetSecret);
    const quick = await call(client, 'zone_create_testnet', {
      token, zone: 'quick-test', zoneRootCommitment: testnetCommitment,
      zoneRootSecretB64: Buffer.from(testnetSecret).toString('base64'),
    });
    assert.ok(quick.zoneId);
    const quickRecord = await store.getZone('evm', evmAccount.address, 'quick-test', 'testnet');
    assert.equal(quickRecord.policyHash, 'testnet-server-v1');
    assert.deepEqual(quickRecord.authorizeSignature, { mode: 'none' });
    const quickBlob = await store.getBlob(quickRecord.id, 'server');
    assert.ok(quickBlob);
    assert.notDeepEqual([...quickBlob.ciphertext], [...testnetSecret]);
    const unlockedTestnet = await call(client, 'zone_testnet_unlock', { token, zone: 'quick-test' });
    assert.equal(unlockedTestnet.commitment, testnetCommitment);
    assert.equal(unlockedTestnet.zoneRootSecretB64, Buffer.from(testnetSecret).toString('base64'));
    assert.equal((await call(client, 'zone_list', { token })).find(({ zone }) => zone === 'quick-test').mode, 'testnet-server');
    const quickZone = await call(client, 'zone_get', { token, zone: 'quick-test' });
    assert.deepEqual(quickZone.blobs, [{ kind: 'server', version: 1 }]);

    const unlocked = await call(client, 'zone_unlocked', { token, zone: 'top' });
    assert.ok(unlocked.lastUnlockedAt);
    assert.equal((await call(client, 'zone_list', { token }))[0].lastUnlockedAt, unlocked.lastUnlockedAt);
    await assert.rejects(() => call(client, 'zone_unlocked', { token, zone: 'missing' }), /not found/);

    // duplicate zone rejected
    const begin2 = await call(client, 'zone_begin', { token, zone: 'top' });
    const message2 = authorizeZoneMessage(
      { rootChain: 'evm', rootAddress: evmAccount.address, zone: 'top', network: 'testnet' },
      {
        localSignerPublicKey: 'browser-host-1',
        policyHash: 'ph-1',
        zoneRootCommitment: commitment,
        nonce: begin2.nonce,
        issuedAt: begin2.issuedAt,
        expiresAt: begin2.expiresAt,
      },
    );
    const zoneSig2 = await evmSign(message2);
    await assert.rejects(
      () =>
        call(client, 'zone_create', {
          token,
          challengeId: begin2.challengeId,
          zone: 'top',
          localSignerPublicKey: 'browser-host-1',
          policyHash: 'ph-1',
          zoneRootCommitment: commitment,
          signature: { type: 'evm', signature: zoneSig2 },
        }),
      /already exists/,
    );

    // blobs
    const ciphertext = Buffer.from(new Uint8Array(64).fill(9)).toString('base64');
    const put = await call(client, 'blob_put', {
      token,
      zone: 'top',
      kind: 'sig',
      ciphertextB64: ciphertext,
      header: { v: 1, alg: 'xchacha20poly1305', nonce: 'bm9uY2U=', kdf: { type: 'sig-hkdf-v1' } },
    });
    assert.equal(put.version, 1);
    const got = await call(client, 'blob_get', { token, zone: 'top', kind: 'sig' });
    assert.equal(got.ciphertextB64, ciphertext);
    assert.equal(got.commitment, commitment);
    await assert.rejects(() => call(client, 'blob_get', { token, zone: 'top', kind: 'pass' }), /no pass blob/);

    const dataCiphertext = Buffer.alloc(64 * 1024 + 16, 3).toString('base64');
    assert.deepEqual(await call(client, 'blob_put', {
      token, zone: 'top', kind: 'data', ciphertextB64: dataCiphertext,
      header: { v: 1, schema: 'mosaic-vault-data', revision: 1 }, expectedVersion: 0,
    }), { version: 1 });
    await assert.rejects(() => call(client, 'blob_put', {
      token, zone: 'top', kind: 'data', ciphertextB64: dataCiphertext,
      header: { v: 1, schema: 'mosaic-vault-data', revision: 1 }, expectedVersion: 0,
    }), /version conflict/);

    // oversized blob rejected
    await assert.rejects(
      () =>
        call(client, 'blob_put', {
          token,
          zone: 'top',
          kind: 'pass',
          ciphertextB64: Buffer.alloc(5000).toString('base64'),
          header: { v: 1 },
        }),
      /1\.\.4096/,
    );

    // zone_get reflects blob
    const zone = await call(client, 'zone_get', { token, zone: 'top' });
    assert.equal(zone.exists, true);
    assert.deepEqual(zone.blobs, [{ kind: 'sig', version: 1 }]);
    assert.equal(zone.lastUnlockedAt, unlocked.lastUnlockedAt);

    // A session for another root wallet cannot list or update this wallet's zones.
    const otherAccount = privateKeyToAccount('0x' + '43'.repeat(32));
    const otherChallenge = await call(client, 'auth_challenge', {
      chain: 'evm', network: 'testnet', address: otherAccount.address,
    });
    const otherSignature = await otherAccount.signTypedData(eip712TypedData(otherChallenge.message, 84532));
    const { token: otherToken } = await call(client, 'auth_verify', {
      challengeId: otherChallenge.challengeId,
      signature: { type: 'evm', signature: otherSignature },
    });
    assert.deepEqual(await call(client, 'zone_list', { token: otherToken }), []);
    await assert.rejects(() => call(client, 'zone_unlocked', { token: otherToken, zone: 'top' }), /not found/);

    // The same root wallet's zones are also isolated by the session network.
    const mainnetChallenge = await call(client, 'auth_challenge', {
      chain: 'evm', network: 'mainnet', address: evmAccount.address,
    });
    const mainnetSignature = await evmAccount.signTypedData(eip712TypedData(mainnetChallenge.message, 8453));
    const { token: mainnetToken } = await call(client, 'auth_verify', {
      challengeId: mainnetChallenge.challengeId,
      signature: { type: 'evm', signature: mainnetSignature },
    });
    assert.deepEqual(await call(client, 'zone_list', { token: mainnetToken }), []);
    await assert.rejects(() => call(client, 'zone_create_testnet', {
      token: mainnetToken, zone: 'not-allowed', zoneRootCommitment: testnetCommitment,
      zoneRootSecretB64: Buffer.from(testnetSecret).toString('base64'),
    }), /Testnet-only/i);

    // Network switching preserves the wallet identity without another signature,
    // rotates the token, and can return to the original network and its zones.
    const switchedMainnet = await call(client, 'auth_network_switch', { token, network: 'mainnet' });
    assert.equal(switchedMainnet.address, evmAccount.address);
    assert.equal(switchedMainnet.network, 'mainnet');
    assert.deepEqual(await call(client, 'zone_list', { token: switchedMainnet.token }), []);
    await assert.rejects(() => call(client, 'zone_list', { token }), /invalid or expired/);
    const switchedBack = await call(client, 'auth_network_switch', { token: switchedMainnet.token, network: 'testnet' });
    assert.equal((await call(client, 'zone_list', { token: switchedBack.token }))[0].zone, 'top');

    // logout kills the session
    await call(client, 'auth_logout', { token: switchedBack.token });
    await assert.rejects(() => call(client, 'zone_get', { token, zone: 'top' }), /invalid or expired/);
  } finally {
    await client.close();
    await server.close();
  }
});

test('xrpl zone_create stores a SignIn template for byte-identical recovery', async () => {
  const store = new MemoryStore();
  const xaman = new FakeXaman(xrplKeypair, xrplAddress);
  const auth = new AuthService(store, xaman, { checkAuthority: allowAuthority });
  const challenge = await auth.challenge({ chain: 'xrpl', network: 'testnet' });
  const { token } = await auth.verify({ challengeId: challenge.challengeId });
  const session = await auth.requireSession(token);
  const begin = await auth.zoneBegin(session, 'top');

  const { authorizeZoneMessage } = await import('@mosaic/zone-keys');
  const message = authorizeZoneMessage(
    { rootChain: 'xrpl', rootAddress: xrplAddress, zone: 'top', network: 'testnet' },
    {
      localSignerPublicKey: 'host',
      policyHash: 'ph',
      zoneRootCommitment: 'cd'.repeat(32),
      nonce: begin.nonce,
      issuedAt: begin.issuedAt,
      expiresAt: begin.expiresAt,
    },
  );
  const payload = await xaman.createSignInPayload(message);
  const { message: verified } = await auth.verifyAuthorizeZone(session, {
    challengeId: begin.challengeId,
    zone: 'top',
    localSignerPublicKey: 'host',
    policyHash: 'ph',
    zoneRootCommitment: 'cd'.repeat(32),
    signature: { type: 'xrpl', payloadUuid: payload.uuid },
  });
  assert.equal(verified.purpose, 'authorize-zone');

  // template equals the deterministic txjson for the frozen backup-wrap message
  const expectedTemplate = xrplSignInTxJson(
    backupWrapMessage({ rootChain: 'xrpl', rootAddress: xrplAddress, zone: 'top', network: 'testnet' }),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(expectedTemplate)), JSON.parse(JSON.stringify(expectedTemplate)));
});

// --------------------------------------------------------------- Postgres

const pgUrl = process.env.MOSAIC_TEST_DATABASE_URL;

test('PostgresStore: challenge consume-once, session hashing, zone conflict, blob versions', { skip: !pgUrl }, async () => {
  const store = new PostgresStore(pgUrl);
  await store.init();
  try {
    const id = `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await store.createChallenge({
      id,
      purpose: 'session-auth',
      chain: 'evm',
      address: '0xabc',
      network: 'testnet',
      message: { hello: 'world' },
      nonce: `nonce-${id}`,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const first = await store.consumeChallenge(id);
    assert.equal(first?.nonce, `nonce-${id}`);
    assert.equal(await store.consumeChallenge(id), undefined); // replay across store = rejected

    const ownerAddress = `0xabc-${id}`;
    const { token } = await store.createSession({ chain: 'evm', address: ownerAddress, network: 'testnet', expiresAt: Date.now() + 60_000 });
    assert.ok((await store.getSession(token))?.address === ownerAddress);
    assert.notEqual(hashToken(token), token);

    const catalog = await store.listCatalog({ chain: 'evm', address: ownerAddress.toUpperCase() });
    assert.equal(catalog.assets.find((asset) => asset.id === 'usdc')?.trustState, 'allowed');
    await store.setAssetTrust({ chain: 'evm', address: ownerAddress.toUpperCase() }, 'usdc', 'review');
    assert.equal(
      (await store.listCatalog({ chain: 'evm', address: ownerAddress })).assets.find((asset) => asset.id === 'usdc')?.trustState,
      'review',
    );
    const customId = `custom-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await store.upsertCustomChain({ id: customId, name: 'Test EVM', network: 'testnet', evmChainId: 4_000_000_000_000 + Date.now(), enabled: true });
    const custom = (await store.listCatalog({ chain: 'evm', address: ownerAddress })).chains.find((chain) => chain.id === customId);
    assert.equal(custom?.source, 'database');
    assert.equal(custom?.chainKey, customId);
    assert.equal(custom?.enabled, false);

    // One toggle flips both network variants of a builtin chain.
    const updated = await store.setChainEnabled({ chain: 'evm', address: ownerAddress.toUpperCase() }, 'xrpl', false);
    assert.deepEqual(updated.map(({ id, enabled }) => [id, enabled]).sort(), [['xrpl-mainnet', false], ['xrpl-testnet', false]]);
    await assert.rejects(() => store.setChainEnabled({ chain: 'evm', address: ownerAddress }, 'base', false), /cannot disable every evm chain/);

    assert.deepEqual(await store.getWalletSettings({ chain: 'evm', address: ownerAddress }), { lockReminderMinutes: 3 });
    await store.setWalletSettings({ chain: 'evm', address: ownerAddress.toUpperCase() }, { lockReminderMinutes: 30 });
    assert.deepEqual(await store.getWalletSettings({ chain: 'evm', address: ownerAddress }), { lockReminderMinutes: 30 });
    await assert.rejects(() => store.setWalletSettings({ chain: 'evm', address: ownerAddress }, { lockReminderMinutes: 7 }), /invalid lockReminderMinutes/);

    const zoneName = `top-${id}`;
    const zone = await store.createZone({
      rootChain: 'evm',
      rootAddress: '0xabc',
      zone: zoneName,
      network: 'testnet',
      commitment: 'ee'.repeat(32),
      policyHash: 'ph',
      localSignerPublicKey: 'k',
      authorizeMessage: { m: 1 },
      authorizeSignature: { s: 1 },
      xrplSignInTemplate: null,
      layer1Enabled: true,
    });
    await assert.rejects(
      () =>
        store.createZone({
          rootChain: 'evm',
          rootAddress: '0xabc',
          zone: zoneName,
          network: 'testnet',
          commitment: 'ff'.repeat(32),
          policyHash: 'ph',
          localSignerPublicKey: 'k',
          authorizeMessage: {},
          authorizeSignature: {},
          xrplSignInTemplate: null,
          layer1Enabled: true,
        }),
      /already exists/,
    );

    // Vault chain settings: copied at creation, toggled independently of the account.
    const zoneChains = await store.listZoneChainSettings(zone.id);
    assert.equal(zoneChains.find(({ chainId }) => chainId === 'xrpl-testnet')?.enabled, true);
    assert.ok(zoneChains.every(({ network }) => network === 'testnet'));
    const vaultToggled = await store.setZoneChainEnabled(zone.id, 'xrpl', false);
    assert.equal(vaultToggled.find(({ chainId }) => chainId === 'xrpl-testnet')?.enabled, false);
    assert.equal(
      (await store.listCatalog({ chain: 'evm', address: '0xabc' })).chains.find(({ id }) => id === 'xrpl-testnet')?.enabled,
      true,
    );

    const data = new Uint8Array(48).fill(3);
    assert.deepEqual(await store.putBlob({ zoneId: zone.id, kind: 'sig', ciphertext: data, header: { v: 1 } }), { version: 1 });
    assert.deepEqual(await store.putBlob({ zoneId: zone.id, kind: 'sig', ciphertext: data, header: { v: 1 } }), { version: 2 });
    assert.deepEqual(await store.putBlob({ zoneId: zone.id, kind: 'data', ciphertext: data, header: { v: 1 }, expectedVersion: 0 }), { version: 1 });
    await assert.rejects(
      () => store.putBlob({ zoneId: zone.id, kind: 'data', ciphertext: data, header: { v: 1 }, expectedVersion: 0 }),
      /version conflict/,
    );
    assert.deepEqual(await store.putBlob({ zoneId: zone.id, kind: 'data', ciphertext: data, header: { v: 1 }, expectedVersion: 1 }), { version: 2 });
    const blob = await store.getBlob(zone.id, 'sig');
    assert.equal(blob?.version, 2);
    assert.deepEqual(blob?.ciphertext, data);
  } finally {
    await store.close();
  }
});
