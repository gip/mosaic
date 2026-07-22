import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  AGENT_CONTROL_PROTOCOL,
  ATTENDED_REQUEST_TTL_MS,
  MAX_CONTROL_MESSAGE_BYTES,
  PAIRING_TTL_MS,
  assertActiveWindow,
  canonicalJson,
  type DigestHex,
  type MosaicNetwork,
} from './contracts.js';

/**
 * iOS companion Guardian protocol (ADR 0002), additive to control V3. The
 * phone is an attended approval/revocation endpoint: the desktop Guardian
 * forwards pending approvals to the companion inbox and accepts decisions
 * signed by the SAME vault-derived guardian authority key it uses itself —
 * no new authority cryptography exists. XMTP is transport only.
 *
 * This module is deliberately PURE (noble only, no node: imports) so the
 * exact same code bundles into @mosaic/mobile-bridge and runs on the phone.
 */

export { canonicalJson } from './contracts.js';

export type CompanionMessageKind =
  | 'companion-enrollment'
  | 'approval-forward'
  | 'approval-decision'
  | 'approval-resolved';

export const COMPANION_PAIRING_TTL_MS = PAIRING_TTL_MS;
export const COMPANION_REQUEST_TTL_MS = ATTENDED_REQUEST_TTL_MS;

/** Desktop-guardian-signed pairing offer, shown to the phone as a QR code. */
export interface CompanionOffer {
  protocol: typeof AGENT_CONTROL_PROTOCOL;
  kind: 'companion-offer';
  /** Vault-derived guardian authority address (EVM). */
  guardianId: string;
  guardianControlInboxId: string;
  /** Zone (vault) name and agent index of the guardian identity — lets the
   * companion derive the same authority key after unlocking the vault. */
  vault: string;
  authorityIndex: number;
  network: MosaicNetwork;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  signatureB64: string;
}

export interface CompanionEnvelope<T = unknown> {
  protocol: typeof AGENT_CONTROL_PROTOCOL;
  kind: CompanionMessageKind;
  requestId: string;
  guardianId: string;
  guardianControlInboxId: string;
  companionInboxId: string;
  sequence: number;
  issuedAt: string;
  expiresAt: string;
  idempotencyKey: string;
  payloadDigest: DigestHex;
  payload: T;
  signatureB64: string;
}

export interface CompanionEnrollmentPayload {
  network: MosaicNetwork;
  pairingNonce: string;
  companionName: string;
}

export interface ApprovalForwardPayload {
  operation: 'agent-start' | 'transaction.propose';
  /** requestId of the original Runner envelope awaiting approval. */
  requestId: string;
  agentId?: string;
  grantId?: string;
  network: MosaicNetwork;
  /** Human-reviewable facts (intent type, chain, deadline, digests). */
  summary: Record<string, unknown>;
}

export interface ApprovalDecisionPayload {
  /** requestId of the original Runner envelope (matches the forward). */
  requestId: string;
  decision: 'approve' | 'reject' | 'revoke';
  reason?: string;
  /** payloadDigest of the approval-forward this decision answers. */
  forwardDigest: DigestHex;
}

export interface ApprovalResolvedPayload {
  requestId: string;
  outcome: 'approved' | 'rejected' | 'revoked' | 'expired' | 'failed';
  detail?: string;
}

const COMPANION_KINDS = new Set<CompanionMessageKind>([
  'companion-enrollment',
  'approval-forward',
  'approval-decision',
  'approval-resolved',
]);

/** Pure sha256-hex over canonical JSON — identical output to contractDigest. */
export function companionDigest(value: unknown): DigestHex {
  return bytesToHex(sha256(utf8ToBytes(canonicalJson(value))));
}

