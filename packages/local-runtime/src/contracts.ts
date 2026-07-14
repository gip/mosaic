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
export const AGENT_CONTROL_PROTOCOL = 'MOSAIC_AGENT_CONTROL_V3' as const;
export const AGENT_RUNTIME_VERSION = '2.0.0' as const;
export const AGENT_ARTIFACT_PROTOCOL = 'MOSAIC_AGENT_ARTIFACT_V2' as const;
export const AGENT_PACKAGE_PROTOCOL = 'MOSAIC_AGENT_PACKAGE_V1' as const;
export const DEFAULT_GRANT_TTL_MS = 24 * 60 * 60_000;
export const DEFAULT_OFFLINE_GRACE_MS = 0;
export const ATTENDED_REQUEST_TTL_MS = 15 * 60_000;
export const PAIRING_TTL_MS = 5 * 60_000;
export const MAX_CONTROL_MESSAGE_BYTES = 256 * 1024;
export const MAX_AGENT_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_AGENT_MANIFEST_BYTES = 256 * 1024;
export const MAX_HOOK_ARGUMENT_BYTES = 128 * 1024;
export const MAX_AGENT_PACKAGE_BYTES = 2 * MAX_AGENT_SOURCE_BYTES + MAX_AGENT_MANIFEST_BYTES + 64 * 1024;
export const MAX_AGENT_RESOURCE_SLOTS = 128;

export type DigestHex = string;
export type CapabilityOperation =
  | 'state.get' | 'state.put' | 'state.compareAndSet'
  | 'llm.complete'
  | 'xmtp.receive' | 'xmtp.send'
  | 'websocket.connect' | 'websocket.send' | 'websocket.receive' | 'websocket.close'
  | 'transaction.propose'
  | 'log.emit' | 'clock.now' | 'random.bytes';

export type GrantableCapabilityOperation =
  | 'state.get' | 'state.put' | 'state.compareAndSet'
  | 'xmtp.receive' | 'xmtp.send'
  | 'log.emit' | 'clock.now' | 'random.bytes';

interface CapabilityAllowanceBase {
  maxCalls: number;
  maxResponseBytes: number;
}

export type CapabilityAllowance =
  | (CapabilityAllowanceBase & { operation: 'state.get'; constraints: { keyPrefixes: string[] } })
  | (CapabilityAllowanceBase & { operation: 'state.put'; constraints: { keyPrefixes: string[]; maxValueBytes: number } })
  | (CapabilityAllowanceBase & { operation: 'state.compareAndSet'; constraints: { keyPrefixes: string[]; maxValueBytes: number } })
  | (CapabilityAllowanceBase & { operation: 'log.emit'; constraints: { maxEntryBytes: number } })
  | (CapabilityAllowanceBase & { operation: 'clock.now'; constraints?: never })
  | (CapabilityAllowanceBase & { operation: 'random.bytes'; constraints: { maxBytes: number } })
  | (CapabilityAllowanceBase & { operation: 'xmtp.send'; constraints: { resourceSlots: string[]; maxMessageBytes: number } })
  | (CapabilityAllowanceBase & { operation: 'xmtp.receive'; constraints: { resourceSlots: string[] } })
  | (CapabilityAllowanceBase & {
      operation: Exclude<CapabilityOperation, GrantableCapabilityOperation>;
      constraints?: Record<string, unknown>;
    });

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

export interface ResourceSlot {
  slotId: string;
  kind: 'xmtp-contact';
  label: string;
  required: boolean;
}

export interface AgentArtifactManifest {
  protocol: typeof AGENT_ARTIFACT_PROTOCOL;
  packageName: string;
  version: string;
  sourceDigest: DigestHex;
  capabilities: {
    required: CapabilityAllowance[];
    optional: CapabilityAllowance[];
  };
  resourceSlots: ResourceSlot[];
  limits: AgentResourceLimits;
  minimumRuntimeVersion: string;
}

export interface AgentInstallationPolicy {
  v: 2;
  revision: number;
  enabled: boolean;
  packageName: string;
  artifactDigest: DigestHex;
  capabilities: CapabilityAllowance[];
  resources: XmtpResourceDescriptor[];
  limits: AgentResourceLimits;
}

export interface AgentArtifactPackage {
  protocol: typeof AGENT_PACKAGE_PROTOCOL;
  manifest: AgentArtifactManifest;
  source: string;
  artifactDigest: DigestHex;
}

