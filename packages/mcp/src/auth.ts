import { randomBytes } from 'node:crypto';
import {
  EVM_CHAIN_IDS,
  authorizeZoneMessage,
  sessionAuthMessage,
  type AuthorizeZoneMessage,
  type Network,
  type RootChain,
  type SessionAuthMessage,
  type ZoneRef,
} from '@mosaic/zone-keys';
import {
  verifyEvmZoneSignature,
  verifyStellarZoneSignature,
  verifyXrplSignInBlob,
} from '@mosaic/zone-keys/verify';
import { MosaicMcpError } from './errors.js';
import { SESSION_TTL_MS, type MosaicStore, type SessionRecord } from './store.js';
import { checkXrplSignerAuthority } from './xrplLedger.js';
import type { XamanService } from './xaman.js';

const CHALLENGE_TTL_MS = 5 * 60_000;

export type SignatureEnvelope =
  | { type: 'evm'; signature: `0x${string}` }
  | { type: 'stellar'; signatureB64: string }
  | { type: 'xrpl'; payloadUuid: string };

export interface Session extends SessionRecord {
  token: string;
}

export function validateNetwork(value: string): Network {
  if (value === 'mainnet' || value === 'testnet') return value;
  throw new MosaicMcpError('VALIDATION_FAILED', `invalid network: ${value}`);
}

export function validateChain(value: string): RootChain {
  if (value === 'evm' || value === 'xrpl' || value === 'stellar') return value;
  throw new MosaicMcpError('VALIDATION_FAILED', `invalid chain: ${value}`);
}

export class AuthService {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();
  private readonly checkAuthority: typeof checkXrplSignerAuthority;

  constructor(
    private readonly store: MosaicStore,
    private readonly xaman?: XamanService,
    opts: { checkAuthority?: typeof checkXrplSignerAuthority } = {},
  ) {
    this.checkAuthority = opts.checkAuthority ?? checkXrplSignerAuthority;
  }

  private rateLimit(key: string, limit = 20, windowMs = 60_000): void {
    const now = Date.now();
    const current = this.attempts.get(key);
    if (!current || current.resetAt < now) {
      if (this.attempts.size > 1_000) {
        for (const [k, v] of this.attempts) if (v.resetAt < now) this.attempts.delete(k);
      }
      this.attempts.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }
    current.count += 1;
    if (current.count > limit) {
      throw new MosaicMcpError('RATE_LIMITED', 'authentication rate limit exceeded');
    }
  }

  private requireXaman(): XamanService {
    if (!this.xaman) {
      throw new MosaicMcpError('XAMAN_UNAVAILABLE', 'Xaman is not configured (XAMAN_API_KEY/XAMAN_API_SECRET)');
    }
    return this.xaman;
  }

  /**
   * Issue a session-auth challenge. For EVM/Stellar the client signs the
   * returned canonical message. For XRPL a Xaman SignIn payload is created
   * server-side and the client renders its QR; the root address is learned
   * from the signed payload, so the message carries rootAddress "".
   */
  async challenge(args: { chain: RootChain; address?: string; network: Network }): Promise<{
    challengeId: string;
    message: SessionAuthMessage;
    expiresAt: string;
    evmChainId?: number;
    xaman?: { uuid: string; qrPng: string; websocketStatus: string; deeplink: string };
  }> {
    const { chain, network } = args;
    const address = args.address ?? '';
    if (chain !== 'xrpl' && !address) {
      throw new MosaicMcpError('VALIDATION_FAILED', `${chain} challenge requires an address`);
    }
    this.rateLimit(`challenge:${address || 'xrpl-qr'}`);

    const challengeId = randomBytes(16).toString('hex');
    const nonce = randomBytes(24).toString('hex');
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
    const message = sessionAuthMessage({
      rootChain: chain,
      rootAddress: chain === 'xrpl' ? '' : address,
      network,
      nonce,
      issuedAt,
      expiresAt,
    });

    await this.store.createChallenge({
      id: challengeId,
      purpose: 'session-auth',
      chain,
      address: chain === 'xrpl' ? null : address,
      network,
      message: message as unknown as Record<string, unknown>,
      nonce,
      issuedAt,
      expiresAt,
    });

    if (chain === 'xrpl') {
      const refs = await this.requireXaman().createSignInPayload(message, 'Sign in to Mosaic');
      await this.store.attachXamanUuid(challengeId, refs.uuid);
      return { challengeId, message, expiresAt, xaman: refs };
    }
    return {
      challengeId,
      message,
      expiresAt,
      ...(chain === 'evm' ? { evmChainId: EVM_CHAIN_IDS[network] } : {}),
    };
  }

