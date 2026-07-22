import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  InMemoryControlNetwork,
} from '@mosaic/local-runtime/control';
import {
  createCompanionEnvelope,
  verifyCompanionEnvelope,
  verifyCompanionOffer,
} from '@mosaic/local-runtime/companion';
import { GuardianCompanionControl } from '../dist/companion.js';

function signEip191(privateKey, message) {
  const bytes = utf8ToBytes(message);
  const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${bytes.length}`);
  const signature = secp256k1.sign(keccak_256(concatBytes(prefix, bytes)), privateKey, { prehash: false, format: 'recovered' });
  return Uint8Array.from([...signature.slice(1), signature[0] + 27]);
}

const guardianKey = new Uint8Array(32).fill(0x21);
const guardianAddress = `0x${Buffer.from(keccak_256(secp256k1.getPublicKey(guardianKey, false).slice(1)).slice(-20)).toString('hex')}`;
const sign = (text) => signEip191(guardianKey, text);

function fakeGuardian() {
  return {
    controlAuthority: () => ({ guardianId: 'mosaic-agent-guardian:guardian:2', guardianAddress, sign }),
  };
}

function fakeControl(record) {
  return {
    pendingApprovals: () => [],
    approveAgentStart: async (requestId) => record.push(['approve-start', requestId]),
    resolvePrivileged: async (requestId) => record.push(['approve-privileged', requestId]),
    rejectApproval: async (requestId, reason) => record.push(['reject', requestId, reason]),
    terminateAgent: async (agentId, mode, reason) => { record.push(['terminate', agentId, mode, reason]); return 'cmd-1'; },
  };
}

async function settled() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('companion lifecycle: offer → enroll → forward → decisions under one authority', async () => {
  const network = new InMemoryControlNetwork();
  const guardianTransport = network.create(guardianAddress, 'guardian-inbox');
  const phoneTransport = network.create('0xphone', 'phone-inbox');
  const actions = [];
  const events = [];
  const pushes = [];
  const control = fakeControl(actions);
  const companion = new GuardianCompanionControl(
    fakeGuardian(), control, guardianTransport, 'testnet',
    (event) => events.push(event),
    async (category) => pushes.push(category),
  );

  const phoneInbox = [];
  await phoneTransport.start(async (message) => phoneInbox.push(JSON.parse(message.content)));
  // The guardian transport routes companion kinds to companion.receive —
  // emulate the GuardianXmtpControl dispatch.
  await guardianTransport.start(async (message) => {
    const envelope = JSON.parse(message.content);
    await companion.receive(envelope, message);
  });

  // 1. Pairing offer verifies on the phone side.
  const offer = companion.createOffer();
  verifyCompanionOffer(offer);
  assert.equal(offer.guardianId.toLowerCase(), guardianAddress.toLowerCase());
  assert.equal(offer.vault, 'mosaic-agent-guardian');
  assert.equal(offer.authorityIndex, 2);

  // 2. The phone enrolls, signing with the SAME vault-derived authority key
  //    (possible only after unlocking the vault on the phone).
  const enrollment = createCompanionEnvelope({
    kind: 'companion-enrollment',
    requestId: 'enroll-1',
    guardianId: guardianAddress,
    guardianControlInboxId: 'guardian-inbox',
    companionInboxId: 'phone-inbox',
    sequence: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    payload: { network: 'testnet', pairingNonce: offer.nonce, companionName: 'Test iPhone' },
  }, sign);
  await phoneTransport.send('guardian-inbox', JSON.stringify(enrollment));
  await settled();
  assert.deepEqual(events.filter((event) => event.type === 'companion-enrolled').length, 1);
  assert.equal(companion.companion().inboxId, 'phone-inbox');

  // 3. A queued approval is forwarded to the phone and triggers a push.
  await companion.forwardApproval('req-1', 'transaction.propose', 'agent-1', 'grant-1', { chain: 'xrpl', intentType: 'payment' });
  await settled();
  const forward = phoneInbox.find((message) => message.kind === 'approval-forward');
  assert.ok(forward, 'phone must receive the forward');
  verifyCompanionEnvelope(forward, guardianAddress);
  assert.equal(forward.payload.summary.intentType, 'payment');
  assert.deepEqual(pushes, ['approval']);

  // 4. An approve decision (signed by the same authority) applies on desktop.
  const decision = createCompanionEnvelope({
    kind: 'approval-decision',
    requestId: 'req-1',
    guardianId: guardianAddress,
    guardianControlInboxId: 'guardian-inbox',
    companionInboxId: 'phone-inbox',
    sequence: 2,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    payload: { requestId: 'req-1', decision: 'approve', forwardDigest: forward.payloadDigest },
  }, sign);
  await phoneTransport.send('guardian-inbox', JSON.stringify(decision));
  await settled();
  assert.deepEqual(actions, [['approve-privileged', 'req-1']]);

  // 5. Replayed decision for a resolved approval fails safely.
  await phoneTransport.send('guardian-inbox', JSON.stringify(decision));
  await settled();
  assert.ok(events.some((event) => event.type === 'companion-error' && /unknown or resolved/.test(event.detail)));

  // 6. Revoke round-trip: forward again, revoke, phone gets approval-resolved.
  await companion.forwardApproval('req-2', 'agent-start', 'agent-2');
  await settled();
  const forward2 = phoneInbox.find((message) => message.kind === 'approval-forward' && message.requestId === 'req-2');
  const revoke = createCompanionEnvelope({
    kind: 'approval-decision',
    requestId: 'req-2',
    guardianId: guardianAddress,
    guardianControlInboxId: 'guardian-inbox',
    companionInboxId: 'phone-inbox',
    sequence: 3,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    payload: { requestId: 'req-2', decision: 'revoke', reason: 'phone kill', forwardDigest: forward2.payloadDigest },
  }, sign);
  await phoneTransport.send('guardian-inbox', JSON.stringify(revoke));
  await settled();
  assert.deepEqual(actions.at(-1), ['terminate', 'agent-2', 'immediate', 'phone kill']);
  const resolved = phoneInbox.find((message) => message.kind === 'approval-resolved' && message.requestId === 'req-2');
  assert.ok(resolved);
  verifyCompanionEnvelope(resolved, guardianAddress);
  assert.equal(resolved.payload.outcome, 'revoked');

  // 7. A decision signed by a DIFFERENT key is rejected outright.
  const attackerKey = new Uint8Array(32).fill(0x77);
  await companion.forwardApproval('req-3', 'transaction.propose', 'agent-3', 'grant-3');
  await settled();
  const forward3 = phoneInbox.find((message) => message.kind === 'approval-forward' && message.requestId === 'req-3');
  const forged = createCompanionEnvelope({
    kind: 'approval-decision',
    requestId: 'req-3',
    guardianId: `0x${Buffer.from(keccak_256(secp256k1.getPublicKey(attackerKey, false).slice(1)).slice(-20)).toString('hex')}`,
    guardianControlInboxId: 'guardian-inbox',
    companionInboxId: 'phone-inbox',
    sequence: 4,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    payload: { requestId: 'req-3', decision: 'approve', forwardDigest: forward3.payloadDigest },
  }, (text) => signEip191(attackerKey, text));
  await phoneTransport.send('guardian-inbox', JSON.stringify(forged));
  await settled();
  assert.ok(events.some((event) => event.type === 'companion-error' && /guardian mismatch/.test(event.detail)));
  assert.equal(actions.filter(([kind]) => kind !== 'terminate').length, 1, 'no extra approvals applied');
});
