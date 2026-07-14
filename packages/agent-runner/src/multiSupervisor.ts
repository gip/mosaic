import { randomUUID } from 'node:crypto';
import {
  AGENT_CONTROL_PROTOCOL,
  ATTENDED_REQUEST_TTL_MS,
  generateKeyLeaseRecipient,
  openAgentKeyLease,
  type AgentExecutionPackage,
  type AgentTerminationMode,
  type AgentRuntimeEvent,
  type RunnerCertificate,
  type TransactionProposal,
  type TransactionResult,
} from '@mosaic/local-runtime';
import { AgentSupervisor, verifyExecutionAuthorization } from './supervisor.js';
import { createAgentXmtpClient, type AgentXmtpClient, type XmtpInboundMessage } from './xmtp.js';

interface AgentInstance {
  agentId: string;
  execution: AgentExecutionPackage;
  sandbox: AgentSupervisor;
  xmtp: AgentXmtpClient;
  secretBuffers: Map<string, Uint8Array>;
  eventQueue: XmtpInboundMessage[];
  delivering: boolean;
  deadLetters: number;
  stopped: boolean;
}

export interface SupervisorControl {
  requestAgentStart(agentId: string, supervisorKeyLeasePublicKeyB64: string): Promise<AgentExecutionPackage>;
  proposeTransaction(proposal: TransactionProposal): Promise<TransactionResult>;
  sendAuditCheckpoint(checkpoint: {
    agentId: string; grantId: string; auditDigest: string; eventCount: number;
    outcome: 'completed' | 'stopped' | 'killed' | 'expired' | 'crashed'; forced: boolean; incomplete: boolean;
  }): Promise<void>;
  cancelAgentRequests(agentId: string, grantId: string): void;
}

export interface ArtifactDownloader {
  download(ticket: string): Promise<{ artifactDigest: string; runnerCertificateDigest: string; manifest: AgentExecutionPackage['manifest']; source: string }>;
}

export interface AgentInstanceStatus {
  agentId: string;
  grantId: string;
  artifactDigest: string;
  policyRevision: number;
  xmtpAddress: string;
  expiresAt: string;
  queuedEvents: number;
  deadLetters: number;
  state: 'running' | 'stopping';
}

export class MultiAgentSupervisor {
  private readonly agents = new Map<string, AgentInstance>();
  private leaseRecipient = generateKeyLeaseRecipient();

  constructor(
    private readonly control: SupervisorControl,
    private readonly certificate: RunnerCertificate,
    private readonly artifacts: ArtifactDownloader,
  ) {}

