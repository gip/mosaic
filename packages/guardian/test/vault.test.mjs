import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import {
  AGENT_ARTIFACT_PROTOCOL,
  AGENT_RUNTIME_VERSION,
  contractDigest,
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
  const certificate = vault.enrollRunner({ runnerId: 'runner:1', runnerPublicKey, runnerControlInboxId: 'runner-inbox', guardianControlInboxId: 'guardian-inbox', network: 'testnet', environment: 'local' });
  const manifest = {
    protocol: AGENT_ARTIFACT_PROTOCOL, packageName: 'agent-one', version: '1.0.0', sourceDigest: sha256Hex('agent'),
    capabilities: { required: [{ operation: 'log.emit', maxCalls: 2, maxResponseBytes: 1024, constraints: { maxEntryBytes: 1024 } }], optional: [] },
    resourceSlots: [],
    limits: { memoryBytes: 1024 * 1024, stackBytes: 64 * 1024, wallTimeMs: 1000, maxPendingJobs: 8, maxHookConcurrency: 1, maxHookResponseBytes: 4096 },
    minimumRuntimeVersion: AGENT_RUNTIME_VERSION,
  };
  const capabilities = structuredClone(manifest.capabilities.required);
  const grant = vault.issueGrant({
    agentId: 'agent-1', certificate, manifest, configDigest: contractDigest({}), policyDigest: contractDigest(capabilities), capabilities,
    artifactDigest: 'a'.repeat(64), policyRevision: 1, xmtpAddress: '0x0000000000000000000000000000000000000002', resources: [],
    limits: manifest.limits,
  });
  return { vault, certificate, manifest, capabilities, grant, advance: (ms) => { now += ms; } };
}

test('Vault Core binds certificates and grants to exact control inboxes', () => {
  const { certificate, grant } = setup();
  assert.equal(certificate.runnerControlInboxId, 'runner-inbox');
  assert.equal(certificate.guardianControlInboxId, 'guardian-inbox');
  assert.equal(grant.runnerControlInboxId, certificate.runnerControlInboxId);
  assert.equal(grant.guardianControlInboxId, certificate.guardianControlInboxId);
});

test('Vault Core issues a non-renewable 24-hour grant with no offline grace and revocation is immediate', () => {
  const { vault, certificate, manifest, capabilities, grant } = setup();
  assert.equal(Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt), 24 * 60 * 60_000);
  assert.equal(grant.maxOfflineMs, 0);
  vault.revoke(grant.agentId, certificate.revocationId, 'test kill switch');
  assert.throws(() => vault.issueGrant({
    agentId: 'agent-1', certificate, manifest, configDigest: contractDigest({}), policyDigest: contractDigest(capabilities), capabilities,
    artifactDigest: 'a'.repeat(64), policyRevision: 1, xmtpAddress: grant.xmtpAddress, resources: [],
    limits: manifest.limits,
  }), /revoked/);
});

test('Vault Core fails closed after grant expiry', () => {
  const { vault, grant, advance } = setup();
  advance(24 * 60 * 60_000 + 1);
  assert.throws(() => vault.getGrant(grant.grantId, grant.agentId), /expired/);
});

test('active authority expires at the fixed grant deadline and termination removes it immediately', () => {
  const first = setup();
  assert.equal(first.vault.hasActiveGrant('agent-1'), true);
  first.advance(24 * 60 * 60_000);
  assert.equal(first.vault.hasActiveGrant('agent-1'), true, 'the deadline is inclusive');
  first.advance(1);
  assert.equal(first.vault.hasActiveGrant('agent-1'), false);

  const second = setup();
  const audit = second.vault.recordTermination('agent-1', second.grant.grantId, 'immediate', 'kill switch');
  assert.match(audit, /^[0-9a-f]{64}$/);
  assert.equal(second.vault.hasActiveGrant('agent-1'), false);
});
