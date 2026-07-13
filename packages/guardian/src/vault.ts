import { randomUUID } from 'node:crypto';
import {
  AGENT_CONTROL_PROTOCOL,
  DEFAULT_GRANT_TTL_MS,
  DEFAULT_OFFLINE_GRACE_MS,
  assertActiveWindow,
  assertCapabilitySubset,
  assertDigestHex,
  assertArtifactManifest,
  canonicalJson,
  contractDigest,
  controlSignatureText,
  type AgentArtifactManifest,
  type CapabilityAllowance,
  type CapabilityRequest,
  type CapabilityResult,
  type ExecutionGrant,
  type LeaseRenewal,
  type MosaicNetwork,
  type AgentResourceDescriptor,
  type Revocation,
  type RunnerCertificate,
  type SignedAgentControlMessage,
  type TransactionProposal,
  type TransactionResult,
} from '@mosaic/local-runtime';

export interface VaultControlSigner {
  guardianId: string;
  guardianAddress: string;
  network: MosaicNetwork;
  signEnvelope(text: string): Uint8Array;
}

interface GrantState {
  grant: ExecutionGrant;
  capabilities: CapabilityAllowance[];
  expiresAt: string;
  maxOfflineMs: number;
  renewalSequence: number;
  resources: AgentResourceDescriptor[];
  nextSequence: number;
  calls: Map<string, number>;
  idempotency: Map<string, CapabilityResult>;
  nextTransactionSequence: number;
  transactions: Map<string, TransactionResult>;
}

const SAFE_LOCAL_OPERATIONS = new Set([
  'state.get', 'state.put', 'state.compareAndSet',
  'log.emit', 'clock.now', 'random.bytes', 'schedule.once',
  'xmtp.receive', 'xmtp.send', 'transaction.propose',
]);

/**
 * Networkless lease and policy authority. It cannot start processes or perform
 * network I/O; its only cryptographic primitive signs fixed Mosaic envelopes.
 */
export class VaultCore {
  private readonly certificates = new Map<string, RunnerCertificate>();
  private readonly grants = new Map<string, GrantState>();
  private readonly revoked = new Set<string>();
  private auditHead = '0'.repeat(64);

  constructor(private readonly signer: VaultControlSigner, private readonly now: () => number = Date.now) {}