  async start(agentId: string): Promise<AgentInstanceStatus> {
    if (this.agents.has(agentId)) throw new Error(`agent is already running: ${agentId}`);
    const execution = await this.control.requestAgentStart(agentId, this.leaseRecipient.publicKeyB64);
    const artifact = await this.artifacts.download(execution.artifactTicket);
    if (artifact.artifactDigest !== execution.grant.artifactDigest || artifact.runnerCertificateDigest !== execution.grant.certificateDigest) {
      throw new Error('artifact ticket binding mismatch');
    }
    verifyExecutionAuthorization({
      certificate: this.certificate,
      grant: execution.grant,
      source: artifact.source,
      runnerId: this.certificate.runnerId,
      runnerPublicKey: this.certificate.runnerPublicKey,
      expectedGuardianAddress: this.certificate.guardianAddress,
    });
    if (execution.agentId !== agentId || execution.grant.agentId !== agentId) {
      throw new Error('Guardian execution package agent binding mismatch');
    }
    const secretBuffers = this.openLease(execution);
    const ownerKey = secretBuffers.get('xmtp-owner');
    const databaseKey = secretBuffers.get('xmtp-database');
    if (!ownerKey || !databaseKey) { this.zeroSecrets(secretBuffers); throw new Error('execution lease is missing XMTP keys'); }
    const resources = execution.grant.resources.filter((resource) => resource.kind === 'xmtp-contact');
    let xmtp: AgentXmtpClient;
    try {
      xmtp = await createAgentXmtpClient({
        agentId,
        network: execution.grant.network,
        address: execution.grant.xmtpAddress,
        ownerKey,
        databaseKey,
        resources,
      });
    } catch (error) { this.zeroSecrets(secretBuffers); throw error; }
    let transactionSequence = 0;
    const sandbox = new AgentSupervisor({
      xmtpSend: (resourceId, text) => xmtp.send(resourceId, text),
      transactionPropose: async (argumentsValue) => {
        const keyId = argumentsValue.keyId;
        const chain = argumentsValue.chain;
        const intentType = argumentsValue.intentType;
        const intent = argumentsValue.intent;
        if (typeof keyId !== 'string' || !['evm', 'xrpl', 'stellar'].includes(String(chain)) || typeof intentType !== 'string' || !intent || typeof intent !== 'object' || Array.isArray(intent)) {
          throw new Error('invalid transaction proposal arguments');
        }
        const requestId = randomUUID();
        const proposal: TransactionProposal = {
          protocol: AGENT_CONTROL_PROTOCOL, kind: 'transaction-proposal', agentId,
          grantId: execution.grant.grantId, runnerId: execution.grant.runnerId,
          sequence: ++transactionSequence, requestId, keyId,
          chain: chain as TransactionProposal['chain'], network: execution.grant.network,
          intentType, intent: intent as Record<string, unknown>,
          deadline: new Date(Date.now() + ATTENDED_REQUEST_TTL_MS).toISOString(), idempotencyKey: requestId,
        };
        return this.control.proposeTransaction(proposal);
      },
    });
    const instance: AgentInstance = {
      agentId, execution, sandbox, xmtp, secretBuffers,
      eventQueue: [], delivering: false, deadLetters: 0, stopped: false,
    };
    this.agents.set(agentId, instance);
    void sandbox.run(artifact.source, execution.grant)
      .then(() => this.finish(instance, 'completed', false, false))
      .catch(() => this.finish(instance, Date.now() >= Date.parse(execution.grant.expiresAt) ? 'expired' : 'crashed', true, false));
    try {
      await xmtp.start((message) => this.enqueue(instance, message));
      const status = this.status(agentId);
      if (!status) throw new Error(`agent stopped during startup: ${agentId}`);
      return status;
    } catch (error) { await this.stop(agentId); throw error; }
  }

