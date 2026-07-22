import './polyfills.js';

import {
  decodeBackupBlob,
  deriveAgentAddresses,
  deriveEvmAgentKey,
  deriveStellarAgentKey,
  deriveXrplAgentKey,
  openPassphraseBlob,
  openSignatureBlob,
  passphraseKdfParams,
  verifyCommitment,
  zoneRootCommitmentHex,
  zoneSeed,
  type AgentChain,
  type BlobHeader,
  type Network,
  type ZoneRef,
} from '@mosaic/zone-keys';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { xrplTxnSignatureBytes } from '@mosaic/zone-keys/verify';
import {
  COMPANION_REQUEST_TTL_MS,
  canonicalJson as companionCanonicalJson,
  createCompanionEnvelope,
  verifyCompanionEnvelope,
  verifyCompanionOffer,
  type ApprovalDecisionPayload,
  type CompanionEnrollmentPayload,
  type CompanionEnvelope,
  type CompanionOffer,
} from '@mosaic/local-runtime/companion';
import { signXrplTransaction } from '@mosaic/xrpl';
import { signStellarTransaction } from '@mosaic/stellar';
import { signEvmTransfer } from '@mosaic/evm';

/**
 * `globalThis.MosaicBridge` — the surface the Swift host calls. Every input
 * and output is a hex string, JSON string, or primitive: no typed-array
 * marshaling across the JSC boundary. Derivation and signing happen inside
 * single calls so private keys never leave this context; only the 32-byte
 * zone secret enters, and each call zeroizes what it derived.
 *
 * This module re-exports FROZEN crypto from @mosaic/zone-keys unchanged —
 * never reimplement any of it here.
 */

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new Error('bridge: invalid hex');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function parseRef(refJson: string): ZoneRef {
  const parsed = JSON.parse(refJson) as ZoneRef;
  if (!parsed.rootChain || !parsed.rootAddress || !parsed.zone || !parsed.network) {
    throw new Error('bridge: incomplete ZoneRef');
  }
  return parsed;
}

function parseBlob(headerJson: string, ciphertextB64: string) {
  return decodeBackupBlob({ header: JSON.parse(headerJson) as BlobHeader, ciphertext: ciphertextB64 });
}

interface DerivedKey {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  address: string;
}

function deriveKey(secret: Uint8Array, ref: ZoneRef, chain: AgentChain, index: number): DerivedKey {
  const seed = zoneSeed(secret, ref);
  try {
    if (chain === 'xrpl') return deriveXrplAgentKey(seed, index);
    if (chain === 'stellar') return deriveStellarAgentKey(seed, index);
    return deriveEvmAgentKey(seed, index);
  } finally {
    seed.fill(0);
  }
}

