import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  AGENT_CONTROL_PROTOCOL,
  ControlStateStore,
  assertControlBindings,
  canonicalJson,
  createControlEnvelope,
  mosaicRuntimeDirectory,
  verifyPairingOffer,
  verifyRunnerEnvelope,
  type AgentStartRequestPayload,
  type AgentStartResultPayload,
  type AgentTerminationCommandPayload,
  type AgentTerminationMode,
  type ControlEnvelope,
  type PairingOffer,
  type PrivilegedRequestPayload,
  type PrivilegedResultPayload,
  type RunnerCertificate,
  type RunnerEnrollmentPayload,
  type RuntimeAuditCheckpointPayload,
} from '@mosaic/local-runtime';
import type { ControlTransport, ControlTransportMessage } from '@mosaic/local-runtime/control';
import { GuardianService, type UnlockCredential } from './service.js';

interface PendingStart {
  envelope: ControlEnvelope<AgentStartRequestPayload>;
  certificate: RunnerCertificate;
}

interface ActiveAgent {
  certificate: RunnerCertificate;
  grantId: string;
  expiresAt: string;
}

export interface GuardianControlEvent {
  type: 'approval-required' | 'runner-enrolled' | 'agent-terminated' | 'audit-checkpoint';
  requestId?: string;
  operation?: 'pairing' | 'agent-start' | 'transaction.propose';
  runnerId?: string;
  agentId?: string;
  grantId?: string;
  detail?: string;
}

