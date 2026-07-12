import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import {
  AGENT_CONTROL_PROTOCOL,
  AGENT_RUNTIME_VERSION,
  contractDigest,
  manifestSignatureText,
  sha256Hex,
} from '@mosaic/local-runtime';
import { VaultCore } from '../dist/index.js';

function setup() {
  let now = Date.now();
  const pair = generateKeyPairSync('ed25519');
  const runnerPublicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const vault = new VaultCore({
    guardianId: 'guardian:1',
    guardianAddress: '0x0000000000000000000000000000000000000001',
    network: 'testnet',
    signEnvelope: () => new Uint8Array(65).fill(7),
  }, () => now);
  const certificate = vault.enrollRunner({ runnerId: 'runner:1', runnerPublicKey, network: 'testnet', environment: 'local' });
  const unsigned = {
    protocol: AGENT_CONTROL_PROTOCOL, kind: 'agent-manifest', agentId: 'agent:1', version: '1', sourceDigest: sha256Hex('agent'),
    requiredHooks: ['log.emit'],
    limits: { memoryBytes: 1024 * 1024, stackBytes: 64 * 1024, wallTimeMs: 1000, maxPendingJobs: 8, maxHookConcurrency: 1, maxHookResponseBytes: 4096 },
    minimumRuntimeVersion: AGENT_RUNTIME_VERSION, publisher: 'runner:1', publisherSignatureB64: '',
  };
  const manifest = { ...unsigned, publisherSignatureB64: sign(null, Buffer.from(manifestSignatureText(unsigned)), pair.privateKey).toString('base64') };
  const capabilities = [{ operation: 'log.emit', maxCalls: 2, maxResponseBytes: 1024 }];
  const grant = vault.issueGrant({ certificate, manifest, configDigest: contractDigest({}), policyDigest: contractDigest(capabilities), capabilities });
  return { vault, certificate, manifest, capabilities, grant, advance: (ms) => { now += ms; } };
}

test('Vault Core rejects reordered calls and replays idempotent results', () => {
  const { vault, grant } = setup();
  const request = {
    protocol: AGENT_CONTROL_PROTOCOL, kind: 'capability-request', grantId: grant.grantId, runnerId: grant.runnerId,
    sequence: 1, requestId: 'request-1', operation: 'log.emit', arguments: { entry: { message: 'hi' } },
    deadline: new Date(Date.now() + 1000).toISOString(), idempotencyKey: 'idempotent-1',
  };
  assert.equal(vault.authorizeCapability(request), undefined);
  const recorded = vault.recordCapability(request, {
    protocol: AGENT_CONTROL_PROTOCOL, kind: 'capability-result', grantId: grant.grantId, requestId: request.requestId,
    sequence: request.sequence, ok: true, value: { accepted: true }, usage: { calls: 1, responseBytes: 17 },
  });
  assert.deepEqual(vault.authorizeCapability(request), recorded);
  assert.throws(() => vault.authorizeCapability({ ...request, requestId: 'request-gap', idempotencyKey: 'idempotent-gap', sequence: 3 }), /sequence mismatch/);
});

test('Vault Core renewals can only reduce authority and revocation is immediate', () => {
  const { vault, certificate, manifest, capabilities, grant } = setup();
  const reduced = [{ operation: 'log.emit', maxCalls: 1, maxResponseBytes: 512 }];
  const renewal = vault.renew(grant.grantId, reduced, new Date(Date.now() + 10_000).toISOString(), grant.maxOfflineMs - 1);
  assert.equal(renewal.capabilities[0].maxCalls, 1);
  assert.throws(() => vault.renew(grant.grantId, [{ ...capabilities[0], maxCalls: 3 }], renewal.expiresAt, renewal.maxOfflineMs), /expands/);
  vault.revoke(certificate.revocationId, 'test kill switch');
  assert.throws(() => vault.issueGrant({
    certificate, manifest, configDigest: contractDigest({}), policyDigest: contractDigest(capabilities), capabilities,
  }), /revoked/);
});

test('Vault Core fails closed after grant expiry', () => {
  const { vault, grant, advance } = setup();
  advance(6 * 60_000);
  assert.throws(() => vault.authorizeCapability({
    protocol: AGENT_CONTROL_PROTOCOL, kind: 'capability-request', grantId: grant.grantId, runnerId: grant.runnerId,
    sequence: 1, requestId: 'late', operation: 'log.emit', arguments: {},
    deadline: new Date(Date.now() + 1000).toISOString(), idempotencyKey: 'late',
  }), /expired/);
});
