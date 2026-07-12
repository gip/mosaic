import { createHash } from 'node:crypto';

export type ServiceName = 'mosaic-guardian' | 'agent-runner';
export type ServicePhase =
  | 'starting' | 'awaiting-wallet' | 'authenticating' | 'unlocking' | 'connecting'
  | 'running' | 'stopping' | 'stopped' | 'failed';
export type MosaicNetwork = 'testnet' | 'mainnet';

export const DEFAULT_GUARDIAN_VAULT = 'mosaic-agent-guardian';
export const DEFAULT_RUNNER_VAULT = 'mosaic-agent-runner';

export interface ServiceStatus {
  name: ServiceName;
  phase: ServicePhase;
  pid?: number;
  detail?: string;
  vault?: string;
  network?: MosaicNetwork;
  evmAddress?: string;
  xmtpAddress?: string;
}

export type ServiceMessage =
  | { type: 'ready'; service: ServiceName; pid: number; vault?: string; network?: MosaicNetwork }
  | { type: 'status'; status: ServiceStatus }
  | { type: 'stopping'; service: ServiceName };

export interface LocalCliOptions { vault: string; network: MosaicNetwork; help: boolean }

export function parseLocalCli(argv: string[], defaultVault: string): LocalCliOptions {
  let vault: string | undefined;
  let network: MosaicNetwork = 'testnet';
  let help = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--help' || arg === '-h') { help = true; continue; }
    if (arg === '--network') {
      const value = argv[++index];
      if (value !== 'testnet' && value !== 'mainnet') throw new Error('--network must be testnet or mainnet');
      network = value;
      continue;
    }
    if (arg.startsWith('--network=')) {
      const value = arg.slice('--network='.length);
      if (value !== 'testnet' && value !== 'mainnet') throw new Error('--network must be testnet or mainnet');
      network = value;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    if (vault !== undefined) throw new Error('only one vault name may be provided');
    vault = arg;
  }
  const resolvedVault = vault?.trim() || defaultVault;
  if (resolvedVault.length > 64) throw new Error('vault name must be at most 64 characters');
  return { vault: resolvedVault, network, help };
}

/** Versioned application protocol. XMTP is transport, never lease authority. */
export const AGENT_CONTROL_PROTOCOL = 'MOSAIC_AGENT_CONTROL_V1' as const;
export const AGENT_RUNTIME_VERSION = '1.0.0' as const;
export const DEFAULT_GRANT_TTL_MS = 5 * 60_000;
export const DEFAULT_OFFLINE_GRACE_MS = 15_000;

export type DigestHex = string;
export type CapabilityOperation =
  | 'state.get' | 'state.put' | 'state.compareAndSet'
  | 'llm.complete'
  | 'xmtp.receive' | 'xmtp.send'
  | 'websocket.connect' | 'websocket.send' | 'websocket.receive'
  | 'transaction.propose'
  | 'log.emit' | 'clock.now' | 'random.bytes' | 'schedule.once';

export interface CapabilityAllowance {
  operation: CapabilityOperation;
  maxCalls: number;
  maxResponseBytes: number;
  constraints?: Record<string, unknown>;
}

export interface AgentResourceLimits {
  memoryBytes: number;
  stackBytes: number;
  wallTimeMs: number;
  maxPendingJobs: number;
  maxHookConcurrency: number;
  maxHookResponseBytes: number;
}

export interface RunnerCertificate {
  protocol: typeof AGENT_CONTROL_PROTOCOL;
  kind: 'runner-certificate';
  runnerId: string;
  runnerPublicKey: string;
  guardianId: string;
  guardianAddress: string;
  network: MosaicNetwork;
  environment: 'local' | 'remote';
  issuedAt: string;
  expiresAt: string;
  revocationId: string;
  signatureB64: string;
}

export interface AgentManifest {
  protocol: typeof AGENT_CONTROL_PROTOCOL;
  kind: 'agent-manifest';
  agentId: string;
  version: string;
  sourceDigest: DigestHex;
  requiredHooks: CapabilityOperation[];
  limits: AgentResourceLimits;
  minimumRuntimeVersion: string;
  publisher: string;
  publisherSignatureB64: string;
}

export interface ExecutionGrant {
  protocol: typeof AGENT_CONTROL_PROTOCOL;
  kind: 'execution-grant';
  grantId: string;
  runnerId: string;
  runnerPublicKey: string;
  guardianId: string;
  guardianAddress: string;
  network: MosaicNetwork;
  agentId: string;
  manifestDigest: DigestHex;
  sourceDigest: DigestHex;
  configDigest: DigestHex;
  policyDigest: DigestHex;
  certificateDigest: DigestHex;
  capabilities: CapabilityAllowance[];
  limits: AgentResourceLimits;
  issuedAt: string;
  expiresAt: string;
  maxOfflineMs: number;
  sequence: number;
  signatureB64: string;
}