export class GuardianXmtpControl {
  private readonly state: ControlStateStore;
  private readonly offers = new Map<string, PairingOffer>();
  private readonly certificates = new Map<string, RunnerCertificate>();
  private readonly pendingStarts = new Map<string, PendingStart>();
  private readonly pendingPrivileged = new Map<string, ControlEnvelope<PrivilegedRequestPayload>>();
  private readonly active = new Map<string, ActiveAgent>();
  private readonly approvalTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly guardian: GuardianService,
    private readonly transport: ControlTransport,
    private readonly network: 'testnet' | 'mainnet',
    private readonly emit: (event: GuardianControlEvent) => void,
  ) {
    this.state = new ControlStateStore(join(mosaicRuntimeDirectory(), 'control', `guardian-${network}-state.json`));
  }

  async start(): Promise<void> {
    await this.state.load();
    await this.transport.start((message) => this.receive(message));
  }

  identity(): { address: string; inboxId: string } { return { address: this.transport.address, inboxId: this.transport.inboxId }; }

  pendingApprovals(): Array<{ requestId: string; operation: 'agent-start' | 'transaction.propose'; agentId?: string; grantId?: string }> {
    return [
      ...[...this.pendingStarts].map(([requestId, pending]) => ({ requestId, operation: 'agent-start' as const, agentId: pending.envelope.agentId })),
      ...[...this.pendingPrivileged].map(([requestId, envelope]) => ({ requestId, operation: 'transaction.propose' as const, agentId: envelope.agentId, grantId: envelope.grantId })),
    ];
  }

  async approvePairing(offer: PairingOffer): Promise<void> {
    verifyPairingOffer(offer);
    if (offer.network !== this.network) throw new Error('pairing network mismatch');
    this.guardian.controlAuthority();
    this.offers.set(offer.runnerControlInboxId, structuredClone(offer));
    this.guardian.approveRunner(offer.runnerId, Math.max(1, Date.parse(offer.expiresAt) - Date.now()));
    // Echoing the Runner-signed descriptor initiates the XMTP DM without
    // inventing an unsigned pairing authority message.
    await this.transport.send(offer.runnerControlInboxId, canonicalJson(offer));
    this.emit({ type: 'approval-required', operation: 'pairing', runnerId: offer.runnerId, detail: 'Pairing approved; waiting for signed Runner enrollment.' });
  }

  async approveAgentStart(requestId: string, credential?: UnlockCredential): Promise<void> {
    const pending = this.pendingStarts.get(requestId);
    if (!pending) throw new Error('unknown or expired agent start approval');
    const agentId = pending.envelope.agentId!;
    const payload = pending.envelope.payload;
    this.pendingStarts.delete(requestId);
    this.clearApprovalTimer(requestId);
    this.state.setPendingApproval(requestId);
    if (Date.parse(pending.envelope.expiresAt) <= Date.now()) {
      await this.sendResult(pending.envelope, 'agent-start-result', { ok: false, error: { code: 'REQUEST_EXPIRED', message: 'Agent start approval expired.' } } satisfies AgentStartResultPayload);
      throw new Error('agent start approval expired');
    }
    try {
      await this.guardian.unlockVault(agentId, payload.network, credential);
      const execution = await this.guardian.prepareAgent({
        agentId,
        certificate: pending.certificate,
        supervisorKeyLeasePublicKeyB64: payload.supervisorKeyLeasePublicKeyB64,
      });
      this.active.set(agentId, { certificate: pending.certificate, grantId: execution.grant.grantId, expiresAt: execution.grant.expiresAt });
      await this.sendResult(pending.envelope, 'agent-start-result', { ok: true, execution } satisfies AgentStartResultPayload, execution.grant.grantId);
    } catch (error) {
      this.guardian.lockAgent(agentId);
      await this.sendResult(pending.envelope, 'agent-start-result', {
        ok: false,
        error: { code: 'AGENT_START_REJECTED', message: error instanceof Error ? error.message : String(error) },
      } satisfies AgentStartResultPayload);
      throw error;
    }
  }

  async rejectApproval(requestId: string, reason = 'User rejected the request'): Promise<void> {
    const start = this.pendingStarts.get(requestId);
    if (start) {
      this.pendingStarts.delete(requestId);
      this.clearApprovalTimer(requestId);
      this.state.setPendingApproval(requestId);
      await this.sendResult(start.envelope, 'agent-start-result', { ok: false, error: { code: 'USER_REJECTED', message: reason } } satisfies AgentStartResultPayload);
      return;
    }
    const privileged = this.pendingPrivileged.get(requestId);
    if (!privileged) throw new Error('unknown pending approval');
    this.pendingPrivileged.delete(requestId);
    this.clearApprovalTimer(requestId);
    this.state.setPendingApproval(requestId);
    const result = this.guardian.proposeTransaction(privileged.payload.proposal);
    await this.sendResult(privileged, 'privileged-result', { operation: 'transaction.propose', result } satisfies PrivilegedResultPayload, privileged.grantId);
  }

  async resolvePrivileged(requestId: string): Promise<void> {
    const envelope = this.pendingPrivileged.get(requestId);
    if (!envelope) throw new Error('unknown privileged approval');
    this.pendingPrivileged.delete(requestId);
    this.clearApprovalTimer(requestId);
    this.state.setPendingApproval(requestId);
    // The broker intentionally remains default-deny. Approval records user
    // intent, then Vault Core returns TRANSACTION_BROKER_UNAVAILABLE.
    const result = this.guardian.proposeTransaction(envelope.payload.proposal);
    await this.sendResult(envelope, 'privileged-result', { operation: 'transaction.propose', result } satisfies PrivilegedResultPayload, envelope.grantId);
  }

  async terminateAgent(agentId: string, mode: AgentTerminationMode, reason: string): Promise<string> {
    const active = this.active.get(agentId);
    if (!active) throw new Error(`agent is not active: ${agentId}`);
    const commandId = randomUUID();
    this.guardian.terminateAgent(agentId, active.grantId, mode, reason);
    this.active.delete(agentId);
    const authority = this.guardian.controlAuthority();
    const payload: AgentTerminationCommandPayload = { commandId, mode, reason, revoke: true };
    const scope = `${authority.guardianId}|${agentId}|${active.grantId}`;
    const envelope = createControlEnvelope({
      kind: 'agent-termination-command', requestId: commandId,
      guardianId: authority.guardianId, guardianControlInboxId: this.transport.inboxId,
      runnerId: active.certificate.runnerId, runnerDevicePublicKey: active.certificate.runnerPublicKey,
      runnerControlInboxId: active.certificate.runnerControlInboxId,
      agentId, grantId: active.grantId,
      sequence: this.state.nextSequence(scope),
      issuedAt: new Date().toISOString(), expiresAt: active.expiresAt,
      idempotencyKey: commandId, payload,
    }, authority.sign);
    this.state.setTerminationState(`${agentId}|${active.grantId}`, `sent:${mode}`);
    await this.transport.send(active.certificate.runnerControlInboxId, canonicalJson(envelope));
    return commandId;
  }

  async terminateAll(mode: AgentTerminationMode, reason: string): Promise<void> {
    for (const agentId of [...this.active.keys()]) await this.terminateAgent(agentId, mode, reason).catch(() => {});
  }

  async close(): Promise<void> {
    for (const timer of this.approvalTimers.values()) clearTimeout(timer);
    this.approvalTimers.clear();
    await this.state.flush();
    await this.transport.close();
  }

  private async receive(message: ControlTransportMessage): Promise<void> {
    if (this.state.hasMessage(message.id)) return;
    let envelope: ControlEnvelope;
    try { envelope = JSON.parse(message.content) as ControlEnvelope; } catch { return; }
    if (message.content !== canonicalJson(envelope)) return;
    if (!envelope || envelope.protocol !== AGENT_CONTROL_PROTOCOL || envelope.runnerControlInboxId !== message.senderInboxId || envelope.guardianControlInboxId !== this.transport.inboxId) return;
    if (envelope.kind === 'runner-enrollment') {
      await this.enroll(envelope as ControlEnvelope<RunnerEnrollmentPayload>, message);
      return;
    }
    const certificate = this.certificates.get(envelope.runnerId);
    if (!certificate) return;
    assertControlBindings(envelope, {
      guardianId: certificate.guardianId,
      guardianControlInboxId: certificate.guardianControlInboxId,
      runnerId: certificate.runnerId,
      runnerDevicePublicKey: certificate.runnerPublicKey,
      runnerControlInboxId: certificate.runnerControlInboxId,
    });
    verifyRunnerEnvelope(envelope, certificate.runnerPublicKey);
    const cached = this.state.idempotencyResult(envelope.idempotencyKey);
    if (cached && (envelope.kind === 'agent-start-request' || envelope.kind === 'privileged-request')) {
      this.state.markMessage(message.id);
      await this.transport.send(certificate.runnerControlInboxId, cached);
      return;
    }
    if (
      (envelope.kind === 'agent-start-request' && this.pendingStarts.has(envelope.requestId)) ||
      (envelope.kind === 'privileged-request' && this.pendingPrivileged.has(envelope.requestId))
    ) { this.state.markMessage(message.id); return; }
    const scope = `${certificate.guardianId}|${envelope.agentId ?? '-'}|${envelope.grantId ?? '-'}`;
    this.state.acceptInbound(scope, envelope.sequence);
    this.state.markMessage(message.id);
    if (envelope.kind === 'agent-start-request') return this.queueStart(envelope as ControlEnvelope<AgentStartRequestPayload>, certificate);
    if (envelope.kind === 'privileged-request') return this.queuePrivileged(envelope as ControlEnvelope<PrivilegedRequestPayload>);
    if (envelope.kind === 'runtime-audit-checkpoint') return this.recordCheckpoint(envelope as ControlEnvelope<RuntimeAuditCheckpointPayload>);
    if (envelope.kind === 'agent-termination-result') {
      this.state.setTerminationState(`${envelope.agentId}|${envelope.grantId}`, canonicalJson(envelope.payload));
      this.emit({ type: 'agent-terminated', agentId: envelope.agentId, grantId: envelope.grantId });
    }
  }

  private async enroll(envelope: ControlEnvelope<RunnerEnrollmentPayload>, message: ControlTransportMessage): Promise<void> {
    const offer = this.offers.get(message.senderInboxId);
    if (!offer || envelope.payload.pairingNonce !== offer.nonce || envelope.idempotencyKey !== offer.nonce) throw new Error('unapproved Runner enrollment');
    verifyRunnerEnvelope(envelope, offer.runnerDevicePublicKey);
    if (
      envelope.guardianId !== 'pending' || envelope.runnerId !== offer.runnerId ||
      envelope.runnerDevicePublicKey !== offer.runnerDevicePublicKey || envelope.runnerControlInboxId !== offer.runnerControlInboxId ||
      envelope.payload.network !== this.network
    ) throw new Error('Runner enrollment binding mismatch');
    this.state.acceptInbound(`pairing|${offer.nonce}`, envelope.sequence);
    const certificate = this.guardian.enrollRunner({
      runnerId: offer.runnerId,
      runnerPublicKey: offer.runnerDevicePublicKey,
      runnerControlInboxId: offer.runnerControlInboxId,
      guardianControlInboxId: this.transport.inboxId,
      network: this.network,
      environment: envelope.payload.environment,
    });
    this.certificates.set(certificate.runnerId, certificate);
    this.offers.delete(message.senderInboxId);
    this.state.markMessage(message.id);
    const authority = this.guardian.controlAuthority();
    const result = createControlEnvelope({
      kind: 'privileged-result', replyTo: envelope.requestId,
      guardianId: authority.guardianId, guardianControlInboxId: this.transport.inboxId,
      runnerId: certificate.runnerId, runnerDevicePublicKey: certificate.runnerPublicKey,
      runnerControlInboxId: certificate.runnerControlInboxId,
      sequence: this.state.nextSequence(`${authority.guardianId}|-|-`),
      expiresAt: certificate.expiresAt, idempotencyKey: offer.nonce,
      payload: { operation: 'runner.enroll', certificate } satisfies PrivilegedResultPayload,
    }, authority.sign);
    await this.transport.send(certificate.runnerControlInboxId, canonicalJson(result));
    this.emit({ type: 'runner-enrolled', runnerId: certificate.runnerId });
  }

  private async queueStart(envelope: ControlEnvelope<AgentStartRequestPayload>, certificate: RunnerCertificate): Promise<void> {
    if (!envelope.agentId || envelope.grantId !== undefined || envelope.payload.network !== this.network) throw new Error('invalid agent start binding');
    const cached = this.state.idempotencyResult(envelope.idempotencyKey);
    if (cached) { await this.transport.send(certificate.runnerControlInboxId, cached); return; }
    this.pendingStarts.set(envelope.requestId, { envelope, certificate });
    this.state.setPendingApproval(envelope.requestId, canonicalJson(envelope));
    this.scheduleApprovalExpiry(envelope.requestId, envelope.expiresAt, 'agent-start');
    this.emit({ type: 'approval-required', operation: 'agent-start', requestId: envelope.requestId, runnerId: envelope.runnerId, agentId: envelope.agentId });
  }

  private async queuePrivileged(envelope: ControlEnvelope<PrivilegedRequestPayload>): Promise<void> {
    if (!envelope.agentId || !envelope.grantId || envelope.payload.operation !== 'transaction.propose') throw new Error('invalid privileged request');
    const proposal = envelope.payload.proposal;
    if (
      proposal.agentId !== envelope.agentId || proposal.grantId !== envelope.grantId ||
      proposal.runnerId !== envelope.runnerId || proposal.network !== this.network
    ) throw new Error('privileged proposal binding mismatch');
    this.pendingPrivileged.set(envelope.requestId, envelope);
    this.state.setPendingApproval(envelope.requestId, canonicalJson(envelope));
    this.scheduleApprovalExpiry(envelope.requestId, envelope.expiresAt, 'transaction.propose');
    this.emit({ type: 'approval-required', operation: 'transaction.propose', requestId: envelope.requestId, runnerId: envelope.runnerId, agentId: envelope.agentId, grantId: envelope.grantId });
  }

  private recordCheckpoint(envelope: ControlEnvelope<RuntimeAuditCheckpointPayload>): void {
    if (!envelope.agentId || !envelope.grantId) throw new Error('audit checkpoint lacks agent binding');
    this.guardian.recordRunnerTelemetry(envelope.agentId, envelope.grantId, envelope.payload.auditDigest, envelope.payload.outcome);
    const active = this.active.get(envelope.agentId);
    if (active?.grantId === envelope.grantId) {
      this.guardian.finalizeAgent(envelope.agentId, envelope.grantId, envelope.payload.outcome);
      this.active.delete(envelope.agentId);
    }
    this.emit({ type: 'audit-checkpoint', agentId: envelope.agentId, grantId: envelope.grantId, detail: 'Untrusted Runner-reported telemetry recorded.' });
  }

  private async sendResult(request: ControlEnvelope, kind: 'agent-start-result' | 'privileged-result', payload: unknown, grantId?: string): Promise<void> {
    const certificate = this.certificates.get(request.runnerId);
    if (!certificate) throw new Error('Runner certificate is unavailable');
    const authority = this.guardian.controlAuthority();
    const scope = `${authority.guardianId}|${request.agentId ?? '-'}|${grantId ?? request.grantId ?? '-'}`;
    const result = createControlEnvelope({
      kind, replyTo: request.requestId,
      guardianId: authority.guardianId, guardianControlInboxId: this.transport.inboxId,
      runnerId: certificate.runnerId, runnerDevicePublicKey: certificate.runnerPublicKey,
      runnerControlInboxId: certificate.runnerControlInboxId,
      ...(request.agentId ? { agentId: request.agentId } : {}),
      ...(grantId ?? request.grantId ? { grantId: grantId ?? request.grantId } : {}),
      sequence: this.state.nextSequence(scope),
      expiresAt: request.expiresAt,
      idempotencyKey: request.idempotencyKey,
      payload,
    }, authority.sign);
    const encoded = canonicalJson(result);
    this.state.setIdempotencyResult(request.idempotencyKey, encoded);
    await this.transport.send(certificate.runnerControlInboxId, encoded);
  }

  private scheduleApprovalExpiry(requestId: string, expiresAt: string, operation: 'agent-start' | 'transaction.propose'): void {
    this.clearApprovalTimer(requestId);
    const timer = setTimeout(() => {
      this.approvalTimers.delete(requestId);
      if (operation === 'agent-start') this.pendingStarts.delete(requestId); else this.pendingPrivileged.delete(requestId);
      this.state.setPendingApproval(requestId);
    }, Math.max(1, Date.parse(expiresAt) - Date.now()));
    timer.unref();
    this.approvalTimers.set(requestId, timer);
  }

  private clearApprovalTimer(requestId: string): void {
    const timer = this.approvalTimers.get(requestId);
    if (timer) clearTimeout(timer);
    this.approvalTimers.delete(requestId);
  }
}
