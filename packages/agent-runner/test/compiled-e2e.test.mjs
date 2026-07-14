import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildAgentProject, inspectAgentPackage } from '@mosaic/agent-compiler';
import { GuardianService } from '@mosaic/guardian';
import {
  AGENT_RUNTIME_VERSION,
  generateKeyLeaseRecipient,
} from '@mosaic/local-runtime';
import { zoneRootCommitmentHex } from '@mosaic/zone-keys';
import { MemoryStore } from '../../mcp/dist/store.js';
import { AgentSupervisor } from '../dist/supervisor.js';

const here = dirname(fileURLToPath(import.meta.url));
const rootAddress = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const zoneSecret = new Uint8Array(32).fill(0x37);
const commitment = zoneRootCommitmentHex(zoneSecret);
const owner = { chain: 'evm', address: rootAddress };

test('compiled TypeScript package installs through Guardian and runs as the exact prepared source in QuickJS', async () => {
  process.env.MOSAIC_XMTP_DISABLED = '1';
  const project = await createAgentProject();
  const store = new MemoryStore();
  const api = new InMemoryGuardianApi(store);
  try {
    const built = await buildAgentProject(project);
    const inspected = await inspectAgentPackage(built.outputPath);
    assert.equal(built.warnings.length, 0);
    assert.equal(inspected.artifactDigest, built.artifact.artifactDigest);

    assert.deepEqual(await store.putAgentArtifact({
      owner,
      network: 'testnet',
      artifactDigest: inspected.artifactDigest,
      manifest: inspected.manifest,
      source: Buffer.from(inspected.source, 'utf8'),
    }), { created: true });
    assert.deepEqual(await store.putAgentArtifact({
      owner,
      network: 'testnet',
      artifactDigest: inspected.artifactDigest,
      manifest: inspected.manifest,
      source: Buffer.from(inspected.source, 'utf8'),
    }), { created: false }, 'the uploaded artifact is immutable');

    const guardian = new GuardianService(api);
    guardian.attachSession({ token: 'e2e-token', chain: 'evm', address: rootAddress, network: 'testnet', expiresAt: Date.now() + 60_000 });
    await guardian.startGuardian('mosaic-agent-guardian', 'testnet');
    await guardian.unlockVault('compiled-agent-vault', 'testnet');
    const installation = await guardian.installAgent({
      agentId: 'compiled-agent-vault',
      artifactDigest: inspected.artifactDigest,
      capabilities: structuredClone(inspected.manifest.capabilities.required),
      resources: [],
      limits: structuredClone(inspected.manifest.limits),
      enabled: true,
      expectedRevision: 0,
    });
    assert.equal(installation.revision, 1);
    assert.equal(installation.packageName, 'compiled-e2e-agent');
    assert.equal(api.dataCiphertext('compiled-agent-vault').includes(inspected.artifactDigest), false, 'installation policy remains encrypted at rest');

    const runnerKeys = generateKeyPairSync('ed25519');
    guardian.approveRunner('compiled-e2e-runner');
    const certificate = guardian.enrollRunner({
      runnerId: 'compiled-e2e-runner',
      runnerPublicKey: runnerKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      runnerControlInboxId: 'runner-inbox',
      guardianControlInboxId: 'guardian-inbox',
      network: 'testnet',
      environment: 'local',
    });
    const leaseRecipient = generateKeyLeaseRecipient();
    const prepared = await guardian.prepareAgent({
      agentId: 'compiled-agent-vault',
      certificate,
      supervisorKeyLeasePublicKeyB64: leaseRecipient.publicKeyB64,
    });
    assert.equal(prepared.artifactTicket, 'f'.repeat(64));
    assert.equal('source' in prepared, false, 'XMTP execution packages never contain agent source');
    assert.equal(prepared.manifest.sourceDigest, inspected.manifest.sourceDigest);
    assert.equal(prepared.grant.artifactDigest, inspected.artifactDigest);
    assert.equal(JSON.stringify(inspected).includes(Buffer.from(zoneSecret).toString('base64')), false);
    assert.equal(JSON.stringify(prepared).includes(Buffer.from(zoneSecret).toString('base64')), false);

    const supervisor = new AgentSupervisor();
    const result = await supervisor.run(inspected.source, prepared.grant);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.logs, [{
      message: 'compiled TypeScript ran in QuickJS',
      revision: 1,
      value: 7,
      stateGranted: true,
      unknownResourceBound: false,
    }]);

    guardian.lockAgent(prepared.agentId, prepared.grant.grantId);
    assert.deepEqual(guardian.status().unlockedVaults, ['mosaic-agent-guardian']);
  } finally {
    await store.close();
    await rm(project, { recursive: true, force: true });
  }
});

class InMemoryGuardianApi {
  zones = [zone('mosaic-agent-guardian'), zone('compiled-agent-vault')];
  blobs = new Map();

