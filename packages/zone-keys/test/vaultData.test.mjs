import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexToBytes } from '@noble/hashes/utils.js';
import {
  VAULT_DATA_MAX_PLAINTEXT_BYTES,
  openVaultData,
  sealVaultData,
  vaultDataKey,
} from '../dist/index.js';

const secret = hexToBytes('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
const ref = { rootChain: 'evm', rootAddress: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94', zone: 'mosaic-agent-runner', network: 'testnet' };
const data = {
  v: 1,
  identities: { self: { chain: 'evm', addressName: 'self', address: '0x0000000000000000000000000000000000000001', index: 1 } },
  connections: { guardian: { evmAddress: '0x0000000000000000000000000000000000000002', xmtpEnvironment: 'dev' } },
};

test('vault data round-trips canonical JSON', () => {
  const blob = sealVaultData(secret, ref, data, 3);
  assert.equal(blob.header.revision, 3);
  assert.deepEqual(openVaultData(secret, ref, blob), data);
});

test('vault data is bound to zone, network, revision, and secret', () => {
  const blob = sealVaultData(secret, ref, data, 1);
  assert.throws(() => openVaultData(secret, { ...ref, zone: 'other' }, blob));
  assert.throws(() => openVaultData(secret, { ...ref, network: 'mainnet' }, blob));
  assert.throws(() => openVaultData(new Uint8Array(32).fill(9), ref, blob));
  assert.throws(() => openVaultData(secret, ref, { ...blob, header: { ...blob.header, revision: 2 } }));
});

test('vault data rejects tampering and oversized JSON', () => {
  const blob = sealVaultData(secret, ref, data, 1);
  const tampered = { ...blob, ciphertext: blob.ciphertext.slice() };
  tampered.ciphertext[0] ^= 1;
  assert.throws(() => openVaultData(secret, ref, tampered));
  assert.throws(() => sealVaultData(secret, ref, { v: 1, extensions: { large: 'x'.repeat(VAULT_DATA_MAX_PLAINTEXT_BYTES) } }, 1), /exceeds/);
});

test('vault data key has a stable golden value and zone separation', () => {
  assert.equal(Buffer.from(vaultDataKey(secret, ref)).toString('hex'), 'a8867cf794acb04b5a1c23d4aec8df49d685acf30f6e75a6a794e37c7acf6bfa');
  assert.notDeepEqual(vaultDataKey(secret, ref), vaultDataKey(secret, { ...ref, zone: 'other' }));
});
