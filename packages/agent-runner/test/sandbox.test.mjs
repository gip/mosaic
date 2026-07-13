import assert from 'node:assert/strict';
import test from 'node:test';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { AGENT_CONTROL_PROTOCOL, contractDigest, controlSignatureText, sha256Hex } from '@mosaic/local-runtime';
import { AgentSupervisor, sandboxEnvironment, verifyExecutionAuthorization } from '../dist/supervisor.js';

function grant(source, overrides = {}) {
  return {
    protocol: AGENT_CONTROL_PROTOCOL,
    kind: 'execution-grant',
    grantId: 'grant-test',
    runnerId: 'local:test',
    runnerPublicKey: 'runner-key',
    guardianId: 'guardian',
    guardianAddress: '0x0000000000000000000000000000000000000001',
    network: 'testnet',
    agentId: 'test',
    manifestDigest: '1'.repeat(64),
    sourceDigest: sha256Hex(source),
    configDigest: '2'.repeat(64),
    policyDigest: '3'.repeat(64),
    certificateDigest: '4'.repeat(64),
    capabilities: [
      { operation: 'log.emit', maxCalls: 10, maxResponseBytes: 4096 },
      { operation: 'clock.now', maxCalls: 10, maxResponseBytes: 4096 },
      { operation: 'state.get', maxCalls: 10, maxResponseBytes: 4096 },
      { operation: 'state.put', maxCalls: 10, maxResponseBytes: 4096 },
      { operation: 'state.compareAndSet', maxCalls: 10, maxResponseBytes: 4096 },
    ],
    limits: {
      memoryBytes: 8 * 1024 * 1024,
      stackBytes: 256 * 1024,
      wallTimeMs: 2_000,
      maxPendingJobs: 16,
      maxHookConcurrency: 2,
      maxHookResponseBytes: 4096,
    },
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    maxOfflineMs: 1000,
    sequence: 1,
    signatureB64: 'not-used-by-supervisor',
    ...overrides,
  };
}

test('sandbox enables Node mode only when hosted by Electron', () => {
  assert.deepEqual(sandboxEnvironment(undefined), { NODE_NO_WARNINGS: '1' });
  assert.deepEqual(sandboxEnvironment('43.1.0'), {
    NODE_NO_WARNINGS: '1',
    ELECTRON_RUN_AS_NODE: '1',
  });
  assert.equal('PATH' in sandboxEnvironment('43.1.0'), false);
});

test('QuickJS agent sees only typed hooks and namespaced state', async () => {
  const source = `
if (typeof process !== 'undefined' || typeof require !== 'undefined' || typeof fetch !== 'undefined') throw new Error('host authority leaked');
const first = await mosaic.state.put('counter', 1);
const updated = await mosaic.state.compareAndSet('counter', first.revision, 2);
const current = await mosaic.state.get('counter');
await mosaic.log.emit({ message: 'state complete', revision: current.revision, value: current.value, updated: updated.updated });
`;
  const result = await new AgentSupervisor().run(source, grant(source));
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.logs, [{ message: 'state complete', revision: 2, updated: true, value: 2 }]);
  assert.match(result.auditDigest, /^[0-9a-f]{64}$/);
});

test('source digest mismatch fails before a sandbox starts', async () => {
  const source = `await mosaic.log.emit({ message: 'no' });`;
  await assert.rejects(() => new AgentSupervisor().run(`${source} `, grant(source)), /does not match grant/);
});

test('QuickJS interrupts non-terminating agent code', async () => {
  const source = `for (;;) {}`;
  const limited = grant(source, { limits: { ...grant(source).limits, wallTimeMs: 100 } });
  await assert.rejects(() => new AgentSupervisor().run(source, limited), /interrupted|exited|status/i);
});

test('Runner pins Guardian identity and all authorization digests', () => {
  const keys = secp256k1.keygen();
  const publicKey = secp256k1.Point.fromBytes(keys.publicKey).toBytes(false);
  const guardianAddress = `0x${Buffer.from(keccak_256(publicKey.slice(1)).slice(-20)).toString('hex')}`;
  const source = 'agent';
  const certificate = signEnvelope({
    protocol: AGENT_CONTROL_PROTOCOL, kind: 'runner-certificate', runnerId: 'runner', runnerPublicKey: 'key',
    guardianId: 'guardian', guardianAddress, network: 'testnet', environment: 'remote',
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    revocationId: 'revoke', signatureB64: '',
  }, keys.secretKey);
  const authorization = signEnvelope({
    ...grant(source), runnerId: 'runner', runnerPublicKey: 'key', guardianId: 'guardian', guardianAddress,
    certificateDigest: contractDigest(certificate), signatureB64: '',
  }, keys.secretKey);
  assert.doesNotThrow(() => verifyExecutionAuthorization({
    certificate, grant: authorization, source, runnerId: 'runner', runnerPublicKey: 'key', expectedGuardianAddress: guardianAddress,
  }));
  assert.throws(() => verifyExecutionAuthorization({
    certificate, grant: authorization, source, runnerId: 'runner', runnerPublicKey: 'key',
    expectedGuardianAddress: '0x0000000000000000000000000000000000000001',
  }), /pinned discovery/);
  assert.throws(() => verifyExecutionAuthorization({
    certificate, grant: { ...authorization, sourceDigest: '0'.repeat(64) }, source, runnerId: 'runner', runnerPublicKey: 'key', expectedGuardianAddress: guardianAddress,
  }), /signer mismatch|source digest/);
});

function signEnvelope(message, secretKey) {
  const text = controlSignatureText(message);
  const bytes = utf8ToBytes(text);
  const digest = keccak_256(new Uint8Array([...utf8ToBytes(`\x19Ethereum Signed Message:\n${bytes.length}`), ...bytes]));
  const recovered = secp256k1.sign(digest, secretKey, { prehash: false, format: 'recovered' });
  return { ...message, signatureB64: Buffer.from([...recovered.slice(1), recovered[0] + 27]).toString('base64') };
}
