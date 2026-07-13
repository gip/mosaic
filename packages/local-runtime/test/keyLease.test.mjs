import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_CONTROL_PROTOCOL, canonicalJson, generateKeyLeaseRecipient, openAgentKeyLease, sealAgentKeyLease, sha256Hex } from '../dist/index.js';

test('agent key leases are confidential and bound to agent, grant, Runner, network, and expiry', () => {
  const recipient = generateKeyLeaseRecipient();
  const payload = {
    protocol: AGENT_CONTROL_PROTOCOL,
    agentId: 'alpha', grantId: 'grant-a', runnerId: 'runner-a', network: 'testnet',
    certificateDigest: 'a'.repeat(64),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    secrets: [{ keyId: 'xmtp-owner', purpose: 'xmtp-owner', algorithm: 'secp256k1', materialB64: Buffer.alloc(32, 7).toString('base64') }],
  };
  const sealed = sealAgentKeyLease(payload, recipient.publicKeyB64);
  assert.equal(JSON.stringify(sealed).includes(payload.secrets[0].materialB64), false);
  assert.deepEqual(openAgentKeyLease(sealed, recipient.privateKey), payload);
  assert.throws(() => openAgentKeyLease({ ...sealed, agentId: 'beta' }, recipient.privateKey));
  assert.throws(() => openAgentKeyLease(sealed, generateKeyLeaseRecipient().privateKey));
  assert.throws(() => openAgentKeyLease(sealed, recipient.privateKey, Date.parse(payload.expiresAt) + 1), /expired/);
});

test('agent key lease sealing vector is frozen', () => {
  const payload = {
    protocol: AGENT_CONTROL_PROTOCOL, agentId: 'alpha', grantId: 'grant-a', runnerId: 'runner-a',
    certificateDigest: 'a'.repeat(64), network: 'testnet', expiresAt: '2099-01-01T00:00:00.000Z',
    secrets: [{ keyId: 'xmtp-owner', purpose: 'xmtp-owner', algorithm: 'secp256k1', materialB64: Buffer.alloc(32, 7).toString('base64') }],
  };
  const sealed = sealAgentKeyLease(payload, 'MCowBQYDK2VuAyEAqA8+ufSeksFtSGt2OwIbUJR9mEggOp0kLopiuh9dOgo=', {
    ephemeralPrivateKey: Buffer.from('MC4CAQAwBQYDK2VuBCIEIPjrY9sD4vVjAYF7srY8pCMDLxKxcicImrcooy7JDBRB', 'base64'),
    nonce: new Uint8Array(12).fill(5),
  });
  assert.equal(sha256Hex(canonicalJson(sealed)), 'f2f5c3172c1ad9f83d1bc7ec7b911de42a02874dedfec417e92357cf0048d5bf');
});