export interface CapabilityRequest {
  protocol: typeof AGENT_CONTROL_PROTOCOL;
  kind: 'capability-request';
  grantId: string;
  runnerId: string;
  sequence: number;
  requestId: string;
  operation: CapabilityOperation;
  arguments: Record<string, unknown>;
  deadline: string;
  idempotencyKey: string;
}

export interface CapabilityUsage {
  calls: number;
  responseBytes: number;
}

export interface CapabilityResult {
  protocol: typeof AGENT_CONTROL_PROTOCOL;
  kind: 'capability-result';
  grantId: string;
  requestId: string;
  sequence: number;
  ok: boolean;
  value?: unknown;
  error?: { code: string; message: string };
  usage: CapabilityUsage;
  auditEventDigest: DigestHex;
}

export interface LeaseRenewal {
  protocol: typeof AGENT_CONTROL_PROTOCOL;
  kind: 'lease-renewal';
  grantId: string;
  sequence: number;
  capabilities: CapabilityAllowance[];
  expiresAt: string;
  maxOfflineMs: number;
  signatureB64: string;
}

export interface Revocation {
  protocol: typeof AGENT_CONTROL_PROTOCOL;
  kind: 'revocation';
  revocationId: string;
  sequence: number;
  issuedAt: string;
  reason: string;
  signatureB64: string;
}

export type SignedAgentControlMessage = RunnerCertificate | ExecutionGrant | LeaseRenewal | Revocation;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON rejects non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') throw new Error(`canonical JSON rejects ${typeof value}`);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function sha256Hex(value: string | Uint8Array): DigestHex {
  return createHash('sha256').update(value).digest('hex');
}

export function contractDigest(value: unknown): DigestHex {
  return sha256Hex(canonicalJson(value));
}

export function unsignedControlMessage(message: SignedAgentControlMessage): Omit<SignedAgentControlMessage, 'signatureB64'> {
  const { signatureB64: _signature, ...unsigned } = message;
  return unsigned as Omit<SignedAgentControlMessage, 'signatureB64'>;
}

export function controlSignatureText(message: SignedAgentControlMessage): string {
  return `${AGENT_CONTROL_PROTOCOL}:${message.kind}\n${canonicalJson(unsignedControlMessage(message))}`;
}

export function manifestSignatureText(manifest: AgentManifest): string {
  const { publisherSignatureB64: _signature, ...unsigned } = manifest;
  return `${AGENT_CONTROL_PROTOCOL}:${manifest.kind}\n${canonicalJson(unsigned)}`;
}

export function assertDigestHex(value: string, label = 'digest'): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be lowercase SHA-256 hex`);
}

export function assertActiveWindow(issuedAt: string, expiresAt: string, now = Date.now()): void {
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) throw new Error('invalid authorization window');
  if (issued > now + 30_000) throw new Error('authorization is not active yet');
  if (expires <= now) throw new Error('authorization is expired');
}

export function assertManifest(manifest: AgentManifest): void {
  if (manifest.protocol !== AGENT_CONTROL_PROTOCOL || manifest.kind !== 'agent-manifest') throw new Error('unsupported agent manifest');
  if (!manifest.agentId || !manifest.version || !manifest.publisher) throw new Error('agent manifest identity is incomplete');
  assertDigestHex(manifest.sourceDigest, 'sourceDigest');
  if (manifest.minimumRuntimeVersion !== AGENT_RUNTIME_VERSION) throw new Error('agent runtime version is incompatible');
  if (new Set(manifest.requiredHooks).size !== manifest.requiredHooks.length) throw new Error('agent manifest has duplicate hooks');
  assertResourceLimits(manifest.limits);
}

export function assertResourceLimits(limits: AgentResourceLimits): void {
  const integers = Object.values(limits);
  if (integers.some((value) => !Number.isSafeInteger(value) || value <= 0)) throw new Error('resource limits must be positive integers');
  if (limits.memoryBytes > 256 * 1024 * 1024) throw new Error('agent memory limit exceeds maximum');
  if (limits.wallTimeMs > 60 * 60_000) throw new Error('agent wall-time limit exceeds maximum');
  if (limits.maxHookConcurrency > 32) throw new Error('hook concurrency exceeds maximum');
}

export function assertCapabilitySubset(next: CapabilityAllowance[], previous: CapabilityAllowance[]): void {
  const allowed = new Map(previous.map((item) => [item.operation, item]));
  for (const item of next) {
    const prior = allowed.get(item.operation);
    if (!prior || item.maxCalls > prior.maxCalls || item.maxResponseBytes > prior.maxResponseBytes) {
      throw new Error(`lease renewal expands ${item.operation}`);
    }
    if (canonicalJson(item.constraints ?? {}) !== canonicalJson(prior.constraints ?? {})) {
      throw new Error(`lease renewal changes ${item.operation} constraints`);
    }
  }
}
