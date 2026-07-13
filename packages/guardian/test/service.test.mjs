import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import {
  AGENT_ARTIFACT_PROTOCOL, AGENT_CONTROL_PROTOCOL, AGENT_RUNTIME_VERSION, artifactDigest, contractDigest,
  generateKeyLeaseRecipient, openAgentKeyLease, sha256Hex,
} from '@mosaic/local-runtime';
import { openAgentSecretStore, openVaultData, sealVaultData, zoneRootCommitmentHex } from '@mosaic/zone-keys';
import { GuardianService, McpGuardianApi } from '../dist/index.js';

const rootAddress = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const secret = new Uint8Array(32).fill(7);
const commitment = zoneRootCommitmentHex(secret);

function zone(name) {
  return {
    zoneId: `${name}-id`, zone: name, commitment, mode: 'testnet-server',
    addresses: [
      { id: `${name}-evm-0`, chain: 'evm', index: 0, name: '#0' },
      { id: `${name}-xrpl-0`, chain: 'xrpl', index: 0, name: '#0' },
      { id: `${name}-stellar-0`, chain: 'stellar', index: 0, name: '#0' },
    ],
  };
}

class FakeApi {
  zones = [zone('mosaic-agent-guardian'), zone('mosaic-agent-runner')];
  blobs = new Map();
  creates = [];
  blobGets = 0;
  artifacts = new Map();

  async zoneList() { return this.zones; }
  async zoneGet(_token, zoneName) {
    const prefix = `${zoneName}:`;
    const blobs = [...this.blobs.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, value]) => ({ kind: value.kind, version: value.version }));
    return { exists: true, blobs };
  }
  async zoneAddressCreate(_token, zoneName, chain, name) {
    const item = this.zones.find(({ zone }) => zone === zoneName);
    const index = Math.max(...item.addresses.filter((entry) => entry.chain === chain).map(({ index }) => index)) + 1;
    const address = { id: `${zoneName}-${chain}-${index}`, chain, index, name };
    item.addresses.push(address);
    this.creates.push(address);
    return address;
  }
  async zoneTestnetUnlock() { return { commitment, zoneRootSecretB64: Buffer.from(secret).toString('base64') }; }
  async zoneUnlocked() {}
  async blobGet(_token, zoneName, kind) {
    this.blobGets += 1;
    const value = this.blobs.get(`${zoneName}:${kind}`);
    if (!value) { const error = new Error(`no ${kind} blob`); error.code = 'NOT_FOUND'; throw error; }
    return value;
  }
  async blobPut(args) {
    const current = this.blobs.get(`${args.zone}:${args.kind}`)?.version ?? 0;
    if (current !== args.expectedVersion) throw new Error('version conflict');
    const value = { kind: args.kind, version: current + 1, header: args.header, ciphertextB64: args.ciphertextB64, commitment };
    this.blobs.set(`${args.zone}:${args.kind}`, value);
    return { version: value.version };
  }
  async agentArtifactGet(_token, digest) {
    const artifact = this.artifacts.get(digest);
    if (!artifact) throw new Error('artifact not found');
    return artifact;
  }
}

function session() {
  return { token: 'token', chain: 'evm', address: rootAddress, network: 'testnet', expiresAt: Date.now() + 60_000 };
}

test('Guardian unlocks default vaults, allocates named addresses, and encrypts links', async () => {
  process.env.MOSAIC_XMTP_DISABLED = '1';
  const api = new FakeApi();
  const guardian = new GuardianService(api);
  guardian.attachSession(session());
  const guardianIdentity = await guardian.startGuardian('mosaic-agent-guardian', 'testnet');
  assert.equal(guardianIdentity.name, 'guardian');
  assert.equal(guardianIdentity.index, 1);

  assert.equal(api.creates.filter(({ name }) => name === 'guardian').length, 1);
  assert.equal(api.blobGets, 0, 'a missing optional data blob should be detected from vault metadata');

  const stored = api.blobs.get('mosaic-agent-guardian:data');
  const data = openVaultData(secret, {
    rootChain: 'evm', rootAddress, zone: 'mosaic-agent-guardian', network: 'testnet',
  }, { header: stored.header, ciphertext: new Uint8Array(Buffer.from(stored.ciphertextB64, 'base64')) });
  assert.equal(data.identities.guardian.address, guardianIdentity.address);
});