  /** Verify a signed session-auth challenge and mint a session token. */
  async verify(args: {
    challengeId: string;
    signature?: SignatureEnvelope;
  }): Promise<{ token: string; chain: RootChain; address: string; network: Network; expiresAt: number }> {
    const challenge = await this.store.consumeChallenge(args.challengeId);
    if (!challenge || challenge.purpose !== 'session-auth') {
      throw new MosaicMcpError('AUTH_INVALID', 'unknown or already-used challenge');
    }
    this.rateLimit(`verify:${challenge.address ?? challenge.id}`);
    if (Date.now() > new Date(challenge.expiresAt).getTime()) {
      throw new MosaicMcpError('AUTH_EXPIRED', 'challenge expired');
    }
    const message = challenge.message as unknown as SessionAuthMessage;

    let address: string;
    if (challenge.chain === 'xrpl') {
      address = await this.verifyXrplPayload(challenge.xamanPayloadUuid, message, challenge.network, undefined);
    } else {
      if (!args.signature || args.signature.type !== challenge.chain) {
        throw new MosaicMcpError('VALIDATION_FAILED', `expected a ${challenge.chain} signature`);
      }
      address = challenge.address!;
      if (args.signature.type === 'evm') {
        const ok = await verifyEvmZoneSignature(message, EVM_CHAIN_IDS[challenge.network], args.signature.signature, address);
        if (!ok) throw new MosaicMcpError('AUTH_INVALID', 'EVM signature verification failed');
      } else if (args.signature.type === 'stellar') {
        const signature = Buffer.from(args.signature.signatureB64, 'base64');
        if (!verifyStellarZoneSignature(message, new Uint8Array(signature), address)) {
          throw new MosaicMcpError('AUTH_INVALID', 'Stellar signature verification failed');
        }
      }
    }

    const expiresAt = Date.now() + SESSION_TTL_MS;
    const { token } = await this.store.createSession({
      chain: challenge.chain,
      address,
      network: challenge.network,
      expiresAt,
    });
    return { token, chain: challenge.chain, address, network: challenge.network, expiresAt };
  }

  /** Fetch a signed Xaman payload, verify blob + memo + ledger authority. */
  private async verifyXrplPayload(
    uuid: string | null | undefined,
    expectedMessage: SessionAuthMessage | AuthorizeZoneMessage,
    network: Network,
    expectedAccount: string | undefined,
  ): Promise<string> {
    if (!uuid) throw new MosaicMcpError('AUTH_INVALID', 'challenge has no Xaman payload');
    const result = await this.requireXaman().getPayloadResult(uuid);
    if (!result.resolved || !result.signed || !result.hex) {
      throw new MosaicMcpError('AUTH_INVALID', 'Xaman payload is not signed yet');
    }
    const verification = verifyXrplSignInBlob(result.hex, {
      message: expectedMessage,
      ...(expectedAccount ? { account: expectedAccount } : {}),
    });
    if (!verification.valid || !verification.account || !verification.signerAddress) {
      throw new MosaicMcpError('AUTH_INVALID', `XRPL signature verification failed: ${verification.error}`);
    }
    const authority = await this.checkAuthority(verification.account, verification.signerAddress, network);
    if (!authority.authoritative) {
      throw new MosaicMcpError('AUTH_INVALID', `XRPL signing key not authoritative: ${authority.reason}`);
    }
    return verification.account;
  }

