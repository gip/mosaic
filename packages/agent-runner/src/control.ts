import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  AGENT_CONTROL_PROTOCOL,
  ATTENDED_REQUEST_TTL_MS,
  ControlStateStore,
  canonicalJson,
  createControlEnvelope,
  createPairingOffer,
  assertActiveWindow,
  assertControlBindings,
  loadOrCreateRunnerDeviceIdentity,
  mosaicRuntimeDirectory,
  signRunnerText,
  verifyGuardianControlEnvelope,
  verifyPairingOffer,
  type AgentExecutionPackage,
  type AgentStartResultPayload,
  type AgentTerminationCommandPayload,
  type AgentTerminationResultPayload,
  type ControlEnvelope,
  type PairingOffer,
  type PrivilegedResultPayload,
  type RunnerCertificate,
  type RuntimeAuditCheckpointPayload,
  type TransactionProposal,
  type TransactionResult,
} from '@mosaic/local-runtime';
import type { ControlTransport, ControlTransportMessage } from '@mosaic/local-runtime/control';
import type { SupervisorControl } from './multiSupervisor.js';
import { verifyGuardianEnvelope } from './supervisor.js';

interface PendingResponse {
  resolve(value: ControlEnvelope): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
  agentId: string;
  grantId?: string;
}

export class RunnerControlClient implements SupervisorControl {
  private readonly pending = new Map<string, PendingResponse>();
  private readonly state: ControlStateStore;
  private identity!: Awaited<ReturnType<typeof loadOrCreateRunnerDeviceIdentity>>;
  private offer?: PairingOffer;
  private certificate?: RunnerCertificate;
  private pairingGuardianInboxId?: string;
  private enrollmentWaiters: Array<{ resolve(value: RunnerCertificate): void; reject(error: Error): void }> = [];
  private terminationHandler?: (envelope: ControlEnvelope<AgentTerminationCommandPayload>) => Promise<AgentTerminationResultPayload>;

  constructor(private readonly transport: ControlTransport, private readonly network: 'testnet' | 'mainnet', private readonly runnerId = 'local-supervisor') {
    this.state = new ControlStateStore(join(mosaicRuntimeDirectory(), 'control', `runner-${network}-state.json`));
  }

  async start(): Promise<void> {
    const directory = join(mosaicRuntimeDirectory(), 'control', `runner-${this.network}`);
    this.identity = await loadOrCreateRunnerDeviceIdentity(directory, this.runnerId);
    await this.state.load();
    this.offer = createPairingOffer({
      identity: this.identity,
      runnerControlAddress: this.transport.address,
      runnerControlInboxId: this.transport.inboxId,
      network: this.network,
    });
    await this.transport.start((message) => this.receive(message));
  }

  pairingOffer(): PairingOffer {
    if (!this.offer) throw new Error('Runner control is not started');
    return structuredClone(this.offer);
  }

  beginPairing(): PairingOffer {
    this.certificate = undefined;
    this.pairingGuardianInboxId = undefined;
    this.offer = createPairingOffer({
      identity: this.identity,
      runnerControlAddress: this.transport.address,
      runnerControlInboxId: this.transport.inboxId,
      network: this.network,
    });
    return structuredClone(this.offer);
  }

  enrolledCertificate(): RunnerCertificate | undefined { return this.certificate && structuredClone(this.certificate); }

  waitForEnrollment(timeoutMs = ATTENDED_REQUEST_TTL_MS): Promise<RunnerCertificate> {
    if (this.certificate) return Promise.resolve(structuredClone(this.certificate));
    return new Promise((resolve, reject) => {
      const waiter: { resolve(value: RunnerCertificate): void; reject(error: Error): void } = {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      };
      const timeout = setTimeout(() => {
        this.enrollmentWaiters = this.enrollmentWaiters.filter((candidate) => candidate !== waiter);
        reject(new Error('Runner enrollment timed out'));
      }, timeoutMs);
      this.enrollmentWaiters.push(waiter);
    });
  }

  onTermination(handler: (envelope: ControlEnvelope<AgentTerminationCommandPayload>) => Promise<AgentTerminationResultPayload>): void {
    this.terminationHandler = handler;
  }

