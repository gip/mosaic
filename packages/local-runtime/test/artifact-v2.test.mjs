import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_ARTIFACT_PROTOCOL,
  AGENT_PACKAGE_PROTOCOL,
  AGENT_RUNTIME_VERSION,
  MAX_AGENT_PACKAGE_BYTES,
  artifactDigest,
  assertArtifactManifest,
  assertArtifactPackage,
  assertCanonicalAgentSource,
  assertInstallationPolicy,
  sha256Hex,
  validateOperationArguments,
} from '../dist/index.js';

const limits = {
  memoryBytes: 8 * 1024 * 1024,
  stackBytes: 256 * 1024,
  wallTimeMs: 60_000,
  maxPendingJobs: 16,
  maxHookConcurrency: 2,
  maxHookResponseBytes: 4096,
  maxEventBytes: 4096,
};

function manifest(source = 'await mosaic.runtime.waitUntilStopped();\n') {
  return {
    protocol: AGENT_ARTIFACT_PROTOCOL,
    packageName: 'golden-agent',
    version: '1.2.3',
    sourceDigest: sha256Hex(source),
    capabilities: {
      required: [{ operation: 'log.emit', maxCalls: 10, maxResponseBytes: 1024, constraints: { maxEntryBytes: 2048 } }],
      optional: [
        { operation: 'state.put', maxCalls: 5, maxResponseBytes: 1024, constraints: { keyPrefixes: ['agent:'], maxValueBytes: 4096 } },
        { operation: 'xmtp.send', maxCalls: 4, maxResponseBytes: 1024, constraints: { resourceSlots: ['operator'], maxMessageBytes: 4096 } },
      ],
    },
    resourceSlots: [{ slotId: 'operator', kind: 'xmtp-contact', label: 'Operator', required: true }],
    limits,
    minimumRuntimeVersion: AGENT_RUNTIME_VERSION,
  };
}

test('V2 artifact and package digest vector is stable and detects tampering', () => {
  const source = 'await mosaic.runtime.waitUntilStopped();\n';
  const value = manifest(source);
  assert.equal(artifactDigest(value), '98022a4e72cfb4108a748a7c4b9e71e7fb3c367d067cf1aab45e8c09c33a9227');
  const pkg = { protocol: AGENT_PACKAGE_PROTOCOL, manifest: value, source, artifactDigest: artifactDigest(value) };
  assert.doesNotThrow(() => assertArtifactPackage(pkg));
  assert.throws(() => assertArtifactPackage({ ...pkg, source: `${source} ` }), /source digest mismatch/);
  assert.equal(MAX_AGENT_PACKAGE_BYTES, 4_521_984);
});

test('V2 manifests reject hidden fields, duplicate and unavailable authority', () => {
  const value = manifest();
  assert.doesNotThrow(() => assertArtifactManifest(value));
  assert.throws(() => assertArtifactManifest({ ...value, agentId: 'vault-bound' }), /unknown field: agentId/);
  assert.throws(() => assertArtifactManifest({
    ...value,
    capabilities: { required: value.capabilities.required, optional: [structuredClone(value.capabilities.required[0])] },
  }), /duplicate capabilities/);
  assert.throws(() => assertArtifactManifest({
    ...value,
    capabilities: { required: [{ operation: 'transaction.propose', maxCalls: 1, maxResponseBytes: 10 }], optional: [] },
  }), /policy broker is not implemented/);
});

test('installation validation requires requested authority and exact constraints while allowing quota reduction', () => {
  const value = manifest();
  const installation = {
    v: 2,
    revision: 1,
    enabled: true,
    packageName: value.packageName,
    artifactDigest: artifactDigest(value),
    capabilities: [{ ...structuredClone(value.capabilities.required[0]), maxCalls: 3 }],
    resources: [{ kind: 'xmtp-contact', resourceId: 'operator', label: 'Operator', peerAddress: '0xabc', environment: 'dev' }],
    limits: { ...limits, wallTimeMs: 30_000 },
  };
  assert.doesNotThrow(() => assertInstallationPolicy(value, installation, 'testnet'));
  assert.throws(() => assertInstallationPolicy(value, { ...installation, capabilities: [] }, 'testnet'), /missing required capability/);
  assert.throws(() => assertInstallationPolicy(value, {
    ...installation,
    capabilities: [{ ...installation.capabilities[0], constraints: { maxEntryBytes: 1024 } }],
  }, 'testnet'), /changes log.emit constraints/);
  assert.throws(() => assertInstallationPolicy(value, {
    ...installation,
    capabilities: [{ ...installation.capabilities[0], maxCalls: 11 }],
  }, 'testnet'), /expands log.emit/);
  assert.throws(() => assertInstallationPolicy(value, installation, 'mainnet'), /environment mismatch/);
});

test('shared operation validator accepts every grantable operation and fails closed', () => {
  const resources = [{ kind: 'xmtp-contact', resourceId: 'operator', label: 'Operator', peerAddress: '0xabc', environment: 'dev' }];
  const accepted = [
    ['state.get', { key: 'agent:key' }, { operation: 'state.get', maxCalls: 1, maxResponseBytes: 10, constraints: { keyPrefixes: ['agent:'] } }],
    ['state.put', { key: 'agent:key', value: { ok: true } }, { operation: 'state.put', maxCalls: 1, maxResponseBytes: 10, constraints: { keyPrefixes: ['agent:'], maxValueBytes: 100 } }],
    ['state.compareAndSet', { key: 'agent:key', expectedRevision: 0, value: null }, { operation: 'state.compareAndSet', maxCalls: 1, maxResponseBytes: 10, constraints: { keyPrefixes: ['agent:'], maxValueBytes: 100 } }],
    ['log.emit', { entry: { message: 'ok' } }, { operation: 'log.emit', maxCalls: 1, maxResponseBytes: 10, constraints: { maxEntryBytes: 100 } }],
    ['clock.now', {}, { operation: 'clock.now', maxCalls: 1, maxResponseBytes: 100 }],
    ['random.bytes', { length: 16 }, { operation: 'random.bytes', maxCalls: 1, maxResponseBytes: 100, constraints: { maxBytes: 16 } }],
    ['xmtp.send', { resourceId: 'operator', text: 'hello' }, { operation: 'xmtp.send', maxCalls: 1, maxResponseBytes: 100, constraints: { resourceSlots: ['operator'], maxMessageBytes: 100 } }],
    ['xmtp.receive', {}, { operation: 'xmtp.receive', maxCalls: 1, maxResponseBytes: 100, constraints: { resourceSlots: ['operator'] } }],
  ];
  for (const [operation, args, allowance] of accepted) {
    assert.doesNotThrow(() => validateOperationArguments(operation, args, allowance, limits, resources), operation);
  }
  assert.throws(() => validateOperationArguments('state.get', { key: 'other:key' }, accepted[0][2], limits, resources), /outside its allowed prefixes/);
  assert.throws(() => validateOperationArguments('xmtp.send', { resourceId: 'missing', text: 'hello' }, accepted[6][2], limits, resources), /not permitted/);
  assert.throws(() => validateOperationArguments('clock.now', { surprise: true }, accepted[4][2], limits, resources), /unexpected fields/);
});

test('canonical source uses UTF-8 bytes, LF, and rejects every other C0 control', () => {
  assert.doesNotThrow(() => assertCanonicalAgentSource('const message = "é";\n'));
  assert.throws(() => assertCanonicalAgentSource('const x = 1;\r\n'), /control characters/);
  assert.throws(() => assertCanonicalAgentSource('const\tx = 1;\n'), /control characters/);
});
