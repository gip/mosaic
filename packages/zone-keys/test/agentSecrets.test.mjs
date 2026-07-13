import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  agentSecretStoreKey,
  openAgentSecretStore,
  sealAgentSecretStore,
} from '../dist/index.js';

const root = hexToBytes('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
const ref = { rootChain: 'evm', rootAddress: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94', zone: 'market-maker', network: 'testnet' };
const store = {
  v: 1,
  agentId: 'market-maker',
  secrets: [
    { keyId: 'xmtp-owner', purpose: 'xmtp-owner', algorithm: 'secp256k1', custody: 'supervisor-session', materialB64: Buffer.alloc(32, 1).toString('base64'), createdAt: '2026-07-13T00:00:00.000Z' },
    { keyId: 'trading', purpose: 'transaction-signing', algorithm: 'secp256k1', custody: 'guardian-only', materialB64: Buffer.alloc(32, 2).toString('base64'), createdAt: '2026-07-13T00:00:00.000Z' },
  ],
};

test('agent secret store round-trips and binds every vault dimension', () => {
  const nonce = new Uint8Array(24).fill(3);
  const wrapped = sealAgentSecretStore(root, ref, store, 7, nonce);
  assert.equal(Buffer.from(sha256(wrapped.ciphertext)).toString('hex'), 'e7b1b452cff18829281effb1291c5e549ae9db1bfe52f56f3ccfaece547bae54');
  assert.deepEqual(openAgentSecretStore(root, ref, wrapped), store);
  assert.throws(() => openAgentSecretStore(root, { ...ref, zone: 'other' }, wrapped));
  assert.throws(() => openAgentSecretStore(root, { ...ref, network: 'mainnet' }, wrapped));
  assert.throws(() => openAgentSecretStore(new Uint8Array(32).fill(8), ref, wrapped));
  assert.throws(() => openAgentSecretStore(root, ref, { ...wrapped, header: { ...wrapped.header, revision: 8 } }));
});

test('agent secret store enforces custody and key material rules', () => {
  assert.throws(() => sealAgentSecretStore(root, ref, { ...store, secrets: [{ ...store.secrets[1], custody: 'supervisor-session' }] }, 1), /Guardian-only/);
  assert.throws(() => sealAgentSecretStore(root, ref, { ...store, secrets: [{ ...store.secrets[0], materialB64: 'AQ==' }] }, 1), /32 bytes/);
});

test('agent secret store key is frozen and zone-separated', () => {
  assert.equal(Buffer.from(agentSecretStoreKey(root, ref)).toString('hex'), '61f5820a05b1fd3fb9047cb29be7c7039e0aa6f0262e9ffd47765cff917f5557');
  assert.notDeepEqual(agentSecretStoreKey(root, ref), agentSecretStoreKey(root, { ...ref, zone: 'other' }));
});