  constructor(store) { this.store = store; }

  async zoneList() { return this.zones; }

  async zoneGet(_token, zoneName) {
    const prefix = `${zoneName}:`;
    return {
      exists: true,
      blobs: [...this.blobs.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, value]) => ({ kind: value.kind, version: value.version })),
    };
  }

  async zoneAddressCreate(_token, zoneName, chain, name) {
    const item = this.zones.find(({ zone: candidate }) => candidate === zoneName);
    const index = Math.max(...item.addresses.filter((address) => address.chain === chain).map((address) => address.index)) + 1;
    const address = { id: `${zoneName}-${chain}-${index}`, chain, index, name };
    item.addresses.push(address);
    return address;
  }

  async zoneTestnetUnlock() {
    return { commitment, zoneRootSecretB64: Buffer.from(zoneSecret).toString('base64') };
  }

  async zoneUnlocked() {}

  async blobGet(_token, zoneName, kind) {
    const value = this.blobs.get(`${zoneName}:${kind}`);
    if (value) return value;
    const error = new Error(`no ${kind} blob`);
    error.code = 'NOT_FOUND';
    throw error;
  }

  async blobPut(args) {
    const key = `${args.zone}:${args.kind}`;
    const current = this.blobs.get(key)?.version ?? 0;
    if (current !== args.expectedVersion) throw new Error('version conflict');
    const value = {
      kind: args.kind,
      version: current + 1,
      header: args.header,
      ciphertextB64: args.ciphertextB64,
      commitment,
    };
    this.blobs.set(key, value);
    return { version: value.version };
  }

  async agentArtifactGet(_token, artifactDigest) {
    const record = await this.store.getAgentArtifact(owner, 'testnet', artifactDigest);
    if (!record) throw new Error(`artifact not found: ${artifactDigest}`);
    return {
      artifactDigest: record.artifactDigest,
      manifest: record.manifest,
      source: Buffer.from(record.source).toString('utf8'),
    };
  }

  async agentArtifactTicketCreate() {
    return { ticket: 'f'.repeat(64), expiresAt: new Date(Date.now() + 300_000).toISOString(), maxReads: 3 };
  }

  dataCiphertext(zoneName) {
    return this.blobs.get(`${zoneName}:data`)?.ciphertextB64 ?? '';
  }
}

function zone(name) {
  return {
    zoneId: `${name}-id`,
    zone: name,
    commitment,
    mode: 'testnet-server',
    addresses: [
      { id: `${name}-evm-0`, chain: 'evm', index: 0, name: '#0' },
      { id: `${name}-xrpl-0`, chain: 'xrpl', index: 0, name: '#0' },
      { id: `${name}-stellar-0`, chain: 'stellar', index: 0, name: '#0' },
    ],
  };
}

async function createAgentProject() {
  const project = await mkdtemp(join(here, '.compiled-e2e-'));
  await mkdir(join(project, 'src'), { recursive: true });
  await writeFile(join(project, 'mosaic.agent.json'), JSON.stringify({
    packageName: 'compiled-e2e-agent',
    version: '1.0.0',
    entry: 'src/agent.ts',
    tsconfig: 'tsconfig.json',
    capabilities: {
      required: [
        { operation: 'state.put', maxCalls: 1, maxResponseBytes: 1024, constraints: { keyPrefixes: ['e2e:'], maxValueBytes: 1024 } },
        { operation: 'state.get', maxCalls: 1, maxResponseBytes: 1024, constraints: { keyPrefixes: ['e2e:'] } },
        { operation: 'log.emit', maxCalls: 1, maxResponseBytes: 1024, constraints: { maxEntryBytes: 4096 } },
      ],
      optional: [],
    },
    resourceSlots: [],
    limits: {
      memoryBytes: 8 * 1024 * 1024,
      stackBytes: 256 * 1024,
      wallTimeMs: 10_000,
      maxPendingJobs: 16,
      maxHookConcurrency: 2,
      maxHookResponseBytes: 4096,
      maxEventBytes: 4096,
    },
    minimumRuntimeVersion: AGENT_RUNTIME_VERSION,
  }));
  await writeFile(join(project, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      noEmit: true,
      lib: ['ES2022'],
    },
    include: ['src/**/*.ts'],
  }));
  await writeFile(join(project, 'src', 'agent.ts'), `
import { defineAgent } from '@mosaic/agent-sdk';

export default defineAgent(async (mosaic) => {
  const written = await mosaic.state.put('e2e:counter', 7);
  const current = await mosaic.state.get<number>('e2e:counter');
  await mosaic.log.emit({
    message: 'compiled TypeScript ran in QuickJS',
    revision: written.revision,
    value: current.value,
    stateGranted: mosaic.capabilities.has('state.put'),
    unknownResourceBound: mosaic.resources.has('not-bound'),
  });
});
`);
  return project;
}
