import { randomBytes } from 'node:crypto';
import {
  COMPANION_REQUEST_TTL_MS,
  canonicalJson,
  companionDigest,
  createCompanionEnvelope,
  createCompanionOffer,
  verifyCompanionEnvelope,
  type ApprovalDecisionPayload,
  type ApprovalForwardPayload,
  type ApprovalResolvedPayload,
  type CompanionEnrollmentPayload,
  type CompanionEnvelope,
  type CompanionOffer,
} from '@mosaic/local-runtime';
import type { ControlTransport, ControlTransportMessage } from '@mosaic/local-runtime/control';
import type { GuardianService } from './service.js';
import type { GuardianXmtpControl } from './control.js';

/**
 * Desktop side of the iOS companion Guardian (ADR 0002). The phone enrolls by
 * proving control of the SAME vault-derived guardian authority key (its
 * enrollment envelope must verify under it — which requires the vault
 * unlocked on the phone). Afterwards every pending approval is forwarded to
 * the companion inbox and a content-free APNs wake-up is requested via the
 * MCP `push_notify` tool; decisions come back signed by the same authority.
 * Grant/lease issuance stays on the desktop — the phone only decides.
 */
export interface CompanionEvent {
  type: 'companion-enrolled' | 'companion-decision' | 'companion-error';
  requestId?: string;
  decision?: string;
  detail?: string;
}

interface ForwardRecord {
  operation: 'agent-start' | 'transaction.propose';
  agentId?: string;
  forwardDigest: string;
}

export class GuardianCompanionControl {
  private companionInboxId?: string;
  private sequence = 0;
  private readonly forwarded = new Map<string, ForwardRecord>();
  private pendingOffer?: CompanionOffer;

  constructor(
    private readonly guardian: GuardianService,
    private readonly control: GuardianXmtpControl,
    private readonly transport: ControlTransport,
    private readonly network: 'testnet' | 'mainnet',
    private readonly emit: (event: CompanionEvent) => void,
    /** Content-free wake-up via the MCP push_notify tool; optional. */
    private readonly pushNotify?: (category: 'approval' | 'activity') => Promise<void>,
  ) {}

  /** QR payload for the phone. Requires the Guardian vault to be running. */
  createOffer(): CompanionOffer {
    const authority = this.guardian.controlAuthority();
    const identity = this.guardianIdentity();
    const offer = createCompanionOffer(
      {
        guardianId: authority.guardianAddress,
        guardianControlInboxId: this.transport.inboxId,
        vault: identity.vault,
        authorityIndex: identity.index,
        network: this.network,
        nonce: randomBytes(32).toString('hex'),
      },
      authority.sign,
    );
    this.pendingOffer = offer;
    return offer;
  }

  companion(): { inboxId?: string } {
    return { inboxId: this.companionInboxId };
  }

