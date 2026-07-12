import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  AGENT_CONTROL_PROTOCOL,
  AGENT_RUNTIME_VERSION,
  DEFAULT_RUNNER_VAULT,
  callGuardianControl,
  canonicalJson,
  contractDigest,
  manifestSignatureText,
  mosaicRuntimeDirectory,
  parseLocalCli,
  runLocalService,
  sha256Hex,
  type AgentManifest,
  type CapabilityAllowance,
  type ExecutionGrant,
  type RunnerCertificate,
  type ServiceStatus,
} from '@mosaic/local-runtime';
import { AgentSupervisor, verifyExecutionAuthorization } from './supervisor.js';

const options = parseLocalCli(process.argv.slice(2), DEFAULT_RUNNER_VAULT);
if (options.help) {
  console.log('Usage: mosaic-agent-runner [agent-id] [--network testnet|mainnet]');
  process.exit(0);
}
console.log(`Mosaic Agent Runner · agent ${options.vault} · ${options.network}`);

if (process.env.MOSAIC_CONTROL_DISABLED !== '1') {
  await startAuthorizedAgent();
} else {
  console.log('Waiting for Mosaic Guardian…');
}
runLocalService('agent-runner', { vault: options.vault, network: options.network });

async function startAuthorizedAgent(): Promise<void> {
  const status = await callGuardianControl<ServiceStatus>('status');
  if (status.phase !== 'running' || !status.xmtpAddress) throw new Error(`Mosaic Guardian is ${status.phase}; unlock it before starting an agent`);

  const device = await loadOrCreateDeviceKey(options.vault);
  const runnerId = `local:${options.vault}`;
  const certificate = await callGuardianControl<RunnerCertificate>('runner.enroll', {
    runnerId,
    runnerPublicKey: device.publicKeyB64,
    network: options.network,
    environment: 'local',
  });

  const source = await loadSource();
  const capabilities: CapabilityAllowance[] = [
    { operation: 'log.emit', maxCalls: 100, maxResponseBytes: 4_096 },
    { operation: 'clock.now', maxCalls: 100, maxResponseBytes: 4_096 },
    { operation: 'state.get', maxCalls: 100, maxResponseBytes: 64 * 1024 },
    { operation: 'state.put', maxCalls: 100, maxResponseBytes: 64 * 1024 },
    { operation: 'state.compareAndSet', maxCalls: 100, maxResponseBytes: 64 * 1024 },
    { operation: 'random.bytes', maxCalls: 32, maxResponseBytes: 4_096 },
  ];
  const manifest = signManifest({
    protocol: AGENT_CONTROL_PROTOCOL,
    kind: 'agent-manifest',
    agentId: options.vault,
    version: '0.0.1',
    sourceDigest: sha256Hex(source),
    requiredHooks: capabilities.map(({ operation }) => operation),
    limits: {
      memoryBytes: 32 * 1024 * 1024,
      stackBytes: 512 * 1024,
      wallTimeMs: 30_000,
      maxPendingJobs: 128,
      maxHookConcurrency: 4,
      maxHookResponseBytes: 64 * 1024,
    },
    minimumRuntimeVersion: AGENT_RUNTIME_VERSION,
    publisher: runnerId,
    publisherSignatureB64: '',
  }, device.privateKeyB64);
  const configDigest = contractDigest({ v: 1, agentId: options.vault });
  const policyDigest = contractDigest({ v: 1, capabilities });
  const grant = await callGuardianControl<ExecutionGrant>('grant.issue', {
    certificate,
    manifest,
    configDigest,
    policyDigest,
    capabilities,
  }, 30_000);
  verifyExecutionAuthorization({
    certificate,
    grant,
    source,
    runnerId,
    runnerPublicKey: device.publicKeyB64,
    expectedGuardianAddress: status.xmtpAddress,
  });
  if (grant.manifestDigest !== contractDigest(manifest) || grant.configDigest !== configDigest || grant.policyDigest !== policyDigest) {
    throw new Error('Guardian grant digest mismatch');
  }
  console.log(`Authorized grant ${grant.grantId} from ${grant.guardianAddress}`);
  const result = await new AgentSupervisor().run(source, grant);
  console.log(`Agent completed · audit ${result.auditDigest} · ${result.logs.length} log event(s)`);
}

async function loadSource(): Promise<string> {
  const sourcePath = process.env.MOSAIC_AGENT_SOURCE_FILE;
  if (sourcePath) return readFile(sourcePath, 'utf8');
  return `
await mosaic.log.emit({ level: 'info', message: 'Mosaic sandbox started' });
const startedAt = await mosaic.clock.now();
const stored = await mosaic.state.put('startedAt', startedAt);
const readBack = await mosaic.state.get('startedAt');
await mosaic.log.emit({ level: 'info', message: 'State hook verified', revision: readBack.revision, storedRevision: stored.revision });
`;
}

interface DeviceKeyFile { publicKeyB64: string; privateKeyB64: string }

async function loadOrCreateDeviceKey(agentId: string): Promise<DeviceKeyFile> {
  const directory = `${mosaicRuntimeDirectory()}/runner-keys`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const safeId = agentId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${directory}/${safeId}.json`;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as DeviceKeyFile;
    if (!parsed.publicKeyB64 || !parsed.privateKeyB64) throw new Error('incomplete key file');
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const pair = generateKeyPairSync('ed25519');
  const created = {
    publicKeyB64: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKeyB64: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
  await writeFile(path, `${canonicalJson(created)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return created;
}

function signManifest(manifest: AgentManifest, privateKeyB64: string): AgentManifest {
  const privateKey = createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  const signature = sign(null, Buffer.from(manifestSignatureText(manifest)), privateKey);
  return { ...manifest, publisherSignatureB64: signature.toString('base64') };
}