export interface RunnerCertificate {
  protocol: typeof AGENT_CONTROL_PROTOCOL;
  kind: 'runner-certificate';
  runnerId: string;
  runnerPublicKey: string;
  runnerControlInboxId: string;
  guardianId: string;
  guardianAddress: string;
  guardianControlInboxId: string;
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
  runnerControlInboxId: string;
  guardianId: string;
  guardianAddress: string;
  guardianControlInboxId: string;
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

export type SignedAgentControlMessage = RunnerCertificate | ExecutionGrant | Revocation;

export interface AgentExecutionPackage {
  agentId: string;
  manifest: AgentArtifactManifest;
  artifactTicket: string;
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


export type ControlMessageKind =
  | 'runner-enrollment'
  | 'agent-start-request'
  | 'agent-start-result'
  | 'privileged-request'
  | 'privileged-result'
  | 'agent-termination-command'
  | 'agent-termination-result'
  | 'runtime-audit-checkpoint'
  | 'control-error';

export interface PairingOffer {
  protocol: typeof AGENT_CONTROL_PROTOCOL;
  kind: 'pairing-offer';
  runnerId: string;
  runnerDevicePublicKey: string;
  runnerControlAddress: string;
  runnerControlInboxId: string;
  network: MosaicNetwork;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  signatureB64: string;
}

export interface ControlEnvelope<T = unknown> {
  protocol: typeof AGENT_CONTROL_PROTOCOL;
  kind: ControlMessageKind;
  requestId: string;
  replyTo?: string;
  guardianId: string;
  guardianControlInboxId: string;
  runnerId: string;
  runnerDevicePublicKey: string;
  runnerControlInboxId: string;
  agentId?: string;
  grantId?: string;
  sequence: number;
  issuedAt: string;
  expiresAt: string;
  idempotencyKey: string;
  payloadDigest: DigestHex;
  payload: T;
  signatureB64: string;
}

export interface RunnerEnrollmentPayload {
  network: MosaicNetwork;
  environment: 'local' | 'remote';
  pairingNonce: string;
}

export interface AgentStartRequestPayload {
  network: MosaicNetwork;
  supervisorKeyLeasePublicKeyB64: string;
}

export interface AgentStartResultPayload {
  ok: boolean;
  execution?: AgentExecutionPackage;
  error?: { code: string; message: string };
}

export interface PrivilegedRequestPayload {
  operation: 'transaction.propose';
  proposal: TransactionProposal;
}

export interface PrivilegedResultPayload {
  operation: 'runner.enroll' | 'transaction.propose';
  certificate?: RunnerCertificate;
  result?: TransactionResult;
}

export type AgentTerminationMode = 'graceful' | 'immediate';

export interface AgentTerminationCommandPayload {
  commandId: string;
  mode: AgentTerminationMode;
  reason: string;
  revoke: true;
}

export interface AgentTerminationResultPayload {
  commandId: string;
  mode: AgentTerminationMode;
  outcome: 'stopped' | 'killed' | 'already-stopped' | 'rejected';
  exitStatus?: number | string;
  stoppedAt: string;
  finalAuditDigest: DigestHex;
  forced: boolean;
}

export interface RuntimeAuditCheckpointPayload {
  checkpointId: string;
  auditDigest: DigestHex;
  eventCount: number;
  outcome: 'completed' | 'stopped' | 'killed' | 'expired' | 'crashed';
  forced: boolean;
  incomplete: boolean;
  stoppedAt: string;
}

export interface ControlErrorPayload {
  code: string;
  message: string;
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
  assertExactKeys(manifest as unknown as Record<string, unknown>, ['protocol', 'packageName', 'version', 'sourceDigest', 'capabilities', 'resourceSlots', 'limits', 'minimumRuntimeVersion'], 'agent manifest');
  if (manifest.protocol !== AGENT_ARTIFACT_PROTOCOL) throw new Error('unsupported agent artifact');
  if (!isKebabIdentifier(manifest.packageName) || manifest.packageName.length > 64) throw new Error('agent package identity is invalid');
  if (!isSemver(manifest.version) || !isSemver(manifest.minimumRuntimeVersion)) throw new Error('agent package version is invalid');
  assertDigestHex(manifest.sourceDigest, 'sourceDigest');
  if (!isRuntimeCompatible(manifest.minimumRuntimeVersion, AGENT_RUNTIME_VERSION)) throw new Error('agent runtime version is incompatible');
  assertResourceLimits(manifest.limits);
  if (!Array.isArray(manifest.capabilities?.required) || !Array.isArray(manifest.capabilities?.optional)) throw new Error('agent capabilities are invalid');
  const capabilities = [...manifest.capabilities.required, ...manifest.capabilities.optional];
  assertExactKeys(manifest.capabilities as unknown as Record<string, unknown>, ['required', 'optional'], 'agent capabilities');
  const operations = capabilities.map(({ operation }) => operation);
  if (new Set(operations).size !== operations.length) throw new Error('agent artifact has duplicate capabilities');
  for (const allowance of capabilities) {
    assertCapabilityAllowance(allowance, true);
    if (allowance.maxResponseBytes > manifest.limits.maxHookResponseBytes) throw new Error(`${allowance.operation} maxResponseBytes exceeds the runtime limit`);
  }
  if (!Array.isArray(manifest.resourceSlots) || manifest.resourceSlots.length > MAX_AGENT_RESOURCE_SLOTS) throw new Error('agent resource slots are invalid');
  const slotIds = new Set<string>();
  for (const slot of manifest.resourceSlots) {
    assertExactKeys(slot as unknown as Record<string, unknown>, ['slotId', 'kind', 'label', 'required'], 'agent resource slot');
    if (!isKebabIdentifier(slot.slotId) || slot.slotId.length > 64 || slot.kind !== 'xmtp-contact' || typeof slot.required !== 'boolean') throw new Error('agent resource slot is invalid');
    if (!slot.label || utf8ByteLength(slot.label) > 128) throw new Error('agent resource slot label is invalid');
    if (slotIds.has(slot.slotId)) throw new Error(`duplicate agent resource slot: ${slot.slotId}`);
    slotIds.add(slot.slotId);
  }
  for (const allowance of capabilities) {
    if (allowance.operation !== 'xmtp.send' && allowance.operation !== 'xmtp.receive') continue;
    for (const slotId of allowance.constraints.resourceSlots) {
      if (!slotIds.has(slotId)) throw new Error(`${allowance.operation} references unknown resource slot: ${slotId}`);
    }
  }
  if (utf8ByteLength(canonicalJson(manifest)) > MAX_AGENT_MANIFEST_BYTES) throw new Error('agent manifest exceeds maximum size');
}

export function assertResourceLimits(limits: AgentResourceLimits): void {
  assertExactKeys(limits as unknown as Record<string, unknown>, ['memoryBytes', 'stackBytes', 'wallTimeMs', 'maxPendingJobs', 'maxHookConcurrency', 'maxHookResponseBytes', 'maxEventQueue', 'maxEventConcurrency', 'maxEventBytes'], 'agent resource limits');
  const integers = Object.values(limits).filter((value): value is number => value !== undefined);
  if (integers.some((value) => !Number.isSafeInteger(value) || value <= 0)) throw new Error('resource limits must be positive integers');
  if (limits.memoryBytes > 256 * 1024 * 1024) throw new Error('agent memory limit exceeds maximum');
  if (limits.stackBytes > 16 * 1024 * 1024) throw new Error('agent stack limit exceeds maximum');
  if (limits.wallTimeMs > 24 * 60 * 60_000) throw new Error('agent wall-time limit exceeds maximum');
  if (limits.maxPendingJobs > 4096) throw new Error('pending-job limit exceeds maximum');
  if (limits.maxHookConcurrency > 32) throw new Error('hook concurrency exceeds maximum');
  if (limits.maxHookResponseBytes > MAX_HOOK_ARGUMENT_BYTES) throw new Error('hook response limit exceeds maximum');
  if ((limits.maxEventConcurrency ?? 1) > 32) throw new Error('event concurrency exceeds maximum');
  if ((limits.maxEventQueue ?? 1) > 4096) throw new Error('event queue exceeds maximum');
  if ((limits.maxEventBytes ?? 1) > 64 * 1024) throw new Error('event byte limit exceeds maximum');
}

export function assertResourceLimitsSubset(next: AgentResourceLimits, requested: AgentResourceLimits): void {
  assertResourceLimits(next);
  for (const key of Object.keys(requested) as Array<keyof AgentResourceLimits>) {
    const nextValue = next[key];
    const requestedValue = requested[key];
    if ((requestedValue === undefined && nextValue !== undefined) || (requestedValue !== undefined && (nextValue === undefined || nextValue > requestedValue))) {
      throw new Error(`installation expands resource limit ${key}`);
    }
  }
}

export function assertCapabilityAllowance(allowance: CapabilityAllowance, requireGrantable = false): void {
  if (!allowance || typeof allowance !== 'object') throw new Error('capability allowance is invalid');
  if (typeof allowance.operation !== 'string') throw new Error('capability operation is invalid');
  if (!Number.isSafeInteger(allowance.maxCalls) || allowance.maxCalls <= 0) throw new Error(`${allowance.operation} maxCalls must be positive`);
  if (!Number.isSafeInteger(allowance.maxResponseBytes) || allowance.maxResponseBytes <= 0) throw new Error(`${allowance.operation} maxResponseBytes must be positive`);
  if (requireGrantable && !isGrantableCapability(allowance.operation)) throw new Error(`${allowance.operation} policy broker is not implemented`);
  assertExactKeys(allowance as unknown as Record<string, unknown>, allowance.operation === 'clock.now' ? ['operation', 'maxCalls', 'maxResponseBytes'] : ['operation', 'maxCalls', 'maxResponseBytes', 'constraints'], `${allowance.operation} allowance`);
  const prefixes = allowance.operation.startsWith('state.') ? (allowance.constraints as { keyPrefixes?: unknown } | undefined)?.keyPrefixes : undefined;
  if (allowance.operation.startsWith('state.')) assertStringSet(prefixes, `${allowance.operation} keyPrefixes`, 128);
  if (allowance.operation === 'state.put' || allowance.operation === 'state.compareAndSet') {
    assertBoundedPositive(allowance.constraints.maxValueBytes, 64 * 1024, `${allowance.operation} maxValueBytes`);
  }
  if (allowance.operation === 'log.emit') assertBoundedPositive(allowance.constraints.maxEntryBytes, 16 * 1024, 'log.emit maxEntryBytes');
  if (allowance.operation === 'clock.now' && allowance.constraints !== undefined) throw new Error('clock.now does not accept constraints');
  if (allowance.operation === 'random.bytes') assertBoundedPositive(allowance.constraints.maxBytes, 256, 'random.bytes maxBytes');
  if (allowance.operation === 'xmtp.send' || allowance.operation === 'xmtp.receive') {
    assertStringSet(allowance.constraints.resourceSlots, `${allowance.operation} resourceSlots`, 64);
    if (allowance.operation === 'xmtp.send') assertBoundedPositive(allowance.constraints.maxMessageBytes, 64 * 1024, 'xmtp.send maxMessageBytes');
  }
  const constraintKeys: Partial<Record<GrantableCapabilityOperation, string[]>> = {
    'state.get': ['keyPrefixes'],
    'state.put': ['keyPrefixes', 'maxValueBytes'],
    'state.compareAndSet': ['keyPrefixes', 'maxValueBytes'],
    'log.emit': ['maxEntryBytes'],
    'random.bytes': ['maxBytes'],
    'xmtp.send': ['resourceSlots', 'maxMessageBytes'],
    'xmtp.receive': ['resourceSlots'],
  };
  const allowedConstraints = constraintKeys[allowance.operation as GrantableCapabilityOperation];
  if (allowedConstraints) assertExactKeys(allowance.constraints as Record<string, unknown>, allowedConstraints, `${allowance.operation} constraints`);
}

export function assertInstallationPolicy(
  manifest: AgentArtifactManifest,
  installation: AgentInstallationPolicy,
  network: MosaicNetwork,
): void {
  assertArtifactManifest(manifest);
  assertExactKeys(installation as unknown as Record<string, unknown>, ['v', 'revision', 'enabled', 'packageName', 'artifactDigest', 'capabilities', 'resources', 'limits'], 'agent installation');
  if (installation.v !== 2 || !Number.isSafeInteger(installation.revision) || installation.revision < 1) throw new Error('invalid installation revision');
  if (typeof installation.enabled !== 'boolean') throw new Error('invalid installation enabled state');
  if (installation.packageName !== manifest.packageName) throw new Error('installation package name mismatch');
  assertDigestHex(installation.artifactDigest, 'artifactDigest');
  if (!Array.isArray(installation.capabilities) || !Array.isArray(installation.resources)) throw new Error('invalid installation');
  const requested = new Map([...manifest.capabilities.required, ...manifest.capabilities.optional].map((item) => [item.operation, item]));
  const granted = new Map<CapabilityOperation, CapabilityAllowance>();
  for (const allowance of installation.capabilities) {
    assertCapabilityAllowance(allowance, true);
    if (granted.has(allowance.operation)) throw new Error(`duplicate installation capability: ${allowance.operation}`);
    const request = requested.get(allowance.operation);
    if (!request || allowance.maxCalls > request.maxCalls || allowance.maxResponseBytes > request.maxResponseBytes) throw new Error(`installation expands ${allowance.operation}`);
    if (canonicalJson(allowance.constraints ?? {}) !== canonicalJson(request.constraints ?? {})) throw new Error(`installation changes ${allowance.operation} constraints`);
    granted.set(allowance.operation, allowance);
  }
  for (const required of manifest.capabilities.required) if (!granted.has(required.operation)) throw new Error(`missing required capability: ${required.operation}`);
  const slots = new Map(manifest.resourceSlots.map((slot) => [slot.slotId, slot]));
  const resources = new Set<string>();
  for (const resource of installation.resources) {
    assertExactKeys(resource as unknown as Record<string, unknown>, ['kind', 'resourceId', 'label', 'peerAddress', 'environment'], 'XMTP resource');
    const slot = slots.get(resource.resourceId);
    if (!slot || resource.kind !== slot.kind) throw new Error(`resource does not match a declared slot: ${resource.resourceId}`);
    if (resources.has(resource.resourceId)) throw new Error(`duplicate installation resource: ${resource.resourceId}`);
    if (!resource.label || utf8ByteLength(resource.label) > 128 || !resource.peerAddress || utf8ByteLength(resource.peerAddress) > 512) throw new Error(`invalid XMTP resource: ${resource.resourceId}`);
    if (resource.environment !== (network === 'testnet' ? 'dev' : 'production')) throw new Error(`XMTP resource environment mismatch: ${resource.resourceId}`);
    resources.add(resource.resourceId);
  }
  for (const slot of manifest.resourceSlots) if (slot.required && !resources.has(slot.slotId)) throw new Error(`missing required resource: ${slot.slotId}`);
  assertResourceLimitsSubset(installation.limits, manifest.limits);
}

export function isGrantableCapability(operation: CapabilityOperation): operation is GrantableCapabilityOperation {
  return [
    'state.get', 'state.put', 'state.compareAndSet', 'log.emit', 'clock.now', 'random.bytes', 'xmtp.send', 'xmtp.receive',
  ].includes(operation);
}

export function isKebabIdentifier(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

export function isSemver(value: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

export function isRuntimeCompatible(minimum: string, runtime: string): boolean {
  if (!isSemver(minimum) || !isSemver(runtime)) return false;
  const parse = (value: string) => value.split(/[+-]/, 1)[0]!.split('.').map(Number);
  const [minimumMajor, minimumMinor, minimumPatch] = parse(minimum);
  const [runtimeMajor, runtimeMinor, runtimePatch] = parse(runtime);
  return runtimeMajor === minimumMajor && (
    runtimeMinor! > minimumMinor! || (runtimeMinor === minimumMinor && runtimePatch! >= minimumPatch!)
  );
}

export function assertCanonicalAgentSource(source: string): void {
  if (!source || utf8ByteLength(source) > MAX_AGENT_SOURCE_BYTES) throw new Error('agent source exceeds maximum size');
  if (source.includes('\r') || /[\u0000-\u0009\u000b-\u001f]/.test(source)) throw new Error('agent source contains noncanonical control characters');
}

function assertExactKeys(record: Record<string, unknown>, allowed: string[], label: string): void {
  const permitted = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !permitted.has(key));
  if (unknown) throw new Error(`${label} contains unknown field: ${unknown}`);
}

function assertBoundedPositive(value: unknown, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > maximum) throw new Error(`${label} is invalid`);
}

function assertStringSet(value: unknown, label: string, maximum: number): asserts value is string[] {
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== 'string' || item.length < 1 || item.length > 128)) throw new Error(`${label} is invalid`);
  if (new Set(value).size !== value.length) throw new Error(`${label} contains duplicates`);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
