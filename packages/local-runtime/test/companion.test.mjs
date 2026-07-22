import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  companionDigest,
  companionEnvelopeSignatureText,
  createCompanionEnvelope,
  createCompanionOffer,
  recoverEip191Address,
  verifyCompanionEnvelope,
  verifyCompanionOffer,
} from '../dist/companionProtocol.js';
import { contractDigest } from '../dist/digest.js';

// Same construction as the desktop Guardian's signEip191.
function signEip191(privateKey, message) {
  const messageBytes = utf8ToBytes(message);
  const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${messageBytes.length}`);
  const recovered = secp256k1.sign(keccak_256(concatBytes(prefix, messageBytes)), privateKey, {
    prehash: false,
    format: 'recovered',
  });
  return Uint8Array.from([...recovered.slice(1), recovered[0] + 27]);
}

const privateKey = new Uint8Array(32).fill(7);
const publicKey = secp256k1.getPublicKey(privateKey, false);
const address = `0x${Buffer.from(keccak_256(publicKey.slice(1)).slice(-20)).toString('hex')}`;
const sign = (text) => signEip191(privateKey, text);
const nonce = 'ab'.repeat(32);

test('companionDigest equals contractDigest for identical values', () => {
  const value = { b: 2, a: [1, 'x', null], nested: { z: true } };
  assert.equal(companionDigest(value), contractDigest(value));
});

test('companion offer round-trip: create → verify; tampering is rejected', () => {
  const offer = createCompanionOffer(
    { guardianId: address, guardianControlInboxId: 'inbox-guardian', vault: 'mosaic-agent-guardian', authorityIndex: 3, network: 'testnet', nonce },
    sign,
  );
  verifyCompanionOffer(offer);

  assert.throws(() => verifyCompanionOffer({ ...offer, network: 'mainnet' }), /signature|scope/);
  assert.throws(() => verifyCompanionOffer({ ...offer, authorityIndex: 4 }), /signature/);
  assert.throws(() => verifyCompanionOffer({ ...offer, extra: true }), /fields/);
});

test('companion offer creation with a mismatched signer throws', () => {
  assert.throws(() =>
    createCompanionOffer(
      { guardianId: address, guardianControlInboxId: 'inbox', vault: 'v', authorityIndex: 0, network: 'testnet', nonce },
      (text) => signEip191(new Uint8Array(32).fill(9), text),
    ),
  );
});

test('companion envelopes sign and verify both directions under one authority', () => {
  const payload = { operation: 'transaction.propose', requestId: 'req-1', network: 'testnet', summary: { chain: 'xrpl' } };
  const envelope = createCompanionEnvelope(
    {
      kind: 'approval-forward',
      requestId: 'req-1',
      guardianId: address,
      guardianControlInboxId: 'inbox-guardian',
      companionInboxId: 'inbox-phone',
      sequence: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      payload,
    },
    sign,
  );
  verifyCompanionEnvelope(envelope, address);
  assert.equal(envelope.payloadDigest, companionDigest(payload));
  assert.equal(recoverEip191Address(companionEnvelopeSignatureText(envelope), envelope.signatureB64).toLowerCase(), address.toLowerCase());

  // The phone's reply verifies under the SAME address.
  const decision = createCompanionEnvelope(
    {
      kind: 'approval-decision',
      requestId: 'req-1',
      guardianId: address,
      guardianControlInboxId: 'inbox-guardian',
      companionInboxId: 'inbox-phone',
      sequence: 2,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      payload: { requestId: 'req-1', decision: 'approve', forwardDigest: envelope.payloadDigest },
    },
    sign,
  );
  verifyCompanionEnvelope(decision, address);

  // Tampered payload → digest mismatch; wrong expected signer → mismatch.
  assert.throws(() => verifyCompanionEnvelope({ ...envelope, payload: { ...payload, summary: {} } }, address), /digest/);
  assert.throws(() => verifyCompanionEnvelope(envelope, '0x' + '11'.repeat(20)), /guardian mismatch/);
  // Expired envelope rejected.
  assert.throws(() =>
    verifyCompanionEnvelope(envelope, address, Date.parse(envelope.expiresAt) + 1000), /expired/);
});