  async stop(agentId: string, mode: AgentTerminationMode = 'graceful'): Promise<{ outcome: 'stopped' | 'killed' | 'already-stopped'; auditDigest: string; forced: boolean }> {
    const instance = this.agents.get(agentId);
    if (!instance || instance.stopped) return { outcome: 'already-stopped', auditDigest: '0'.repeat(64), forced: mode === 'immediate' };
    instance.stopped = true;
    this.agents.delete(agentId);
    instance.sandbox.rejectNewWork();
    this.control.cancelAgentRequests(agentId, instance.execution.grant.grantId);
    await instance.xmtp.close().catch(() => {});
    instance.eventQueue.length = 0;
    if (mode === 'graceful') {
      const stopping: AgentRuntimeEvent = {
        protocol: AGENT_CONTROL_PROTOCOL, type: 'runtime-event', agentId, grantId: instance.execution.grant.grantId,
        eventId: randomUUID(), eventType: 'runtime.stopping', sentAt: new Date().toISOString(), payload: { reason: 'guardian-stop' },
      };
      instance.sandbox.notifyStopping(stopping);
      await instance.sandbox.stopGracefully(5_000);
    } else await instance.sandbox.killImmediately();
    this.zeroSecrets(instance.secretBuffers);
    await this.control.sendAuditCheckpoint({
      agentId, grantId: instance.execution.grant.grantId, auditDigest: instance.sandbox.auditDigest(),
      eventCount: instance.sandbox.auditEventCount(), outcome: mode === 'immediate' ? 'killed' : 'stopped',
      forced: mode === 'immediate', incomplete: false,
    }).catch(() => {});
    return { outcome: mode === 'immediate' ? 'killed' : 'stopped', auditDigest: instance.sandbox.auditDigest(), forced: mode === 'immediate' };
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.agents.keys()].map((agentId) => this.stop(agentId, 'immediate')));
    this.leaseRecipient.privateKey.fill(0);
  }

  list(): AgentInstanceStatus[] { return [...this.agents.keys()].sort().map((agentId) => this.status(agentId)!); }

  status(agentId: string): AgentInstanceStatus | undefined {
    const instance = this.agents.get(agentId);
    if (!instance) return undefined;
    const { grant } = instance.execution;
    return {
      agentId, grantId: grant.grantId, artifactDigest: grant.artifactDigest,
      policyRevision: grant.policyRevision, xmtpAddress: grant.xmtpAddress,
      expiresAt: instance.execution.sealedKeyLease.expiresAt,
      queuedEvents: instance.eventQueue.length, deadLetters: instance.deadLetters,
      state: instance.stopped ? 'stopping' : 'running',
    };
  }

  private openLease(execution: AgentExecutionPackage): Map<string, Uint8Array> {
    const payload = openAgentKeyLease(execution.sealedKeyLease, this.leaseRecipient.privateKey);
    if (
      payload.agentId !== execution.agentId || payload.grantId !== execution.grant.grantId ||
      payload.certificateDigest !== execution.grant.certificateDigest
    ) throw new Error('key lease execution binding mismatch');
    const buffers = new Map<string, Uint8Array>();
    for (const secret of payload.secrets) {
      buffers.set(secret.keyId, new Uint8Array(Buffer.from(secret.materialB64, 'base64')));
      secret.materialB64 = '';
    }
    return buffers;
  }

  private async enqueue(instance: AgentInstance, message: XmtpInboundMessage): Promise<void> {
    if (instance.stopped) return;
    const maxQueue = instance.execution.grant.limits.maxEventQueue ?? 128;
    if (instance.eventQueue.length >= maxQueue) { instance.deadLetters += 1; return; }
    instance.eventQueue.push(message);
    if (!instance.delivering) void this.drain(instance);
  }

  private async drain(instance: AgentInstance): Promise<void> {
    instance.delivering = true;
    try {
      while (!instance.stopped && instance.eventQueue.length) {
        const message = instance.eventQueue[0]!;
        const event: AgentRuntimeEvent = {
          protocol: AGENT_CONTROL_PROTOCOL,
          type: 'runtime-event', agentId: instance.agentId, grantId: instance.execution.grant.grantId,
          eventId: randomUUID(), eventType: 'xmtp.message', resourceId: message.resourceId,
          messageId: message.messageId, sentAt: message.sentAt,
          payload: { resourceId: message.resourceId, messageId: message.messageId, sentAt: message.sentAt, text: message.text },
        };
        let delivered = false;
        for (let attempt = 0; attempt < 3 && !delivered; attempt++) {
          try { await instance.sandbox.deliverEvent(event); delivered = true; }
          catch { /* retry same event and do not advance cursor */ }
        }
        instance.eventQueue.shift();
        if (delivered) await instance.xmtp.acknowledge(message.messageId);
        else instance.deadLetters += 1;
      }
    } finally { instance.delivering = false; }
  }

  private zeroSecrets(secrets: Map<string, Uint8Array>): void {
    for (const value of secrets.values()) value.fill(0);
    secrets.clear();
  }

  private async finish(instance: AgentInstance, outcome: 'completed' | 'expired' | 'crashed', incomplete: boolean, forced: boolean): Promise<void> {
    if (this.agents.get(instance.agentId) !== instance) return;
    instance.stopped = true;
    this.agents.delete(instance.agentId);
    await instance.xmtp.close().catch(() => {});
    instance.eventQueue.length = 0;
    this.zeroSecrets(instance.secretBuffers);
    await this.control.sendAuditCheckpoint({
      agentId: instance.agentId, grantId: instance.execution.grant.grantId,
      auditDigest: instance.sandbox.auditDigest(), eventCount: instance.sandbox.auditEventCount(), outcome, incomplete, forced,
    }).catch(() => {});
  }
}
