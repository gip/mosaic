import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { AGENT_CONTROL_PROTOCOL, AGENT_RUNTIME_VERSION, contractDigest, manifestSignatureText, sha256Hex } from '@mosaic/local-runtime';
import { openVaultData, sealVaultData, zoneRootCommitmentHex } from '@mosaic/zone-keys';
import { GuardianService, McpGuardianApi, assertXmtpSignatureText } from '../dist/index.js';

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
  const unsignedManifest = {
    protocol: AGENT_CONTROL_PROTOCOL, kind: 'agent-manifest', agentId: 'test', version: '1',
    sourceDigest: sha256Hex(source), requiredHooks: ['log.emit'],
    limits: { memoryBytes: 1024 * 1024, stackBytes: 64 * 1024, wallTimeMs: 1000, maxPendingJobs: 8, maxHookConcurrency: 1, maxHookResponseBytes: 4096 },
    minimumRuntimeVersion: AGENT_RUNTIME_VERSION, publisher: 'local:test', publisherSignatureB64: '',
  };
  const manifest = { ...unsignedManifest, publisherSignatureB64: sign(null, Buffer.from(manifestSignatureText(unsignedManifest)), pair.privateKey).toString('base64') };
  const capabilities = [{ operation: 'log.emit', maxCalls: 2, maxResponseBytes: 1024 }];
  const grant = guardian.issueGrant({ certificate, manifest, configDigest: contractDigest({}), policyDigest: contractDigest(capabilities), capabilities });
  assert.equal(grant.runnerPublicKey, publicKey);
  assert.equal(grant.sourceDigest, manifest.sourceDigest);
  assert.equal('dbEncryptionKeyB64' in grant, false);

  const forbidden = { ...manifest, requiredHooks: ['xmtp.send'], publisherSignatureB64: '' };
  forbidden.publisherSignatureB64 = sign(null, Buffer.from(manifestSignatureText(forbidden)), pair.privateKey).toString('base64');
  assert.throws(() => guardian.issueGrant({
    certificate, manifest: forbidden, configDigest: contractDigest({}), policyDigest: contractDigest({}),
    capabilities: [{ operation: 'xmtp.send', maxCalls: 1, maxResponseBytes: 1024, constraints: { recipients: ['0x1'] } }],
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

test('remote signer accepts only XMTP identity challenge text', () => {
  assert.doesNotThrow(() => assertXmtpSignatureText('XMTP : Create Identity\nabc\n\nFor more info: https://xmtp.org/signatures/'));
  assert.doesNotThrow(() => assertXmtpSignatureText(
    'XMTP : Authenticate to inbox\n\nInbox ID: abc\nCurrent time: 2026-07-13T01:32:36Z\n\n- Create inbox\n  (Owner: 0xabc)\n\nFor more info: https://xmtp.org/signatures',
  ));
  assert.throws(() => assertXmtpSignatureText('send 1 ETH to attacker'), /non-XMTP/);
  assert.throws(
    () => assertXmtpSignatureText('XMTP : Authenticate to inbox\nmalicious text'),
    /non-XMTP/,
  );
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
