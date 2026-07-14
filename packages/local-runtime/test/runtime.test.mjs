import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_CONTROL_PROTOCOL,
  ControlStateStore,
  DEFAULT_GRANT_TTL_MS,
  DEFAULT_GUARDIAN_VAULT,
  assertControlBindings,
  createControlEnvelope,
  createPairingOffer,
  loadOrCreateRunnerDeviceIdentity,
  parseLocalCli,
  signRunnerText,
  verifyPairingOffer,
  verifyRunnerEnvelope,
} from '../dist/index.js';
import { InMemoryControlNetwork } from '../dist/xmtpControl.js';

test('local CLI defaults and V3 session duration', () => {
  assert.deepEqual(parseLocalCli([], DEFAULT_GUARDIAN_VAULT), {
    vault: 'mosaic-agent-guardian', network: 'testnet', help: false,
  });
  assert.deepEqual(parseLocalCli(['custom', '--network=mainnet'], DEFAULT_GUARDIAN_VAULT), {
    vault: 'custom', network: 'mainnet', help: false,
  });
  assert.equal(AGENT_CONTROL_PROTOCOL, 'MOSAIC_AGENT_CONTROL_V3');
  assert.equal(DEFAULT_GRANT_TTL_MS, 24 * 60 * 60_000);
});

test('Runner envelopes are canonical, signed, inbox-bound, size-capped, and tamper evident', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mosaic-control-v3-'));
  const identity = await loadOrCreateRunnerDeviceIdentity(root, 'runner-one');
  const input = {
    kind: 'agent-start-request', guardianId: 'guardian-one', guardianControlInboxId: 'guardian-inbox',
    runnerId: 'runner-one', runnerDevicePublicKey: identity.publicKeyB64, runnerControlInboxId: 'runner-inbox',
    agentId: 'agent-one', sequence: 1, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    payload: { network: 'testnet', supervisorKeyLeasePublicKeyB64: 'lease-key' },
  };
  const envelope = createControlEnvelope(input, (text) => signRunnerText(identity.privateKeyB64, text));
  verifyRunnerEnvelope(envelope, identity.publicKeyB64);
  assertControlBindings(envelope, {
    guardianId: 'guardian-one', guardianControlInboxId: 'guardian-inbox', runnerId: 'runner-one',
    runnerDevicePublicKey: identity.publicKeyB64, runnerControlInboxId: 'runner-inbox',
  });
  assert.throws(() => verifyRunnerEnvelope({ ...envelope, payload: { network: 'mainnet' } }, identity.publicKeyB64), /payload digest/);
  assert.throws(() => assertControlBindings(envelope, { ...input, runnerControlInboxId: 'wrong' }), /binding/);
});

test('pairing offers are signed, network-specific, and expire within five minutes', async () => {
  const identity = await loadOrCreateRunnerDeviceIdentity(await mkdtemp(join(tmpdir(), 'mosaic-pair-v3-')), 'runner');
  const offer = createPairingOffer({ identity, runnerControlAddress: '0x1234', runnerControlInboxId: 'runner-inbox', network: 'testnet' });
  verifyPairingOffer(offer);
  assert.throws(() => verifyPairingOffer({ ...offer, network: 'mainnet' }), /signature/);
  assert.throws(() => verifyPairingOffer({ ...offer, expiresAt: new Date(Date.parse(offer.issuedAt) + 6 * 60_000).toISOString() }), /lifetime|signature/);
});

test('control state persists strict sequences, replay IDs, idempotency results, approvals, and termination state', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'mosaic-state-v3-')), 'state.json');
  const first = new ControlStateStore(path);
  await first.load();
  assert.equal(first.nextSequence('scope'), 1);
  first.acceptInbound('scope', 1);
  assert.throws(() => first.acceptInbound('scope', 3), /expected 2/);
  first.markMessage('xmtp-1');
  first.setIdempotencyResult('operation-1', '{"ok":true}');
  first.setPendingApproval('approval-1', '{}');
  first.setTerminationState('agent|grant', 'sent:immediate');
  first.setUnsentCheckpoint('checkpoint-1', '{"checkpoint":true}');
  await first.flush();
  const second = new ControlStateStore(path);
  await second.load();
  assert.equal(second.nextSequence('scope'), 2);
  assert.equal(second.hasMessage('xmtp-1'), true);
  assert.equal(second.idempotencyResult('operation-1'), '{"ok":true}');
  assert.equal(second.pendingApprovals()['approval-1'], '{}');
  assert.equal(second.terminationState('agent|grant'), 'sent:immediate');
  assert.equal(second.unsentCheckpoints()['checkpoint-1'], '{"checkpoint":true}');
});

test('in-memory XMTP adapter provides deterministic delayed delivery without polling', async () => {
  const network = new InMemoryControlNetwork();
  const guardian = network.create('0xguardian', 'guardian-inbox');
  const runner = network.create('0xrunner', 'runner-inbox');
  await guardian.send('runner-inbox', 'before-start');
  const received = [];
  await runner.start(async (message) => { received.push(message); });
  assert.deepEqual(received.map(({ content }) => content), ['before-start']);
  await guardian.send('runner-inbox', 'live');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received.map(({ content }) => content), ['before-start', 'live']);
});
