import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { argon2id } from 'hash-wasm';
import {
  ARGON2_PARAMS_V1,
  zoneRootCommitmentHex,
  sealSignatureBlob,
  openSignatureBlob,
  sealPassphraseBlob,
  openPassphraseBlob,
  passphraseKdfParams,
  encodeBackupFile,
  decodeBackupBlob,
  deriveAgentAddresses,
  sealVaultData,
  openVaultData,
  decodeVaultDataBackupBlob,
} from '../dist/index.js';

const secret = hexToBytes('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
const commitment = zoneRootCommitmentHex(secret);
const ref = {
  rootChain: 'evm',
  rootAddress: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
  zone: 'top',
  network: 'mainnet',
};
// A deterministic wallet signature stand-in (65 bytes like an EVM sig).
const signature = new Uint8Array(65).fill(0x42);

async function argonKek(passphrase, salt) {
  const hash = await argon2id({
    password: passphrase,
    salt,
    parallelism: ARGON2_PARAMS_V1.p,
    iterations: ARGON2_PARAMS_V1.t,
    memorySize: ARGON2_PARAMS_V1.m,
    hashLength: 32,
    outputType: 'binary',
  });
  return hash;
}

test('layer 1 round-trip: wrap → destroy → unwrap → commitment verifies → addresses match', () => {
  const blob = sealSignatureBlob(signature, secret, ref);
  const recovered = openSignatureBlob(signature, blob, ref, commitment);
  assert.deepEqual(recovered, secret);
  // derivation from the recovered secret matches derivation from the original
  assert.deepEqual(deriveAgentAddresses(recovered, ref, 0), deriveAgentAddresses(secret, ref, 0));
});

test('layer 1: tampered ciphertext → AEAD failure, no partial state', () => {
  const blob = sealSignatureBlob(signature, secret, ref);
  const tampered = { ...blob, ciphertext: blob.ciphertext.slice() };
  tampered.ciphertext[0] ^= 0xff;
  assert.throws(() => openSignatureBlob(signature, tampered, ref, commitment));
});

test('layer 1: wrong signature → AEAD failure', () => {
  const blob = sealSignatureBlob(signature, secret, ref);
  const wrongSig = new Uint8Array(65).fill(0x43);
  assert.throws(() => openSignatureBlob(wrongSig, blob, ref, commitment));
});

test('layer 1: wrong zone metadata (AAD binding) → AEAD failure', () => {
  const blob = sealSignatureBlob(signature, secret, ref);
  assert.throws(() => openSignatureBlob(signature, blob, { ...ref, zone: 'agents' }, commitment));
  assert.throws(() => openSignatureBlob(signature, blob, { ...ref, network: 'testnet' }, commitment));
});

test('layer 2 round-trip with real Argon2id params; wrong passphrase rejected', async () => {
  const salt = randomBytes(16);
  const kek = await argonKek('correct horse battery staple', salt);
  const blob = sealPassphraseBlob(kek, salt, secret, ref);

  const params = passphraseKdfParams(blob);
  assert.equal(params.m, 262144);
  assert.equal(params.t, 3);
  assert.equal(params.p, 1);
  assert.deepEqual(params.saltBytes, salt);

  const recovered = openPassphraseBlob(kek, blob, ref, commitment);
  assert.deepEqual(recovered, secret);

  const wrongKek = await argonKek('wrong passphrase', salt);
  assert.throws(() => openPassphraseBlob(wrongKek, blob, ref, commitment));
});

test('layer 2: tampered header params rejected before any decryption', () => {
  const kek = new Uint8Array(32).fill(1);
  const salt = new Uint8Array(16).fill(2);
  const blob = sealPassphraseBlob(kek, salt, secret, ref);
  const weakened = { ...blob, header: { ...blob.header, kdf: { ...blob.header.kdf, m: 8 } } };
  assert.throws(() => passphraseKdfParams(weakened), /argon2id params/);
  assert.throws(() => openPassphraseBlob(kek, weakened, ref, commitment), /argon2id params/);
});

test('kdf-type confusion rejected', () => {
  const sigBlob = sealSignatureBlob(signature, secret, ref);
  const kek = new Uint8Array(32).fill(1);
  assert.throws(() => openPassphraseBlob(kek, sigBlob, ref, commitment), /not a passphrase/);
  const passBlob = sealPassphraseBlob(kek, new Uint8Array(16), secret, ref);
  assert.throws(() => openSignatureBlob(signature, passBlob, ref, commitment), /not a signature/);
});

test('backup file encodes/decodes both blobs', () => {
  const kek = new Uint8Array(32).fill(1);
  const sig = sealSignatureBlob(signature, secret, ref);
  const pass = sealPassphraseBlob(kek, new Uint8Array(16).fill(3), secret, ref);
  const data = sealVaultData(secret, ref, { v: 1, connections: { guardian: { evmAddress: '0x0000000000000000000000000000000000000001', xmtpEnvironment: 'production' } } }, 1);
  const file = encodeBackupFile(ref, commitment, { sig, pass }, '2026-07-08T00:00:00.000Z', data);
  assert.equal(file.format, 'mosaic-zone-backup');
  assert.equal(file.commitment, commitment);
  const roundtrip = JSON.parse(JSON.stringify(file));
  const sig2 = decodeBackupBlob(roundtrip.blobs.sig);
  assert.deepEqual(openSignatureBlob(signature, sig2, ref, commitment), secret);
  const pass2 = decodeBackupBlob(roundtrip.blobs.pass);
  assert.deepEqual(openPassphraseBlob(kek, pass2, ref, commitment), secret);
  assert.deepEqual(openVaultData(secret, ref, decodeVaultDataBackupBlob(roundtrip.data)), {
    v: 1,
    connections: { guardian: { evmAddress: '0x0000000000000000000000000000000000000001', xmtpEnvironment: 'production' } },
  });
});