test('Guardian binds a signed manifest to a Runner certificate and execution grant', async () => {
  process.env.MOSAIC_XMTP_DISABLED = '1';
  const api = new FakeApi();
  const guardian = new GuardianService(api);
  guardian.attachSession(session());
  const identity = await guardian.startGuardian('mosaic-agent-guardian', 'testnet');
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  assert.throws(
    () => guardian.enrollRunner({ runnerId: 'local:test', runnerPublicKey: publicKey, network: 'testnet', environment: 'local' }),
    /not approved/,
  );
  guardian.approveRunner('local:test');
  const certificate = guardian.enrollRunner({ runnerId: 'local:test', runnerPublicKey: publicKey, network: 'testnet', environment: 'local' });
  // Approvals are single-use.
  assert.throws(
    () => guardian.enrollRunner({ runnerId: 'local:test', runnerPublicKey: publicKey, network: 'testnet', environment: 'local' }),
    /not approved/,
  );
  assert.equal(certificate.guardianAddress, identity.address);
  assert.equal('dbEncryptionKeyB64' in certificate, false);

  const source = `await mosaic.log.emit({message: 'hello'});`;
  const manifest = {
    protocol: AGENT_ARTIFACT_PROTOCOL, agentId: 'test', version: '1',
    sourceDigest: sha256Hex(source), requiredHooks: ['log.emit'],
    limits: { memoryBytes: 1024 * 1024, stackBytes: 64 * 1024, wallTimeMs: 1000, maxPendingJobs: 8, maxHookConcurrency: 1, maxHookResponseBytes: 4096 },
    minimumRuntimeVersion: AGENT_RUNTIME_VERSION,
  };
  const capabilities = [{ operation: 'log.emit', maxCalls: 2, maxResponseBytes: 1024 }];
  const grant = guardian.issueGrant({
    certificate, manifest, configDigest: contractDigest({}), policyDigest: contractDigest(capabilities), capabilities,
    artifactDigest: 'a'.repeat(64), policyRevision: 1, xmtpAddress: '0x0000000000000000000000000000000000000002', resources: [],
  });
  assert.equal(grant.runnerPublicKey, publicKey);
  assert.equal(grant.sourceDigest, manifest.sourceDigest);
  assert.equal('dbEncryptionKeyB64' in grant, false);

  const forbidden = { ...manifest, requiredHooks: ['websocket.connect'] };
  assert.throws(() => guardian.issueGrant({
    certificate, manifest: forbidden, configDigest: contractDigest({}), policyDigest: contractDigest({}),
    capabilities: [{ operation: 'websocket.connect', maxCalls: 1, maxResponseBytes: 1024 }],
    artifactDigest: 'b'.repeat(64), policyRevision: 1, xmtpAddress: grant.xmtpAddress, resources: [],
  }), /policy broker is not implemented/);
});

test('an unreadable data blob degrades to fresh data and is overwritten, never blocking unlock', async () => {
  process.env.MOSAIC_XMTP_DISABLED = '1';
  const api = new FakeApi();
  api.blobs.set('mosaic-agent-guardian:data', {
    kind: 'data', version: 5, commitment,
    header: { v: 1, schema: 'mosaic-vault-data', alg: 'xchacha20poly1305', nonce: Buffer.alloc(24, 9).toString('base64'), revision: 5 },
    ciphertextB64: Buffer.alloc(64, 1).toString('base64'),
  });
  const guardian = new GuardianService(api);
  guardian.attachSession(session());
  const identity = await guardian.startGuardian('mosaic-agent-guardian', 'testnet');
  const stored = api.blobs.get('mosaic-agent-guardian:data');
  assert.equal(stored.version, 6, 'save must overwrite the corrupt blob at the server version');
  const data = openVaultData(secret, {
    rootChain: 'evm', rootAddress, zone: 'mosaic-agent-guardian', network: 'testnet',
  }, { header: stored.header, ciphertext: new Uint8Array(Buffer.from(stored.ciphertextB64, 'base64')) });
  assert.equal(data.identities.guardian.address, identity.address);
});

test('a data version conflict rebases the update onto the latest server data', async () => {
  process.env.MOSAIC_XMTP_DISABLED = '1';
  const api = new FakeApi();
  const guardian = new GuardianService(api);
  guardian.attachSession(session());
  await guardian.startGuardian('mosaic-agent-guardian', 'testnet');
  const ref = { rootChain: 'evm', rootAddress, zone: 'mosaic-agent-guardian', network: 'testnet' };

  // Another Guardian instance writes a newer blob behind this one's back.
  const version = api.blobs.get('mosaic-agent-guardian:data').version + 1;
  const external = sealVaultData(secret, ref, { v: 1, extensions: { external: true } }, version);
  api.blobs.set('mosaic-agent-guardian:data', {
    kind: 'data', version, commitment,
    header: external.header, ciphertextB64: Buffer.from(external.ciphertext).toString('base64'),
  });

  const second = await guardian.ensureIdentity('mosaic-agent-guardian', 'second');
  const stored = api.blobs.get('mosaic-agent-guardian:data');
  assert.equal(stored.version, version + 1);
  const data = openVaultData(secret, ref, {
    header: stored.header, ciphertext: new Uint8Array(Buffer.from(stored.ciphertextB64, 'base64')),
  });
  assert.equal(data.extensions.external, true, 'rebase keeps the concurrent write');
  assert.equal(data.identities.second.address, second.address);
});

