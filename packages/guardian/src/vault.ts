import { randomUUID } from 'node:crypto';
import {
  AGENT_CONTROL_PROTOCOL,
  DEFAULT_GRANT_TTL_MS,
  assertActiveWindow,
  assertCapabilityAllowance,
  assertDigestHex,
  assertArtifactManifest,
  assertResourceLimitsSubset,
  canonicalJson,
  contractDigest,
  controlSignatureText,
  type AgentArtifactManifest,
  type CapabilityAllowance,
  type ExecutionGrant,
  type MosaicNetwork,
  type AgentResourceDescriptor,
  type AgentResourceLimits,
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
  expiresAt: string;
  maxOfflineMs: number;
  nextTransactionSequence: number;
  transactions: Map<string, TransactionResult>;
}

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
    runnerControlInboxId: string;
    guardianControlInboxId: string;
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
      runnerControlInboxId: params.runnerControlInboxId,
      guardianId: this.signer.guardianId,
      guardianAddress: this.signer.guardianAddress,
      guardianControlInboxId: params.guardianControlInboxId,
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
    agentId: string;
    certificate: RunnerCertificate;
    manifest: AgentArtifactManifest;
    configDigest: string;
    policyDigest: string;
    capabilities: CapabilityAllowance[];
    artifactDigest: string;
    policyRevision: number;
    xmtpAddress: string;
    resources: AgentResourceDescriptor[];
    limits: AgentResourceLimits;
    ttlMs?: number;
  }): ExecutionGrant {
    this.assertCertificate(params.certificate);
    assertArtifactManifest(params.manifest);
    assertDigestHex(params.configDigest, 'configDigest');
    assertDigestHex(params.policyDigest, 'policyDigest');
    assertDigestHex(params.artifactDigest, 'artifactDigest');
    if (!Number.isSafeInteger(params.policyRevision) || params.policyRevision < 1) throw new Error('invalid policy revision');
    this.assertCapabilities(params.manifest, params.capabilities, params.limits);
    const issued = this.now();
    const certificateExpiry = Date.parse(params.certificate.expiresAt);
    const expires = Math.min(issued + Math.min(params.ttlMs ?? DEFAULT_GRANT_TTL_MS, DEFAULT_GRANT_TTL_MS), certificateExpiry);
    const unsigned = {
      protocol: AGENT_CONTROL_PROTOCOL,
      kind: 'execution-grant',
      grantId: randomUUID(),
      runnerId: params.certificate.runnerId,
      runnerPublicKey: params.certificate.runnerPublicKey,
      runnerControlInboxId: params.certificate.runnerControlInboxId,
      guardianId: this.signer.guardianId,
      guardianAddress: this.signer.guardianAddress,
      guardianControlInboxId: params.certificate.guardianControlInboxId,
      network: this.signer.network,
      agentId: params.agentId,
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
      limits: structuredClone(params.limits),
      issuedAt: new Date(issued).toISOString(),
      expiresAt: new Date(expires).toISOString(),
      maxOfflineMs: 0,
      sequence: 1,
    } as const;
    const grant = this.sign({ ...unsigned, signatureB64: '' });
    this.grants.set(grant.grantId, {
      grant, expiresAt: grant.expiresAt, maxOfflineMs: grant.maxOfflineMs,
      nextTransactionSequence: 1, transactions: new Map(),
    });
    this.appendAudit('grant.issued', { grantId: grant.grantId, manifestDigest: grant.manifestDigest });
    return grant;
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

  signControlText(text: string): Uint8Array { return this.signer.signEnvelope(text); }

  recordTermination(agentId: string, grantId: string, mode: 'graceful' | 'immediate', reason: string): string {
    this.assertGrantBinding(grantId, agentId);
    this.dropAgent(agentId);
    return this.appendAudit('agent.termination-commanded', { agentId, grantId, mode, reason });
  }

  recordCompletion(agentId: string, grantId: string, outcome: string): string {
    this.assertGrantBinding(grantId, agentId);
    this.dropAgent(agentId);
    return this.appendAudit('agent.runtime-ended', { agentId, grantId, outcome });
  }

  recordRunnerTelemetry(agentId: string, grantId: string, auditDigest: string, outcome: string): string {
    assertDigestHex(auditDigest, 'Runner audit digest');
    return this.appendAudit('runner.telemetry', { agentId, grantId, auditDigest, outcome, trusted: false });
  }

  hasActiveGrant(agentId: string): boolean {
    let active = false;
    for (const [grantId, state] of this.grants) {
      if (state.grant.agentId !== agentId) continue;
      if (this.now() <= Date.parse(state.expiresAt) + state.maxOfflineMs) active = true;
      else this.grants.delete(grantId);
    }
    return active;
  }

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
    if (!state.grant.agentId || !proposal.keyId || !proposal.intentType || Buffer.byteLength(canonicalJson(proposal.intent)) > 64 * 1024) {
      throw new Error('invalid transaction proposal');
    }
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

  private assertCapabilities(manifest: AgentArtifactManifest, capabilities: CapabilityAllowance[], limits: AgentResourceLimits): void {
    assertResourceLimitsSubset(limits, manifest.limits);
    const requested = new Map([...manifest.capabilities.required, ...manifest.capabilities.optional].map((item) => [item.operation, item]));
    const unique = new Set<string>();
    for (const allowance of capabilities) {
      assertCapabilityAllowance(allowance, true);
      if (unique.has(allowance.operation)) throw new Error('duplicate capability allowance');
      unique.add(allowance.operation);
      const request = requested.get(allowance.operation);
      if (!request || allowance.maxCalls > request.maxCalls || allowance.maxResponseBytes > request.maxResponseBytes) throw new Error(`manifest does not permit ${allowance.operation}`);
      if (canonicalJson(allowance.constraints ?? {}) !== canonicalJson(request.constraints ?? {})) throw new Error(`grant changes ${allowance.operation} constraints`);
      if (allowance.maxResponseBytes > limits.maxHookResponseBytes) {
        throw new Error('capability response limit is invalid');
      }
    }
    for (const required of manifest.capabilities.required) if (!unique.has(required.operation)) throw new Error(`missing required capability: ${required.operation}`);
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
