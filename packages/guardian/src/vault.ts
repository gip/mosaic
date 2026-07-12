import { randomUUID, verify } from 'node:crypto';
import {
  AGENT_CONTROL_PROTOCOL,
  DEFAULT_GRANT_TTL_MS,
  DEFAULT_OFFLINE_GRACE_MS,
  assertActiveWindow,
  assertCapabilitySubset,
  assertDigestHex,
  assertManifest,
  canonicalJson,
  contractDigest,
  controlSignatureText,
  manifestSignatureText,
  type AgentManifest,
  type CapabilityAllowance,
  type CapabilityRequest,
  type CapabilityResult,
  type ExecutionGrant,
  type LeaseRenewal,
  type MosaicNetwork,
  type Revocation,
  type RunnerCertificate,
  type SignedAgentControlMessage,
} from '@mosaic/local-runtime';

export interface VaultControlSigner {
  guardianId: string;
  guardianAddress: string;
  network: MosaicNetwork;
  signEnvelope(text: string): Uint8Array;
}

interface GrantState {
  grant: ExecutionGrant;
  nextSequence: number;
  calls: Map<string, number>;
  idempotency: Map<string, CapabilityResult>;
}

const SAFE_LOCAL_OPERATIONS = new Set([
  'state.get', 'state.put', 'state.compareAndSet',
  'log.emit', 'clock.now', 'random.bytes', 'schedule.once',
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
    manifest: AgentManifest;
    configDigest: string;
    policyDigest: string;
    capabilities: CapabilityAllowance[];
    ttlMs?: number;
  }): ExecutionGrant {
    this.assertCertificate(params.certificate);
    assertManifest(params.manifest);
    assertDigestHex(params.configDigest, 'configDigest');
    assertDigestHex(params.policyDigest, 'policyDigest');
    verifyManifest(params.manifest, params.certificate);
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
    this.grants.set(grant.grantId, { grant, nextSequence: 1, calls: new Map(), idempotency: new Map() });
    this.appendAudit('grant.issued', { grantId: grant.grantId, manifestDigest: grant.manifestDigest });
    return grant;
  }

  authorizeCapability(request: CapabilityRequest): CapabilityResult | undefined {
    const state = this.requireGrant(request.grantId);
    if (request.runnerId !== state.grant.runnerId) throw new Error('capability Runner mismatch');
    const replay = state.idempotency.get(request.idempotencyKey);
    if (replay) return structuredClone(replay);
    if (request.sequence !== state.nextSequence) throw new Error('capability sequence mismatch');
    if (Date.parse(request.deadline) <= this.now()) throw new Error('capability request expired');
    const allowance = state.grant.capabilities.find(({ operation }) => operation === request.operation);
    if (!allowance) throw new Error(`capability ${request.operation} is not granted`);
    const calls = state.calls.get(request.operation) ?? 0;
    if (calls >= allowance.maxCalls) throw new Error(`capability ${request.operation} quota exhausted`);
    state.calls.set(request.operation, calls + 1);
    state.nextSequence += 1;
    return undefined;
  }

  recordCapability(request: CapabilityRequest, result: Omit<CapabilityResult, 'auditEventDigest'>): CapabilityResult {
    const state = this.requireGrant(request.grantId);
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

  renew(grantId: string, capabilities: CapabilityAllowance[], expiresAt: string, maxOfflineMs: number): LeaseRenewal {
    const state = this.requireGrant(grantId);
    assertCapabilitySubset(capabilities, state.grant.capabilities);
    const expires = Date.parse(expiresAt);
    if (!Number.isFinite(expires) || expires <= this.now() || expires > Date.parse(state.grant.expiresAt)) {
      throw new Error('renewal cannot extend the original grant');
    }
    if (!Number.isSafeInteger(maxOfflineMs) || maxOfflineMs < 0 || maxOfflineMs > state.grant.maxOfflineMs) {
      throw new Error('renewal cannot expand offline grace');
    }
    return this.sign({
      protocol: AGENT_CONTROL_PROTOCOL,
      kind: 'lease-renewal',
      grantId,
      sequence: state.grant.sequence + 1,
      capabilities: structuredClone(capabilities),
      expiresAt,
      maxOfflineMs,
      signatureB64: '',
    });
  }

  revoke(revocationId: string, reason: string): Revocation {
    if (!revocationId || !reason) throw new Error('revocation ID and reason are required');
    this.revoked.add(revocationId);
    return this.sign({
      protocol: AGENT_CONTROL_PROTOCOL,
      kind: 'revocation',
      revocationId,
      sequence: 1,
      issuedAt: new Date(this.now()).toISOString(),
      reason,
      signatureB64: '',
    });
  }

  auditDigest(): string { return this.auditHead; }

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

  private assertCapabilities(manifest: AgentManifest, capabilities: CapabilityAllowance[]): void {
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
    assertActiveWindow(state.grant.issuedAt, state.grant.expiresAt, this.now());
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

function verifyManifest(manifest: AgentManifest, certificate: RunnerCertificate): void {
  const publicKey = {
    key: Buffer.from(certificate.runnerPublicKey, 'base64'),
    format: 'der',
    type: 'spki',
  } as const;
  const valid = verify(null, Buffer.from(manifestSignatureText(manifest)), publicKey, Buffer.from(manifest.publisherSignatureB64, 'base64'));
  if (!valid || manifest.publisher !== certificate.runnerId) throw new Error('agent manifest publisher signature is invalid');
}