  async requestAgentStart(agentId: string, supervisorKeyLeasePublicKeyB64: string): Promise<AgentExecutionPackage> {
    const response = await this.request('agent-start-request', { network: this.network, supervisorKeyLeasePublicKeyB64 }, agentId);
    if (response.kind !== 'agent-start-result') throw new Error('unexpected agent start response');
    const payload = response.payload as AgentStartResultPayload;
    if (!payload.ok || !payload.execution) throw new Error(payload.error?.message ?? 'Guardian rejected agent start');
    if (response.agentId !== agentId || response.grantId !== payload.execution.grant.grantId) throw new Error('agent start result binding mismatch');
    return payload.execution;
  }

  async proposeTransaction(proposal: TransactionProposal): Promise<TransactionResult> {
    const response = await this.request('privileged-request', { operation: 'transaction.propose', proposal }, proposal.agentId, proposal.grantId);
    if (response.kind !== 'privileged-result') throw new Error('unexpected privileged response');
    const payload = response.payload as PrivilegedResultPayload;
    if (payload.operation !== 'transaction.propose' || !payload.result) throw new Error('invalid transaction result');
    if (response.agentId !== proposal.agentId || response.grantId !== proposal.grantId || payload.result.requestId !== proposal.requestId) {
      throw new Error('transaction result binding mismatch');
    }
    return payload.result;
  }

  async sendAuditCheckpoint(checkpoint: {
    agentId: string; grantId: string; auditDigest: string; eventCount: number;
    outcome: 'completed' | 'stopped' | 'killed' | 'expired' | 'crashed'; forced: boolean; incomplete: boolean;
  }): Promise<void> {
    const certificate = this.requireCertificate();
    const payload: RuntimeAuditCheckpointPayload = {
      checkpointId: randomUUID(), auditDigest: checkpoint.auditDigest, eventCount: checkpoint.eventCount,
      outcome: checkpoint.outcome, forced: checkpoint.forced, incomplete: checkpoint.incomplete, stoppedAt: new Date().toISOString(),
    };
    const envelope = this.runnerEnvelope('runtime-audit-checkpoint', payload, checkpoint.agentId, checkpoint.grantId, certificate);
    const encoded = canonicalJson(envelope);
    this.state.setUnsentCheckpoint(payload.checkpointId, encoded);
    await this.transport.send(certificate.guardianControlInboxId, encoded);
    this.state.setUnsentCheckpoint(payload.checkpointId);
  }

