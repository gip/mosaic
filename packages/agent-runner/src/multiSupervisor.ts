import { randomUUID } from 'node:crypto';
import {
  AGENT_CONTROL_PROTOCOL,
  DEFAULT_OFFLINE_GRACE_MS,
  GuardianControlClient,
  generateKeyLeaseRecipient,
  openAgentKeyLease,
  type AgentExecutionPackage,
  type AgentLeaseRenewalPackage,
  type AgentRuntimeEvent,
  type RunnerCertificate,
  type TransactionProposal,
} from '@mosaic/local-runtime';
import { AgentSupervisor, verifyExecutionAuthorization, verifyGuardianEnvelope } from './supervisor.js';
import { createAgentXmtpClient, type AgentXmtpClient, type XmtpInboundMessage } from './xmtp.js';

interface AgentInstance {
  agentId: string;
  execution: AgentExecutionPackage;
  sandbox: AgentSupervisor;
  xmtp: AgentXmtpClient;
  secretBuffers: Map<string, Uint8Array>;
  renewalTimer: NodeJS.Timeout;
  graceTimer?: NodeJS.Timeout;
  eventQueue: XmtpInboundMessage[];
  delivering: boolean;
  deadLetters: number;
  stopped: boolean;
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
    private readonly control: GuardianControlClient,
    private readonly certificate: RunnerCertificate,
  ) {
    // The control client reconnects on the next call, so the recipient key
    // must be replaced, not just zeroed: leases sealed after the blip go to
    // the fresh public key advertised by start()/renew().
    control.onDisconnect(() => {
      this.leaseRecipient.privateKey.fill(0);
      this.leaseRecipient = generateKeyLeaseRecipient();
      for (const instance of this.agents.values()) this.beginOfflineGrace(instance);
    });
  }

  async start(agentId: string): Promise<AgentInstanceStatus> {
    if (this.agents.has(agentId)) throw new Error(`agent is already running: ${agentId}`);
    const execution = await this.control.call<AgentExecutionPackage>('agent.prepare', {
      agentId,
      certificate: this.certificate as unknown as Record<string, unknown>,
      supervisorKeyLeasePublicKeyB64: this.leaseRecipient.publicKeyB64,
    }, 60_000);
    verifyExecutionAuthorization({
      certificate: this.certificate,
      grant: execution.grant,
      source: execution.source,
      runnerId: this.certificate.runnerId,
      runnerPublicKey: this.certificate.runnerPublicKey,
      expectedGuardianAddress: this.certificate.guardianAddress,
    });
    if (execution.agentId !== agentId || execution.grant.agentId !== agentId || execution.manifest.agentId !== agentId) {
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
      authorize: async (request) => { await this.control.call('capability.authorize', { request: request as unknown as Record<string, unknown> }); },
      record: async (request, result) => { await this.control.call('capability.record', {
        request: request as unknown as Record<string, unknown>, result: result as unknown as Record<string, unknown>,
      }); },
    }, {
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
          deadline: new Date(Date.now() + 10_000).toISOString(), idempotencyKey: requestId,
        };
        return this.control.call('transaction.propose', { proposal: proposal as unknown as Record<string, unknown> });
      },
    });
    const instance: AgentInstance = {
      agentId, execution, sandbox, xmtp, secretBuffers,
      renewalTimer: setInterval(() => void this.renew(agentId), 30_000),
      eventQueue: [], delivering: false, deadLetters: 0, stopped: false,
    };
    instance.renewalTimer.unref();
    this.agents.set(agentId, instance);
    void sandbox.run(execution.source, execution.grant)
      .catch(() => {})
      .finally(() => { if (this.agents.get(agentId) === instance) void this.stop(agentId); });
    try {
      await xmtp.start((message) => this.enqueue(instance, message));
      const status = this.status(agentId);
      if (!status) throw new Error(`agent stopped during startup: ${agentId}`);
      return status;
    } catch (error) { await this.stop(agentId); throw error; }
  }

  async stop(agentId: string): Promise<void> {
    const instance = this.agents.get(agentId);
    if (!instance || instance.stopped) return;
    instance.stopped = true;
    this.agents.delete(agentId);
    clearInterval(instance.renewalTimer);
    if (instance.graceTimer) clearTimeout(instance.graceTimer);
    instance.sandbox.stop();
    await instance.xmtp.close().catch(() => {});
    this.zeroSecrets(instance.secretBuffers);
    await this.control.call('agent.stop', { agentId, grantId: instance.execution.grant.grantId }).catch(() => {});
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.agents.keys()].map((agentId) => this.stop(agentId)));
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

  private async renew(agentId: string): Promise<void> {
    const instance = this.agents.get(agentId);
    if (!instance || instance.stopped) return;
    try {
      const renewed = await this.control.call<AgentLeaseRenewalPackage>('lease.renew', {
        agentId,
        grantId: instance.execution.grant.grantId,
        supervisorKeyLeasePublicKeyB64: this.leaseRecipient.publicKeyB64,
      }, 10_000);
      if (renewed.renewal.agentId !== agentId || renewed.renewal.grantId !== instance.execution.grant.grantId) throw new Error('lease renewal binding mismatch');
      verifyGuardianEnvelope(renewed.renewal, this.certificate.guardianAddress);
      const replacement = this.openLease({ ...instance.execution, sealedKeyLease: renewed.sealedKeyLease });
      for (const [keyId, current] of instance.secretBuffers) {
        const next = replacement.get(keyId);
        if (!next || !Buffer.from(current).equals(Buffer.from(next))) {
          this.zeroSecrets(replacement);
          throw new Error(`communication identity changed during renewal: ${keyId}`);
        }
      }
      this.zeroSecrets(replacement);
      await instance.xmtp.updateResources(renewed.renewal.resources.filter((resource) => resource.kind === 'xmtp-contact'));
      instance.execution = { ...instance.execution, sealedKeyLease: renewed.sealedKeyLease };
      instance.sandbox.extendLease(renewed.renewal.expiresAt, renewed.renewal.maxOfflineMs);
      if (instance.graceTimer) { clearTimeout(instance.graceTimer); instance.graceTimer = undefined; }
    } catch {
      this.beginOfflineGrace(instance);
    }
  }

  private async enqueue(instance: AgentInstance, message: XmtpInboundMessage): Promise<void> {
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

  private beginOfflineGrace(instance: AgentInstance): void {
    if (instance.stopped || instance.graceTimer) return;
    instance.graceTimer = setTimeout(() => void this.stop(instance.agentId), DEFAULT_OFFLINE_GRACE_MS);
    instance.graceTimer.unref();
  }
}