test('agent prepare persists encrypted communication keys, filters custody, and defaults transactions to denial', async () => {
  process.env.MOSAIC_XMTP_DISABLED = '1';
  const api = new FakeApi();
  const guardian = new GuardianService(api);
  guardian.attachSession(session());
  await guardian.startGuardian('mosaic-agent-guardian', 'testnet');
  await guardian.unlockVault('mosaic-agent-runner', 'testnet');
  await guardian.initializeAgentCommunicationKeys('mosaic-agent-runner');
  const transactionKey = new Uint8Array(32).fill(9);
  await guardian.importAgentSecret('mosaic-agent-runner', {
    keyId: 'transaction-primary', purpose: 'transaction-signing', algorithm: 'secp256k1', custody: 'guardian-only',
  }, transactionKey);

  const source = `await mosaic.runtime.waitUntilStopped();`;
  const manifest = {
    protocol: AGENT_ARTIFACT_PROTOCOL, agentId: 'mosaic-agent-runner', version: '1', sourceDigest: sha256Hex(source),
    requiredHooks: ['transaction.propose'],
    limits: { memoryBytes: 1024 * 1024, stackBytes: 64 * 1024, wallTimeMs: 60_000, maxPendingJobs: 8, maxHookConcurrency: 1, maxHookResponseBytes: 4096 },
    minimumRuntimeVersion: AGENT_RUNTIME_VERSION,
  };
  const digest = artifactDigest(manifest);
  api.artifacts.set(digest, { artifactDigest: digest, manifest, source });
  await guardian.putAgentPolicy('mosaic-agent-runner', {
    enabled: true, artifactDigest: digest,
    capabilities: [{ operation: 'transaction.propose', maxCalls: 1, maxResponseBytes: 4096 }],
    resources: [], keyIds: ['transaction-primary'],
  }, 0);

  const pair = generateKeyPairSync('ed25519');
  guardian.approveRunner('local-supervisor');
  const certificate = guardian.enrollRunner({
    runnerId: 'local-supervisor', runnerPublicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    network: 'testnet', environment: 'local',
  });
  const recipient = generateKeyLeaseRecipient();
  const prepared = await guardian.prepareAgent({
    agentId: 'mosaic-agent-runner', certificate, supervisorKeyLeasePublicKeyB64: recipient.publicKeyB64,
  });
  const lease = openAgentKeyLease(prepared.sealedKeyLease, recipient.privateKey);
  assert.deepEqual(lease.secrets.map(({ keyId }) => keyId).sort(), ['xmtp-database', 'xmtp-owner']);
  assert.equal(JSON.stringify(prepared).includes(Buffer.from(transactionKey).toString('base64')), false);
  const storedSecrets = api.blobs.get('mosaic-agent-runner:agent-secrets');
  assert.equal(storedSecrets.ciphertextB64.includes(Buffer.from(transactionKey).toString('base64')), false);
  const decrypted = openAgentSecretStore(secret, {
    rootChain: 'evm', rootAddress, zone: 'mosaic-agent-runner', network: 'testnet',
  }, { header: storedSecrets.header, ciphertext: new Uint8Array(Buffer.from(storedSecrets.ciphertextB64, 'base64')) });
  assert.equal(decrypted.secrets.find(({ keyId }) => keyId === 'transaction-primary').custody, 'guardian-only');

  const denied = guardian.proposeTransaction({
    protocol: AGENT_CONTROL_PROTOCOL, kind: 'transaction-proposal', agentId: 'mosaic-agent-runner',
    grantId: prepared.grant.grantId, runnerId: certificate.runnerId, sequence: 1, requestId: 'tx-1',
    keyId: 'transaction-primary', chain: 'evm', network: 'testnet', intentType: 'transfer', intent: { to: '0x1', amount: '1' },
    deadline: new Date(Date.now() + 10_000).toISOString(), idempotencyKey: 'tx-1',
  });
  assert.equal(denied.error.code, 'TRANSACTION_BROKER_UNAVAILABLE');
  guardian.lockAgent('mosaic-agent-runner');
  assert.deepEqual(guardian.status().unlockedVaults, ['mosaic-agent-guardian']);
});

test('MCP API reconnects once when the server has forgotten its transport session', async () => {
  let clients = 0;
  let staleClosed = false;
  const api = new McpGuardianApi('http://127.0.0.1:8788/mcp', async () => {
    clients += 1;
    if (clients === 1) {
      return {
        callTool: async () => { throw new Error('Streamable HTTP error: Bad Request: initialize first'); },
        close: async () => { staleClosed = true; },
      };
    }
    return {
      callTool: async () => ({ content: [{ type: 'text', text: '[]' }] }),
      close: async () => {},
    };
  });

  assert.deepEqual(await api.zoneList('token'), []);
  assert.equal(clients, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(staleClosed, true);
});