  /** Companion messages routed here by GuardianXmtpControl.receive(). */
  async receive(envelope: CompanionEnvelope, message: ControlTransportMessage): Promise<void> {
    try {
      const authority = this.guardian.controlAuthority();
      verifyCompanionEnvelope(envelope, authority.guardianAddress);
      if (envelope.kind === 'companion-enrollment') {
        await this.enroll(envelope as CompanionEnvelope<CompanionEnrollmentPayload>, message);
        return;
      }
      if (envelope.kind === 'approval-decision') {
        if (envelope.companionInboxId !== message.senderInboxId || envelope.companionInboxId !== this.companionInboxId) {
          throw new Error('companion decision from an unenrolled inbox');
        }
        await this.applyDecision(envelope as CompanionEnvelope<ApprovalDecisionPayload>);
      }
    } catch (error) {
      this.emit({
        type: 'companion-error',
        requestId: envelope.requestId,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async enroll(envelope: CompanionEnvelope<CompanionEnrollmentPayload>, message: ControlTransportMessage): Promise<void> {
    const offer = this.pendingOffer;
    if (!offer || envelope.payload.pairingNonce !== offer.nonce) throw new Error('unapproved companion enrollment');
    if (envelope.payload.network !== this.network) throw new Error('companion enrollment network mismatch');
    if (envelope.companionInboxId !== message.senderInboxId) throw new Error('companion enrollment inbox mismatch');
    this.pendingOffer = undefined;
    this.companionInboxId = envelope.companionInboxId;
    this.emit({ type: 'companion-enrolled', detail: envelope.payload.companionName });
    // Push anything already waiting.
    for (const pending of this.control.pendingApprovals()) {
      await this.forwardApproval(pending.requestId, pending.operation, pending.agentId, pending.grantId);
    }
  }

  /** Called by GuardianXmtpControl when a new approval is queued. */
  async forwardApproval(
    requestId: string,
    operation: 'agent-start' | 'transaction.propose',
    agentId?: string,
    grantId?: string,
    summary: Record<string, unknown> = {},
  ): Promise<void> {
    if (!this.companionInboxId) return;
    const authority = this.guardian.controlAuthority();
    const payload: ApprovalForwardPayload = {
      operation,
      requestId,
      ...(agentId ? { agentId } : {}),
      ...(grantId ? { grantId } : {}),
      network: this.network,
      summary,
    };
    const envelope = createCompanionEnvelope(
      {
        kind: 'approval-forward',
        requestId,
        guardianId: authority.guardianAddress,
        guardianControlInboxId: this.transport.inboxId,
        companionInboxId: this.companionInboxId,
        sequence: ++this.sequence,
        expiresAt: new Date(Date.now() + COMPANION_REQUEST_TTL_MS).toISOString(),
        payload,
      },
      authority.sign,
    );
    this.forwarded.set(requestId, { operation, agentId, forwardDigest: envelope.payloadDigest });
    await this.transport.send(this.companionInboxId, canonicalJson(envelope));
    await this.pushNotify?.('approval').catch(() => {});
  }

  private async applyDecision(envelope: CompanionEnvelope<ApprovalDecisionPayload>): Promise<void> {
    const decision = envelope.payload;
    const record = this.forwarded.get(decision.requestId);
    if (!record) throw new Error('decision for an unknown or resolved approval');
    if (decision.forwardDigest !== record.forwardDigest) throw new Error('companion decision digest mismatch');
    this.forwarded.delete(decision.requestId);
    let detail: string | undefined;
    try {
      // approve/reject resolutions are echoed back by GuardianXmtpControl's
      // own resolution paths; only revoke and failures resolve from here.
      if (decision.decision === 'approve') {
        if (record.operation === 'agent-start') await this.control.approveAgentStart(decision.requestId);
        else await this.control.resolvePrivileged(decision.requestId);
      } else if (decision.decision === 'reject') {
        await this.control.rejectApproval(decision.requestId, decision.reason ?? 'Rejected from companion');
      } else {
        if (!record.agentId) throw new Error('revoke requires an agent binding');
        await this.control.terminateAgent(record.agentId, 'immediate', decision.reason ?? 'Revoked from companion');
        await this.sendResolved(decision.requestId, 'revoked');
      }
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
      await this.sendResolved(decision.requestId, 'failed', detail);
    }
    this.emit({ type: 'companion-decision', requestId: decision.requestId, decision: decision.decision, detail });
  }

  async sendResolved(requestId: string, outcome: ApprovalResolvedPayload['outcome'], detail?: string): Promise<void> {
    if (!this.companionInboxId) return;
    this.forwarded.delete(requestId);
    const authority = this.guardian.controlAuthority();
    const payload: ApprovalResolvedPayload = { requestId, outcome, ...(detail ? { detail } : {}) };
    const envelope = createCompanionEnvelope(
      {
        kind: 'approval-resolved',
        requestId,
        guardianId: authority.guardianAddress,
        guardianControlInboxId: this.transport.inboxId,
        companionInboxId: this.companionInboxId,
        sequence: ++this.sequence,
        expiresAt: new Date(Date.now() + COMPANION_REQUEST_TTL_MS).toISOString(),
        idempotencyKey: `${requestId}:resolved`,
        payload,
      },
      authority.sign,
    );
    await this.transport.send(this.companionInboxId, canonicalJson(envelope));
  }

  /** Digest guard for the enrollment/decision replay window. */
  static isCompanionKind(kind: unknown): boolean {
    return kind === 'companion-enrollment' || kind === 'approval-decision';
  }

  private guardianIdentity(): { vault: string; index: number } {
    const authority = this.guardian.controlAuthority();
    const [vault, , index] = authority.guardianId.split(':');
    return { vault: vault ?? '', index: Number(index ?? 0) };
  }
}

export { companionDigest };