/** Recover the EIP-191 signer address of `text` from a 65-byte r||s||v sig. */
export function recoverEip191Address(text: string, signatureB64: string): string {
  const signature = base64ToBytes(signatureB64);
  if (signature.length !== 65 || (signature[64] !== 27 && signature[64] !== 28)) {
    throw new Error('invalid companion signature encoding');
  }
  const bytes = utf8ToBytes(text);
  const digest = keccak_256(concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${bytes.length}`), bytes));
  const recovered = new Uint8Array([signature[64]! - 27, ...signature.slice(0, 64)]);
  const recoveredKey = secp256k1.recoverPublicKey(recovered, digest, { prehash: false });
  const publicKey = secp256k1.Point.fromBytes(recoveredKey).toBytes(false);
  return `0x${bytesToHex(keccak_256(publicKey.slice(1)).slice(-20))}`;
}

export function companionOfferSignatureText(offer: CompanionOffer): string {
  const { signatureB64: _signature, ...unsigned } = offer;
  return `${AGENT_CONTROL_PROTOCOL}:companion-offer\n${canonicalJson(unsigned)}`;
}

export function createCompanionOffer(
  params: {
    guardianId: string;
    guardianControlInboxId: string;
    vault: string;
    authorityIndex: number;
    network: MosaicNetwork;
    /** 32-byte hex nonce supplied by the caller (randomness is host-provided). */
    nonce: string;
    now?: number;
  },
  sign: (text: string) => Uint8Array,
): CompanionOffer {
  const issued = params.now ?? Date.now();
  const offer: CompanionOffer = {
    protocol: AGENT_CONTROL_PROTOCOL,
    kind: 'companion-offer',
    guardianId: params.guardianId,
    guardianControlInboxId: params.guardianControlInboxId,
    vault: params.vault,
    authorityIndex: params.authorityIndex,
    network: params.network,
    nonce: params.nonce,
    issuedAt: new Date(issued).toISOString(),
    expiresAt: new Date(issued + COMPANION_PAIRING_TTL_MS).toISOString(),
    signatureB64: '',
  };
  offer.signatureB64 = bytesToBase64(sign(companionOfferSignatureText(offer)));
  verifyCompanionOffer(offer, issued);
  return offer;
}

export function verifyCompanionOffer(offer: CompanionOffer, now = Date.now()): void {
  if (offer.protocol !== AGENT_CONTROL_PROTOCOL || offer.kind !== 'companion-offer') {
    throw new Error('invalid companion offer protocol');
  }
  const expected = ['protocol', 'kind', 'guardianId', 'guardianControlInboxId', 'vault', 'authorityIndex', 'network', 'nonce', 'issuedAt', 'expiresAt', 'signatureB64'];
  const unknown = Object.keys(offer).find((key) => !expected.includes(key));
  if (unknown || Object.keys(offer).length !== expected.length) throw new Error('companion offer fields are invalid');
  if (!/^0x[0-9a-fA-F]{40}$/.test(offer.guardianId) || !offer.guardianControlInboxId) throw new Error('companion offer identity is invalid');
  if (typeof offer.vault !== 'string' || !offer.vault || !Number.isSafeInteger(offer.authorityIndex) || offer.authorityIndex < 0) throw new Error('companion offer authority binding is invalid');
  if (!/^[0-9a-f]{64}$/.test(offer.nonce) || (offer.network !== 'testnet' && offer.network !== 'mainnet')) throw new Error('companion offer scope is invalid');
  assertActiveWindow(offer.issuedAt, offer.expiresAt, now);
  if (Date.parse(offer.expiresAt) - Date.parse(offer.issuedAt) > COMPANION_PAIRING_TTL_MS) throw new Error('companion offer lifetime is too long');
  if (recoverEip191Address(companionOfferSignatureText(offer), offer.signatureB64).toLowerCase() !== offer.guardianId.toLowerCase()) {
    throw new Error('invalid companion offer signature');
  }
}

export function unsignedCompanionEnvelope<T>(envelope: CompanionEnvelope<T>): Omit<CompanionEnvelope<T>, 'signatureB64'> {
  const { signatureB64: _signature, ...unsigned } = envelope;
  return unsigned;
}

export function companionEnvelopeSignatureText<T>(envelope: CompanionEnvelope<T>): string {
  return `${AGENT_CONTROL_PROTOCOL}:${envelope.kind}\n${canonicalJson(unsignedCompanionEnvelope(envelope))}`;
}

export interface CreateCompanionEnvelope<T> {
  kind: CompanionMessageKind;
  requestId: string;
  guardianId: string;
  guardianControlInboxId: string;
  companionInboxId: string;
  sequence: number;
  issuedAt?: string;
  expiresAt: string;
  idempotencyKey?: string;
  payload: T;
}

export function createCompanionEnvelope<T>(
  input: CreateCompanionEnvelope<T>,
  sign: (text: string) => Uint8Array,
): CompanionEnvelope<T> {
  const envelope: CompanionEnvelope<T> = {
    protocol: AGENT_CONTROL_PROTOCOL,
    kind: input.kind,
    requestId: input.requestId,
    guardianId: input.guardianId,
    guardianControlInboxId: input.guardianControlInboxId,
    companionInboxId: input.companionInboxId,
    sequence: input.sequence,
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    expiresAt: input.expiresAt,
    idempotencyKey: input.idempotencyKey ?? input.requestId,
    payloadDigest: companionDigest(input.payload),
    payload: input.payload,
    signatureB64: '',
  };
  envelope.signatureB64 = bytesToBase64(sign(companionEnvelopeSignatureText(envelope)));
  assertCompanionEnvelope(envelope);
  return envelope;
}

export function assertCompanionEnvelope<T>(envelope: CompanionEnvelope<T>, now = Date.now()): void {
  if (!envelope || envelope.protocol !== AGENT_CONTROL_PROTOCOL) throw new Error('unsupported companion protocol');
  if (!COMPANION_KINDS.has(envelope.kind)) throw new Error('unsupported companion message kind');
  const allowed = new Set([
    'protocol', 'kind', 'requestId', 'guardianId', 'guardianControlInboxId', 'companionInboxId',
    'sequence', 'issuedAt', 'expiresAt', 'idempotencyKey', 'payloadDigest', 'payload', 'signatureB64',
  ]);
  const unknown = Object.keys(envelope).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`companion envelope contains unknown field: ${unknown}`);
  for (const [label, value] of [
    ['requestId', envelope.requestId],
    ['guardianId', envelope.guardianId],
    ['guardianControlInboxId', envelope.guardianControlInboxId],
    ['companionInboxId', envelope.companionInboxId],
    ['idempotencyKey', envelope.idempotencyKey],
    ['signatureB64', envelope.signatureB64],
  ] as const) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 2048) throw new Error(`invalid ${label}`);
  }
  if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1) throw new Error('invalid companion sequence');
  assertActiveWindow(envelope.issuedAt, envelope.expiresAt, now);
  if (envelope.payloadDigest !== companionDigest(envelope.payload)) throw new Error('companion payload digest mismatch');
  if (utf8ToBytes(canonicalJson(envelope)).length > MAX_CONTROL_MESSAGE_BYTES) throw new Error('companion message exceeds maximum size');
}

/** Both directions verify under the one vault-derived guardian authority. */
export function verifyCompanionEnvelope<T>(envelope: CompanionEnvelope<T>, expectedGuardianAddress: string, now = Date.now()): void {
  assertCompanionEnvelope(envelope, now);
  if (envelope.guardianId.toLowerCase() !== expectedGuardianAddress.toLowerCase()) {
    throw new Error('companion envelope guardian mismatch');
  }
  const signer = recoverEip191Address(companionEnvelopeSignatureText(envelope), envelope.signatureB64);
  if (signer.toLowerCase() !== expectedGuardianAddress.toLowerCase()) {
    throw new Error('companion envelope signer mismatch');
  }
}

// Pure base64 helpers (no Buffer/atob dependency).
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += BASE64_ALPHABET[a >> 2]!;
    out += BASE64_ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    out += b === undefined ? '=' : BASE64_ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    out += c === undefined ? '=' : BASE64_ALPHABET[c & 63]!;
  }
  return out;
}

function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = BASE64_ALPHABET.indexOf(char);
    if (value < 0) throw new Error('invalid base64');
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}