  async requireSession(token: string): Promise<Session> {
    const session = await this.store.getSession(token);
    if (!session) throw new MosaicMcpError('AUTH_EXPIRED', 'invalid or expired session');
    return { ...session, token };
  }

  async logout(token: string): Promise<void> {
    await this.store.deleteSession(token);
  }

  /** Issue server freshness (nonce/issuedAt/expiresAt) for an authorize-zone signature. */
  async zoneBegin(session: Session, zone: string): Promise<{
    challengeId: string;
    nonce: string;
    issuedAt: string;
    expiresAt: string;
  }> {
    this.rateLimit(`zone-begin:${session.address}`);
    const challengeId = randomBytes(16).toString('hex');
    const nonce = randomBytes(24).toString('hex');
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
    await this.store.createChallenge({
      id: challengeId,
      purpose: 'authorize-zone',
      chain: session.chain,
      address: session.address,
      network: session.network,
      message: { zone },
      nonce,
      issuedAt,
      expiresAt,
    });
    return { challengeId, nonce, issuedAt, expiresAt };
  }

  /**
   * Verify an authorize-zone signature. The canonical message is REBUILT from
   * the session identity + server-issued freshness + client-supplied zone
   * fields — the client never supplies rootChain/rootAddress/network/nonce.
   */
  async verifyAuthorizeZone(
    session: Session,
    args: {
      challengeId: string;
      zone: string;
      localSignerPublicKey: string;
      policyHash: string;
      zoneRootCommitment: string;
      signature: SignatureEnvelope;
    },
  ): Promise<{ message: AuthorizeZoneMessage }> {
    const challenge = await this.store.consumeChallenge(args.challengeId);
    if (!challenge || challenge.purpose !== 'authorize-zone' || challenge.address !== session.address) {
      throw new MosaicMcpError('AUTH_INVALID', 'unknown or mismatched authorize-zone challenge');
    }
    if (Date.now() > new Date(challenge.expiresAt).getTime()) {
      throw new MosaicMcpError('AUTH_EXPIRED', 'authorize-zone challenge expired');
    }
    if ((challenge.message as { zone?: unknown }).zone !== args.zone) {
      throw new MosaicMcpError('VALIDATION_FAILED', 'zone does not match the challenge');
    }

    const ref: ZoneRef = {
      rootChain: session.chain,
      rootAddress: session.address,
      zone: args.zone,
      network: session.network,
    };
    const message = authorizeZoneMessage(ref, {
      localSignerPublicKey: args.localSignerPublicKey,
      policyHash: args.policyHash,
      zoneRootCommitment: args.zoneRootCommitment,
      nonce: challenge.nonce,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
    });

    if (args.signature.type !== session.chain) {
      throw new MosaicMcpError('VALIDATION_FAILED', `expected a ${session.chain} signature`);
    }
    if (args.signature.type === 'evm') {
      const ok = await verifyEvmZoneSignature(message, EVM_CHAIN_IDS[session.network], args.signature.signature, session.address);
      if (!ok) throw new MosaicMcpError('AUTH_INVALID', 'EVM authorize-zone signature verification failed');
    } else if (args.signature.type === 'stellar') {
      const signature = Buffer.from(args.signature.signatureB64, 'base64');
      if (!verifyStellarZoneSignature(message, new Uint8Array(signature), session.address)) {
        throw new MosaicMcpError('AUTH_INVALID', 'Stellar authorize-zone signature verification failed');
      }
    } else {
      await this.verifyXrplPayload(args.signature.payloadUuid, message, session.network, session.address);
    }
    return { message };
  }
}