  enrollRunner(params: {
    runnerId: string;
    runnerPublicKey: string;
    network: MosaicNetwork;
    environment: 'local' | 'remote';
    ttlMs?: number;
  }): RunnerCertificate {
    if (params.network !== this.signer.network) throw new Error('runner network does not match Guardian');
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(params.runnerId)) throw new Error('invalid runner ID');
    assertEd25519PublicKey(params.runnerPublicKey);
    const issued = this.now();
    const unsigned = {
      protocol: AGENT_CONTROL_PROTOCOL,
      kind: 'runner-certificate',
      runnerId: params.runnerId,
      runnerPublicKey: params.runnerPublicKey,
      guardianId: this.signer.guardianId,
      guardianAddress: this.signer.guardianAddress,
      network: params.network,
      environment: params.environment,
      trustTier: 'software-local',
      issuedAt: new Date(issued).toISOString(),
      expiresAt: new Date(issued + Math.min(params.ttlMs ?? 24 * 60 * 60_000, 7 * 24 * 60 * 60_000)).toISOString(),
      revocationId: randomUUID(),
    } as const;
    const certificate = this.sign({ ...unsigned, signatureB64: '' });
    this.certificates.set(params.runnerId, certificate);
    this.appendAudit('runner.enrolled', { runnerId: params.runnerId, certificateDigest: contractDigest(certificate) });
    return certificate;
  }

  issueGrant(params: {
    certificate: RunnerCertificate;
    manifest: AgentArtifactManifest;
    configDigest: string;
    policyDigest: string;
    capabilities: CapabilityAllowance[];
    artifactDigest: string;
    policyRevision: number;
    xmtpAddress: string;
    resources: AgentResourceDescriptor[];
    ttlMs?: number;
  }): ExecutionGrant {
    this.assertCertificate(params.certificate);
    assertArtifactManifest(params.manifest);
    assertDigestHex(params.configDigest, 'configDigest');
    assertDigestHex(params.policyDigest, 'policyDigest');
    assertDigestHex(params.artifactDigest, 'artifactDigest');
    if (!Number.isSafeInteger(params.policyRevision) || params.policyRevision < 1) throw new Error('invalid policy revision');
    this.assertCapabilities(params.manifest, params.capabilities);
    const issued = this.now();
    const certificateExpiry = Date.parse(params.certificate.expiresAt);
    const expires = Math.min(issued + Math.min(params.ttlMs ?? DEFAULT_GRANT_TTL_MS, DEFAULT_GRANT_TTL_MS), certificateExpiry);
    const unsigned = {
      protocol: AGENT_CONTROL_PROTOCOL,
      kind: 'execution-grant',
      grantId: randomUUID(),
      runnerId: params.certificate.runnerId,
      runnerPublicKey: params.certificate.runnerPublicKey,
      guardianId: this.signer.guardianId,
      guardianAddress: this.signer.guardianAddress,
      network: this.signer.network,
      agentId: params.manifest.agentId,
      trustTier: 'software-local',
      artifactDigest: params.artifactDigest,
      policyRevision: params.policyRevision,
      xmtpAddress: params.xmtpAddress,
      resources: structuredClone(params.resources),
      manifestDigest: contractDigest(params.manifest),
      sourceDigest: params.manifest.sourceDigest,
      configDigest: params.configDigest,
      policyDigest: params.policyDigest,
      certificateDigest: contractDigest(params.certificate),
      capabilities: structuredClone(params.capabilities),
      limits: structuredClone(params.manifest.limits),
      issuedAt: new Date(issued).toISOString(),
      expiresAt: new Date(expires).toISOString(),
      maxOfflineMs: DEFAULT_OFFLINE_GRACE_MS,
      sequence: 1,
    } as const;
    const grant = this.sign({ ...unsigned, signatureB64: '' });
    this.grants.set(grant.grantId, {
      grant, capabilities: structuredClone(grant.capabilities), expiresAt: grant.expiresAt,
      maxOfflineMs: grant.maxOfflineMs, renewalSequence: grant.sequence,
      resources: structuredClone(grant.resources),
      nextSequence: 1, calls: new Map(), idempotency: new Map(),
      nextTransactionSequence: 1, transactions: new Map(),
    });
    this.appendAudit('grant.issued', { grantId: grant.grantId, manifestDigest: grant.manifestDigest });
    return grant;
  }

  authorizeCapability(request: CapabilityRequest): CapabilityResult | undefined {
    const state = this.requireGrant(request.grantId);
    if (request.agentId !== state.grant.agentId) throw new Error('capability agent binding mismatch');
    if (request.runnerId !== state.grant.runnerId) throw new Error('capability Runner mismatch');
    const replay = state.idempotency.get(request.idempotencyKey);
    if (replay) return structuredClone(replay);
    if (request.sequence !== state.nextSequence) throw new Error('capability sequence mismatch');
    if (Date.parse(request.deadline) <= this.now()) throw new Error('capability request expired');
    const allowance = state.capabilities.find(({ operation }) => operation === request.operation);
    if (!allowance) throw new Error(`capability ${request.operation} is not granted`);
    const calls = state.calls.get(request.operation) ?? 0;
    if (calls >= allowance.maxCalls) throw new Error(`capability ${request.operation} quota exhausted`);
    // transaction.propose is consumed by the proposal itself (rejectTransaction,
    // which is reachable without a prior authorize); counting it here as well
    // would burn two quota units per proposal.
    if (request.operation !== 'transaction.propose') state.calls.set(request.operation, calls + 1);
    state.nextSequence += 1;
    return undefined;
  }

  recordCapability(request: CapabilityRequest, result: Omit<CapabilityResult, 'auditEventDigest'>): CapabilityResult {
    const state = this.requireGrant(request.grantId);
    if (request.agentId !== state.grant.agentId || result.agentId !== state.grant.agentId) throw new Error('capability result agent binding mismatch');
    if (result.grantId !== request.grantId || result.requestId !== request.requestId) throw new Error('capability result request binding mismatch');
    const auditEventDigest = this.appendAudit('capability.result', {
      grantId: request.grantId,
      requestId: request.requestId,
      operation: request.operation,
      ok: result.ok,
      usage: result.usage,
    });
    const recorded = { ...result, auditEventDigest };
    state.idempotency.set(request.idempotencyKey, structuredClone(recorded));
    return recorded;
  }

  renew(
    grantId: string,
    capabilities: CapabilityAllowance[],
    expiresAt: string,
    maxOfflineMs: number,
    agentId?: string,
    resources?: AgentResourceDescriptor[],
  ): LeaseRenewal {
    const state = this.requireGrant(grantId);
    if (agentId !== undefined && agentId !== state.grant.agentId) throw new Error('lease agent binding mismatch');
    assertCapabilitySubset(capabilities, state.capabilities);
    const nextResources = resources ?? state.resources;
    const priorResources = new Map(state.resources.map((resource) => [resource.resourceId, canonicalJson(resource)]));
    if (nextResources.some((resource) => priorResources.get(resource.resourceId) !== canonicalJson(resource))) {
      throw new Error('lease renewal expands or changes resources');
    }
    const expires = Date.parse(expiresAt);
    const certificate = this.certificates.get(state.grant.runnerId);
    if (!Number.isFinite(expires) || expires <= this.now() || expires > this.now() + DEFAULT_GRANT_TTL_MS || !certificate || expires > Date.parse(certificate.expiresAt)) {
      throw new Error('renewal expiry is invalid');
    }
    if (!Number.isSafeInteger(maxOfflineMs) || maxOfflineMs < 0 || maxOfflineMs > state.maxOfflineMs) {
      throw new Error('renewal cannot expand offline grace');
    }
    const renewal = this.sign({
      protocol: AGENT_CONTROL_PROTOCOL,
      kind: 'lease-renewal',
      grantId,
      agentId: state.grant.agentId,
      sequence: state.renewalSequence + 1,
      capabilities: structuredClone(capabilities),
      resources: structuredClone(nextResources),
      expiresAt,
      maxOfflineMs,
      signatureB64: '',
    });
    state.capabilities = structuredClone(capabilities);
    state.resources = structuredClone(nextResources);
    state.expiresAt = expiresAt;
    state.maxOfflineMs = maxOfflineMs;
    state.renewalSequence = renewal.sequence;
    return renewal;
  }

  revoke(agentId: string, revocationId: string, reason: string): Revocation {
    if (!agentId || !revocationId || !reason) throw new Error('agent, revocation ID and reason are required');
    this.revoked.add(revocationId);
    return this.sign({
      protocol: AGENT_CONTROL_PROTOCOL,
      kind: 'revocation',
      revocationId,
      agentId,
      sequence: 1,
      issuedAt: new Date(this.now()).toISOString(),
      reason,
      signatureB64: '',
    });
  }

  auditDigest(): string { return this.auditHead; }

  dropAgent(agentId: string): void {
    for (const [grantId, state] of this.grants) {
      if (state.grant.agentId === agentId) this.grants.delete(grantId);
    }
    this.appendAudit('agent.locked', { agentId });
  }

  getGrant(grantId: string, agentId: string): ExecutionGrant {
    const state = this.requireGrant(grantId);
    if (state.grant.agentId !== agentId) throw new Error('grant agent binding mismatch');
    return structuredClone(state.grant);
  }

  /**
   * Binding check for stop/lock paths. Unlike getGrant it tolerates expired
   * or already-dropped grants: a stop arriving after expiry must still reach
   * the zeroization, never fail on the expiry window.
   */
  assertGrantBinding(grantId: string, agentId: string): void {
    const state = this.grants.get(grantId);
    if (state && state.grant.agentId !== agentId) throw new Error('grant agent binding mismatch');
  }

  rejectTransaction(proposal: TransactionProposal): TransactionResult {
    const state = this.requireGrant(proposal.grantId);
    if (proposal.agentId !== state.grant.agentId || proposal.runnerId !== state.grant.runnerId) {
      throw new Error('transaction proposal agent binding mismatch');
    }
    if (proposal.network !== state.grant.network || Date.parse(proposal.deadline) <= this.now()) {
      throw new Error('invalid transaction proposal network or deadline');
    }
    const replay = state.transactions.get(proposal.idempotencyKey);
    if (replay) return structuredClone(replay);
    if (proposal.sequence !== state.nextTransactionSequence) throw new Error('transaction proposal sequence mismatch');
    if (!state.grant.capabilities.some(({ operation }) => operation === 'transaction.propose')) {
      throw new Error('transaction proposals are not granted');
    }
    if (!state.grant.agentId || !proposal.keyId || !proposal.intentType || Buffer.byteLength(canonicalJson(proposal.intent)) > 64 * 1024) {
      throw new Error('invalid transaction proposal');
    }
    const calls = state.calls.get('transaction.propose') ?? 0;
    const allowance = state.capabilities.find(({ operation }) => operation === 'transaction.propose')!;
    if (calls >= allowance.maxCalls) throw new Error('transaction proposal quota exhausted');
    state.calls.set('transaction.propose', calls + 1);
    state.nextTransactionSequence += 1;
    const result: TransactionResult = {
      protocol: AGENT_CONTROL_PROTOCOL,
      kind: 'transaction-result',
      agentId: proposal.agentId,
      grantId: proposal.grantId,
      requestId: proposal.requestId,
      ok: false,
      error: { code: 'TRANSACTION_BROKER_UNAVAILABLE', message: 'Transaction approval, signing, and broadcast are not implemented.' },
      auditEventDigest: this.appendAudit('transaction.rejected', {
        agentId: proposal.agentId, grantId: proposal.grantId, requestId: proposal.requestId, keyId: proposal.keyId,
      }),
    };
    state.transactions.set(proposal.idempotencyKey, structuredClone(result));
    return result;
  }

  private assertCertificate(certificate: RunnerCertificate): void {
    if (certificate.protocol !== AGENT_CONTROL_PROTOCOL || certificate.kind !== 'runner-certificate') throw new Error('unsupported Runner certificate');
    assertActiveWindow(certificate.issuedAt, certificate.expiresAt, this.now());
    if (certificate.guardianId !== this.signer.guardianId || certificate.guardianAddress.toLowerCase() !== this.signer.guardianAddress.toLowerCase()) {
      throw new Error('Runner certificate belongs to another Guardian');
    }
    if (certificate.network !== this.signer.network) throw new Error('Runner certificate network mismatch');
    if (this.revoked.has(certificate.revocationId)) throw new Error('Runner certificate is revoked');
    const issued = this.certificates.get(certificate.runnerId);
    if (!issued || canonicalJson(issued) !== canonicalJson(certificate)) throw new Error('Runner certificate was not issued by this Vault');
  }

  private assertCapabilities(manifest: AgentArtifactManifest, capabilities: CapabilityAllowance[]): void {
    if (capabilities.length !== manifest.requiredHooks.length) throw new Error('grant capabilities must exactly match required hooks');
    const unique = new Set<string>();
    for (const allowance of capabilities) {
      if (unique.has(allowance.operation)) throw new Error('duplicate capability allowance');
      unique.add(allowance.operation);
      if (!manifest.requiredHooks.includes(allowance.operation)) throw new Error(`manifest does not request ${allowance.operation}`);
      if (!SAFE_LOCAL_OPERATIONS.has(allowance.operation)) throw new Error(`${allowance.operation} policy broker is not implemented`);
      if (!Number.isSafeInteger(allowance.maxCalls) || allowance.maxCalls <= 0) throw new Error('capability maxCalls must be positive');
      if (!Number.isSafeInteger(allowance.maxResponseBytes) || allowance.maxResponseBytes <= 0 || allowance.maxResponseBytes > manifest.limits.maxHookResponseBytes) {
        throw new Error('capability response limit is invalid');
      }
    }
  }

  private requireGrant(grantId: string): GrantState {
    const state = this.grants.get(grantId);
    if (!state) throw new Error('unknown execution grant');
    assertActiveWindow(state.grant.issuedAt, state.expiresAt, this.now());
    return state;
  }

  private sign<T extends SignedAgentControlMessage>(message: T): T {
    const signature = this.signer.signEnvelope(controlSignatureText(message));
    return { ...message, signatureB64: Buffer.from(signature).toString('base64') };
  }

  private appendAudit(type: string, body: Record<string, unknown>): string {
    this.auditHead = contractDigest({ previous: this.auditHead, type, at: new Date(this.now()).toISOString(), body });
    return this.auditHead;
  }
}

function assertEd25519PublicKey(value: string): void {
  try {
    const key = Buffer.from(value, 'base64');
    if (key.byteLength < 32 || key.byteLength > 128) throw new Error('unexpected key length');
  } catch {
    throw new Error('invalid Runner public key');
  }
}