/** Address equality per chain: EVM is case-insensitive (EIP-55), rest exact. */
function sameAddress(chain: AgentChain, a: string, b: string): boolean {
  return chain === 'evm' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function withKey<T>(
  secretHex: string,
  refJson: string,
  chain: AgentChain,
  index: number,
  expectedAddress: string | null,
  use: (key: DerivedKey) => T,
): T {
  const secret = hexToBytes(secretHex);
  let key: DerivedKey | undefined;
  try {
    key = deriveKey(secret, parseRef(refJson), chain, index);
    if (expectedAddress !== null && !sameAddress(chain, key.address, expectedAddress)) {
      throw new Error('bridge: derived signing key does not match the registered address');
    }
    return use(key);
  } finally {
    secret.fill(0);
    key?.privateKey.fill(0);
    key?.publicKey.fill(0);
  }
}

/** EIP-191 personal-message signature, byte-compatible with the desktop
 * Guardian's `signEip191` (r||s||v, v = 27 + recovery). */
function signEip191(privateKey: Uint8Array, message: string): Uint8Array {
  const messageBytes = utf8ToBytes(message);
  const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${messageBytes.length}`);
  const recovered = secp256k1.sign(keccak_256(concatBytes(prefix, messageBytes)), privateKey, {
    prehash: false,
    format: 'recovered',
  });
  return Uint8Array.from([...recovered.slice(1), recovered[0]! + 27]);
}

const bridge = {
  version: 1 as const,

  // MARK: derivation

  deriveAddresses(secretHex: string, refJson: string, index: number): string {
    const secret = hexToBytes(secretHex);
    try {
      return JSON.stringify(deriveAgentAddresses(secret, parseRef(refJson), index));
    } finally {
      secret.fill(0);
    }
  },

  verifyCommitment(secretHex: string, commitmentHex: string): boolean {
    const secret = hexToBytes(secretHex);
    try {
      return verifyCommitment(secret, commitmentHex);
    } finally {
      secret.fill(0);
    }
  },

  zoneRootCommitmentHex(secretHex: string): string {
    const secret = hexToBytes(secretHex);
    try {
      return zoneRootCommitmentHex(secret);
    } finally {
      secret.fill(0);
    }
  },

  // MARK: recovery blobs (unlock)

  openSignatureBlob(
    signatureHex: string,
    headerJson: string,
    ciphertextB64: string,
    refJson: string,
    commitmentHex: string,
  ): string {
    const secret = openSignatureBlob(
      hexToBytes(signatureHex),
      parseBlob(headerJson, ciphertextB64),
      parseRef(refJson),
      commitmentHex,
    );
    try {
      return bytesToHex(secret);
    } finally {
      secret.fill(0);
    }
  },

  openPassphraseBlob(
    kekHex: string,
    headerJson: string,
    ciphertextB64: string,
    refJson: string,
    commitmentHex: string,
  ): string {
    const secret = openPassphraseBlob(
      hexToBytes(kekHex),
      parseBlob(headerJson, ciphertextB64),
      parseRef(refJson),
      commitmentHex,
    );
    try {
      return bytesToHex(secret);
    } finally {
      secret.fill(0);
    }
  },

  /** TxnSignature bytes (hex) of a signed Xaman SignIn blob — the layer-1
   * wrapKey ikm for XRPL root wallets. */
  xrplTxnSignatureBytes(blobHex: string): string {
    return bytesToHex(xrplTxnSignatureBytes(blobHex));
  },

  /** Returns `{"saltHex":..,"m":..,"t":..,"p":..}`; asserts Argon2id V1 params. */
  passphraseKdfParams(headerJson: string, ciphertextB64: string): string {
    const params = passphraseKdfParams(parseBlob(headerJson, ciphertextB64));
    return JSON.stringify({ saltHex: bytesToHex(params.saltBytes), m: params.m, t: params.t, p: params.p });
  },

  // MARK: transfer signing (vault sources)

  signXrplTransfer(
    unsignedTxJson: string,
    secretHex: string,
    refJson: string,
    index: number,
    expectedAddress: string,
  ): string {
    return withKey(secretHex, refJson, 'xrpl', index, expectedAddress, (key) => {
      const signed = signXrplTransaction(
        JSON.parse(unsignedTxJson) as Parameters<typeof signXrplTransaction>[0],
        key.privateKey,
        key.publicKey,
      );
      return signed.txBlob;
    });
  },

  signStellarTransfer(
    unsignedXdr: string,
    network: string,
    secretHex: string,
    refJson: string,
    index: number,
    expectedAddress: string,
  ): string {
    return withKey(secretHex, refJson, 'stellar', index, expectedAddress, (key) =>
      signStellarTransaction(unsignedXdr, network as Network, key.privateKey),
    );
  },

  /** Async (viem): resolves to the raw serialized transaction hex. */
  signEvmTransfer(
    txJson: string,
    secretHex: string,
    refJson: string,
    index: number,
    expectedAddress: string,
  ): Promise<string> {
    const secret = hexToBytes(secretHex);
    let key: DerivedKey | undefined;
    try {
      key = deriveKey(secret, parseRef(refJson), 'evm', index);
      if (!sameAddress('evm', key.address, expectedAddress)) {
        throw new Error('bridge: derived signing key does not match the registered address');
      }
      const privateKey = key.privateKey.slice();
      return signEvmTransfer(JSON.parse(txJson) as Parameters<typeof signEvmTransfer>[0], privateKey).finally(
        () => privateKey.fill(0),
      );
    } finally {
      secret.fill(0);
      key?.privateKey.fill(0);
      key?.publicKey.fill(0);
    }
  },

  // MARK: guardian companion (Phase C)

  /** Address of the vault-derived guardian identity at `index` (an EVM agent
   * key registered under the name "guardian" by the desktop Guardian). */
  guardianAddress(secretHex: string, refJson: string, index: number): string {
    const secret = hexToBytes(secretHex);
    try {
      const key = deriveKey(secret, parseRef(refJson), 'evm', index);
      key.privateKey.fill(0);
      key.publicKey.fill(0);
      return key.address;
    } finally {
      secret.fill(0);
    }
  },

  /** EIP-191 signature (hex) over `text` by the vault-derived guardian key —
   * verifies under the same authority as desktop-signed control envelopes. */
  guardianSignText(secretHex: string, refJson: string, index: number, text: string): string {
    return withKey(secretHex, refJson, 'evm', index, null, (key) => bytesToHex(signEip191(key.privateKey, text)));
  },

  // MARK: companion protocol (ADR 0002) — the same pure code the desktop runs

  /** Validates a scanned pairing offer; throws on any tamper. Returns it back
   * as JSON for the host to keep. */
  companionVerifyOffer(offerJson: string): string {
    const offer = JSON.parse(offerJson) as CompanionOffer;
    verifyCompanionOffer(offer);
    return JSON.stringify(offer);
  },

  /** Verifies a received forward/resolved envelope against the guardian
   * authority address; returns the envelope JSON. */
  companionVerifyEnvelope(envelopeJson: string, guardianAddress: string): string {
    const envelope = JSON.parse(envelopeJson) as CompanionEnvelope;
    verifyCompanionEnvelope(envelope, guardianAddress);
    return JSON.stringify(envelope);
  },

  /** Enrollment envelope, signed by the vault-derived guardian key (the vault
   * must be unlocked — that IS the enrollment proof). Returns the canonical
   * string to send over the companion transport. */
  companionEnroll(
    offerJson: string,
    secretHex: string,
    refJson: string,
    companionInboxId: string,
    companionName: string,
    requestId: string,
  ): string {
    const offer = JSON.parse(offerJson) as CompanionOffer;
    verifyCompanionOffer(offer);
    return withKey(secretHex, refJson, 'evm', offer.authorityIndex, offer.guardianId, (key) => {
      const payload: CompanionEnrollmentPayload = {
        network: offer.network,
        pairingNonce: offer.nonce,
        companionName,
      };
      const envelope = createCompanionEnvelope(
        {
          kind: 'companion-enrollment',
          requestId,
          guardianId: offer.guardianId,
          guardianControlInboxId: offer.guardianControlInboxId,
          companionInboxId,
          sequence: 1,
          expiresAt: new Date(Date.now() + COMPANION_REQUEST_TTL_MS).toISOString(),
          payload,
        },
        (text) => signEip191(key.privateKey, text),
      );
      return companionCanonicalJson(envelope);
    });
  },

  /** Decision envelope over a verified forward. Returns the canonical string
   * to send. `decision` is approve | reject | revoke. */
  companionDecide(
    forwardJson: string,
    decision: string,
    reason: string,
    secretHex: string,
    refJson: string,
    authorityIndex: number,
    companionInboxId: string,
    sequence: number,
  ): string {
    const forward = JSON.parse(forwardJson) as CompanionEnvelope;
    if (decision !== 'approve' && decision !== 'reject' && decision !== 'revoke') {
      throw new Error('bridge: invalid companion decision');
    }
    return withKey(secretHex, refJson, 'evm', authorityIndex, forward.guardianId, (key) => {
      const payload: ApprovalDecisionPayload = {
        requestId: forward.requestId,
        decision,
        ...(reason ? { reason } : {}),
        forwardDigest: forward.payloadDigest,
      };
      const envelope = createCompanionEnvelope(
        {
          kind: 'approval-decision',
          requestId: forward.requestId,
          guardianId: forward.guardianId,
          guardianControlInboxId: forward.guardianControlInboxId,
          companionInboxId,
          sequence,
          expiresAt: new Date(Date.now() + COMPANION_REQUEST_TTL_MS).toISOString(),
          idempotencyKey: `${forward.requestId}:decision`,
          payload,
        },
        (text) => signEip191(key.privateKey, text),
      );
      return companionCanonicalJson(envelope);
    });
  },
};

declare global {
  // eslint-disable-next-line no-var
  var MosaicBridge: typeof bridge | undefined;
}

globalThis.MosaicBridge = bridge;

export type { ZoneRef };
export default bridge;
