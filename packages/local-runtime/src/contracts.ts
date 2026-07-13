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
export const AGENT_CONTROL_PROTOCOL = 'MOSAIC_AGENT_CONTROL_V2' as const;
export const AGENT_RUNTIME_VERSION = '2.0.0' as const;
export const AGENT_ARTIFACT_PROTOCOL = 'MOSAIC_AGENT_ARTIFACT_V1' as const;
export const DEFAULT_GRANT_TTL_MS = 60_000;
export const DEFAULT_OFFLINE_GRACE_MS = 15_000;

export type DigestHex = string;
export type CapabilityOperation =
  | 'state.get' | 'state.put' | 'state.compareAndSet'
  | 'llm.complete'
  | 'xmtp.receive' | 'xmtp.send'
  | 'websocket.connect' | 'websocket.send' | 'websocket.receive' | 'websocket.close'
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
  maxEventQueue?: number;
  maxEventConcurrency?: number;
  maxEventBytes?: number;
}

export interface XmtpResourceDescriptor {
  kind: 'xmtp-contact';
  resourceId: string;
  label: string;
  peerAddress: string;
  environment: 'dev' | 'production';
}

export interface WssResourceDescriptor {
  kind: 'wss-endpoint';
  resourceId: string;
  label: string;
  url: string;
  subprotocols: string[];
}

export type AgentResourceDescriptor = XmtpResourceDescriptor | WssResourceDescriptor;

export interface AgentArtifactManifest {
  protocol: typeof AGENT_ARTIFACT_PROTOCOL;
  agentId: string;
  version: string;
  sourceDigest: DigestHex;
  requiredHooks: CapabilityOperation[];
  limits: AgentResourceLimits;
  minimumRuntimeVersion: string;
}

export interface AgentPolicyV1 {
  v: 1;
  revision: number;
  enabled: boolean;
  artifactDigest: DigestHex;
  capabilities: CapabilityAllowance[];
  resources: AgentResourceDescriptor[];
  keyIds: string[];
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
  trustTier: 'software-local';
  issuedAt: string;
  expiresAt: string;
  revocationId: string;
  signatureB64: string;
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
  trustTier: 'software-local';
  artifactDigest: DigestHex;
  policyRevision: number;
  xmtpAddress: string;
  resources: AgentResourceDescriptor[];
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
  agentId: string;
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
  agentId: string;
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
  agentId: string;
  sequence: number;
  capabilities: CapabilityAllowance[];
  resources: AgentResourceDescriptor[];
  expiresAt: string;
  maxOfflineMs: number;
  signatureB64: string;
}

export interface Revocation {
  protocol: typeof AGENT_CONTROL_PROTOCOL;
  kind: 'revocation';
  revocationId: string;
  agentId: string;
  sequence: number;
  issuedAt: string;
  reason: string;
  signatureB64: string;
}

export type SignedAgentControlMessage = RunnerCertificate | ExecutionGrant | LeaseRenewal | Revocation;

export interface AgentExecutionPackage {
  agentId: string;
  manifest: AgentArtifactManifest;
  source: string;
  grant: ExecutionGrant;
  sealedKeyLease: SealedAgentKeyLease;
}

export interface AgentRuntimeEvent {
  protocol: typeof AGENT_CONTROL_PROTOCOL;
  type: 'runtime-event';
  agentId: string;
  grantId: string;
  eventId: string;
  eventType: 'xmtp.message' | 'websocket.message' | 'runtime.stopping';
  resourceId?: string;
  messageId?: string;
  sentAt: string;
  payload: unknown;
}

export interface AgentEventAck {
  protocol: typeof AGENT_CONTROL_PROTOCOL;
  type: 'event-ack';
  agentId: string;
  grantId: string;
  eventId: string;
  ok: boolean;
  error?: string;
}

export interface TransactionProposal {
  protocol: typeof AGENT_CONTROL_PROTOCOL;
  kind: 'transaction-proposal';
  agentId: string;
  grantId: string;
  runnerId: string;
  sequence: number;
  requestId: string;
  keyId: string;
  chain: 'evm' | 'xrpl' | 'stellar';
  network: MosaicNetwork;
  intentType: string;
  intent: Record<string, unknown>;
  deadline: string;
  idempotencyKey: string;
}

export interface TransactionResult {
  protocol: typeof AGENT_CONTROL_PROTOCOL;
  kind: 'transaction-result';
  agentId: string;
  grantId: string;
  requestId: string;
  ok: false;
  error: { code: 'TRANSACTION_BROKER_UNAVAILABLE' | 'INVALID_TRANSACTION_PROPOSAL'; message: string };
  auditEventDigest: DigestHex;
}

export interface AgentKeyLeasePayload {
  protocol: typeof AGENT_CONTROL_PROTOCOL;
  agentId: string;
  grantId: string;
  runnerId: string;
  certificateDigest: DigestHex;
  network: MosaicNetwork;
  expiresAt: string;
  secrets: Array<{ keyId: string; purpose: string; algorithm: string; materialB64: string }>;
}

export interface SealedAgentKeyLease {
  protocol: typeof AGENT_CONTROL_PROTOCOL;
  alg: 'x25519-hkdf-sha256-chacha20poly1305';
  ephemeralPublicKeyB64: string;
  nonceB64: string;
  ciphertextB64: string;
  tagB64: string;
  agentId: string;
  grantId: string;
  runnerId: string;
  certificateDigest: DigestHex;
  network: MosaicNetwork;
  expiresAt: string;
}

export interface AgentLeaseRenewalPackage {
  renewal: LeaseRenewal;
  sealedKeyLease: SealedAgentKeyLease;
}

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

export function unsignedControlMessage(message: SignedAgentControlMessage): Omit<SignedAgentControlMessage, 'signatureB64'> {
  const { signatureB64: _signature, ...unsigned } = message;
  return unsigned as Omit<SignedAgentControlMessage, 'signatureB64'>;
}

export function controlSignatureText(message: SignedAgentControlMessage): string {
  return `${AGENT_CONTROL_PROTOCOL}:${message.kind}\n${canonicalJson(unsignedControlMessage(message))}`;
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

export function assertArtifactManifest(manifest: AgentArtifactManifest): void {
  if (manifest.protocol !== AGENT_ARTIFACT_PROTOCOL) throw new Error('unsupported agent artifact');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.agentId) || !manifest.version) throw new Error('agent artifact identity is invalid');
  assertDigestHex(manifest.sourceDigest, 'sourceDigest');
  if (manifest.minimumRuntimeVersion !== AGENT_RUNTIME_VERSION) throw new Error('agent runtime version is incompatible');
  if (new Set(manifest.requiredHooks).size !== manifest.requiredHooks.length) throw new Error('agent artifact has duplicate hooks');
  assertResourceLimits(manifest.limits);
}

export function assertResourceLimits(limits: AgentResourceLimits): void {
  const integers = Object.values(limits).filter((value): value is number => value !== undefined);
  if (integers.some((value) => !Number.isSafeInteger(value) || value <= 0)) throw new Error('resource limits must be positive integers');
  if (limits.memoryBytes > 256 * 1024 * 1024) throw new Error('agent memory limit exceeds maximum');
  if (limits.wallTimeMs > 60 * 60_000) throw new Error('agent wall-time limit exceeds maximum');
  if (limits.maxHookConcurrency > 32) throw new Error('hook concurrency exceeds maximum');
  if ((limits.maxEventConcurrency ?? 1) > 32) throw new Error('event concurrency exceeds maximum');
  if ((limits.maxEventQueue ?? 1) > 4096) throw new Error('event queue exceeds maximum');
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