  cancelAgentRequests(agentId: string, grantId: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.agentId !== agentId || (pending.grantId !== undefined && pending.grantId !== grantId)) continue;
      this.pending.delete(requestId);
      clearTimeout(pending.timeout);
      pending.reject(new Error('agent terminated'));
    }
  }

  async close(): Promise<void> {
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(new Error('Runner control closed')); }
    this.pending.clear();
    await this.state.flush();
    await this.transport.close();
  }

  private async request(kind: 'agent-start-request' | 'privileged-request', payload: unknown, agentId: string, grantId?: string): Promise<ControlEnvelope> {
    const certificate = this.requireCertificate();
    const requestId = randomUUID();
    const envelope = this.runnerEnvelope(kind, payload, agentId, grantId, certificate, requestId);
    const response = new Promise<ControlEnvelope>((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`${kind} timed out`)); }, ATTENDED_REQUEST_TTL_MS);
      this.pending.set(requestId, { resolve, reject, timeout, agentId, ...(grantId ? { grantId } : {}) });
    });
    try {
      await this.transport.send(certificate.guardianControlInboxId, canonicalJson(envelope));
    } catch (error) {
      const pending = this.pending.get(requestId);
      if (pending) clearTimeout(pending.timeout);
      this.pending.delete(requestId);
      throw error;
    }
    return response;
  }

  private runnerEnvelope(kind: ControlEnvelope['kind'], payload: unknown, agentId: string | undefined, grantId: string | undefined, certificate: RunnerCertificate, requestId?: string): ControlEnvelope {
    const scope = `${certificate.guardianId}|${agentId ?? '-'}|${grantId ?? '-'}`;
    return createControlEnvelope({
      kind,
      requestId,
      guardianId: certificate.guardianId,
      guardianControlInboxId: certificate.guardianControlInboxId,
      runnerId: this.runnerId,
      runnerDevicePublicKey: this.identity.publicKeyB64,
      runnerControlInboxId: this.transport.inboxId,
      ...(agentId ? { agentId } : {}),
      ...(grantId ? { grantId } : {}),
      sequence: this.state.nextSequence(scope),
      expiresAt: new Date(Date.now() + ATTENDED_REQUEST_TTL_MS).toISOString(),
      payload,
    }, (text) => signRunnerText(this.identity.privateKeyB64, text));
  }

  private async receive(message: ControlTransportMessage): Promise<void> {
    if (this.state.hasMessage(message.id)) return;
    let raw: unknown;
    try { raw = JSON.parse(message.content); } catch { return; }
    if (message.content !== canonicalJson(raw)) return;
    if (isPairingOffer(raw)) {
      if (!this.offer || canonicalJson(raw) !== canonicalJson(this.offer)) return;
      verifyPairingOffer(raw);
      if (this.pairingGuardianInboxId && this.pairingGuardianInboxId !== message.senderInboxId) return;
      this.pairingGuardianInboxId = message.senderInboxId;
      await this.sendEnrollment(raw, message.senderInboxId);
      this.state.markMessage(message.id);
      return;
    }
    const envelope = raw as ControlEnvelope;
    if (!envelope || envelope.protocol !== AGENT_CONTROL_PROTOCOL || message.senderInboxId !== envelope.guardianControlInboxId) return;
    if (envelope.kind === 'privileged-result' && (envelope.payload as PrivilegedResultPayload)?.operation === 'runner.enroll') {
      await this.acceptEnrollment(envelope as ControlEnvelope<PrivilegedResultPayload>, message);
      return;
    }
    const certificate = this.requireCertificate();
    assertControlBindings(envelope, {
      guardianId: certificate.guardianId,
      guardianControlInboxId: certificate.guardianControlInboxId,
      runnerId: certificate.runnerId,
      runnerDevicePublicKey: certificate.runnerPublicKey,
      runnerControlInboxId: certificate.runnerControlInboxId,
    });
    verifyGuardianControlEnvelope(envelope, certificate.guardianAddress);
    if (envelope.kind === 'agent-termination-command' && this.state.idempotencyResult(envelope.idempotencyKey)) {
      this.state.markMessage(message.id);
      await this.handleTermination(envelope as ControlEnvelope<AgentTerminationCommandPayload>);
      return;
    }
    const scope = `${certificate.guardianId}|${envelope.agentId ?? '-'}|${envelope.grantId ?? '-'}`;
    this.state.acceptInbound(scope, envelope.sequence);
    this.state.markMessage(message.id);
    if (envelope.kind === 'agent-termination-command') {
      const command = envelope as ControlEnvelope<AgentTerminationCommandPayload>;
      try { await this.handleTermination(command); }
      catch {
        this.state.setIdempotencyResult(command.idempotencyKey, canonicalJson({
          commandId: command.payload.commandId,
          mode: command.payload.mode,
          outcome: 'rejected',
          stoppedAt: new Date().toISOString(),
          finalAuditDigest: '0'.repeat(64),
          forced: false,
        } satisfies AgentTerminationResultPayload));
        await this.handleTermination(command);
      }
      return;
    }
    const correlation = envelope.replyTo && this.pending.get(envelope.replyTo);
    if (correlation) {
      this.pending.delete(envelope.replyTo!);
      clearTimeout(correlation.timeout);
      correlation.resolve(envelope);
    }
  }

  private async sendEnrollment(offer: PairingOffer, guardianInboxId: string): Promise<void> {
    const requestId = randomUUID();
    const envelope = createControlEnvelope({
      kind: 'runner-enrollment', requestId,
      guardianId: 'pending', guardianControlInboxId: guardianInboxId,
      runnerId: this.runnerId, runnerDevicePublicKey: this.identity.publicKeyB64,
      runnerControlInboxId: this.transport.inboxId,
      sequence: this.state.nextSequence(`pairing|${offer.nonce}`),
      expiresAt: offer.expiresAt,
      idempotencyKey: offer.nonce,
      payload: { network: this.network, environment: 'local', pairingNonce: offer.nonce },
    }, (text) => signRunnerText(this.identity.privateKeyB64, text));
    await this.transport.send(guardianInboxId, canonicalJson(envelope));
  }

  private async acceptEnrollment(envelope: ControlEnvelope<PrivilegedResultPayload>, message: ControlTransportMessage): Promise<void> {
    const certificate = envelope.payload.certificate;
    if (!certificate || !this.offer || !this.pairingGuardianInboxId || message.senderInboxId !== this.pairingGuardianInboxId || message.senderInboxId !== certificate.guardianControlInboxId) throw new Error('invalid enrollment response');
    verifyGuardianEnvelope(certificate, certificate.guardianAddress);
    verifyGuardianControlEnvelope(envelope, certificate.guardianAddress);
    if (
      certificate.runnerId !== this.runnerId || certificate.runnerPublicKey !== this.identity.publicKeyB64 ||
      certificate.runnerControlInboxId !== this.transport.inboxId || certificate.guardianControlInboxId !== message.senderInboxId ||
      certificate.network !== this.network
    ) throw new Error('Runner certificate binding mismatch');
    this.state.acceptInbound(`${certificate.guardianId}|-|-`, envelope.sequence);
    this.certificate = certificate;
    this.state.markMessage(message.id);
    for (const waiter of this.enrollmentWaiters.splice(0)) waiter.resolve(structuredClone(certificate));
    await this.flushCheckpoints();
  }

  private async handleTermination(envelope: ControlEnvelope<AgentTerminationCommandPayload>): Promise<void> {
    const certificate = this.requireCertificate();
    const cached = this.state.idempotencyResult(envelope.idempotencyKey);
    let payload: AgentTerminationResultPayload;
    if (cached) payload = JSON.parse(cached) as AgentTerminationResultPayload;
    else {
      if (!this.terminationHandler) throw new Error('termination handler is unavailable');
      payload = await this.terminationHandler(envelope);
      this.state.setIdempotencyResult(envelope.idempotencyKey, canonicalJson(payload));
      this.state.setTerminationState(`${envelope.agentId}|${envelope.grantId}`, payload.outcome);
    }
    const response = createControlEnvelope({
      kind: 'agent-termination-result', replyTo: envelope.requestId,
      guardianId: certificate.guardianId, guardianControlInboxId: certificate.guardianControlInboxId,
      runnerId: certificate.runnerId, runnerDevicePublicKey: certificate.runnerPublicKey,
      runnerControlInboxId: certificate.runnerControlInboxId,
      agentId: envelope.agentId, grantId: envelope.grantId,
      sequence: this.state.nextSequence(`${certificate.guardianId}|${envelope.agentId}|${envelope.grantId}`),
      expiresAt: envelope.expiresAt, idempotencyKey: envelope.idempotencyKey, payload,
    }, (text) => signRunnerText(this.identity.privateKeyB64, text));
    await this.transport.send(certificate.guardianControlInboxId, canonicalJson(response));
  }

  private requireCertificate(): RunnerCertificate {
    if (!this.certificate) throw new Error('Supervisor is not enrolled');
    assertActiveWindow(this.certificate.issuedAt, this.certificate.expiresAt);
    return this.certificate;
  }

  private async flushCheckpoints(): Promise<void> {
    for (const [checkpointId, encoded] of Object.entries(this.state.unsentCheckpoints())) {
      const envelope = JSON.parse(encoded) as ControlEnvelope;
      if (envelope.runnerId !== this.runnerId || envelope.runnerControlInboxId !== this.transport.inboxId) continue;
      await this.transport.send(envelope.guardianControlInboxId, encoded);
      this.state.setUnsentCheckpoint(checkpointId);
    }
  }
}

function isPairingOffer(value: unknown): value is PairingOffer {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'pairing-offer';
}
