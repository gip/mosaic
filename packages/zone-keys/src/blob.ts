import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes, randomBytes } from '@noble/hashes/utils.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { base64 } from '@scure/base';
import { canonicalBytes } from './canonical.js';
import { zoneRootCommitment, zoneRootCommitmentHex, ZONE_ROOT_SECRET_LENGTH } from './commitment.js';
import { backupWrapMessage } from './messages.js';
import type { ZoneRef } from './types.js';
import type { WrappedVaultData, VaultDataBlobHeader } from './vaultData.js';

/**
 * Recovery blob crypto (spec §4). Two wrap paths over the same AEAD:
 *  - Layer 1: wrapKey derived from the wallet's deterministic backup-wrap signature
 *  - Layer 2: kek derived from a passphrase via Argon2id (computed by the caller,
 *    in a worker in the browser; params are recorded in the header and asserted
 *    on unwrap)
 * AAD is the canonical backup-wrap message, binding ciphertext to the zone.
 */

/** FROZEN domain string (spec §4.1). */
export const BACKUP_DOMAIN_V1 = 'MOSAIC_BACKUP_V1';

/**
 * Determinism self-test (spec §4.1): two signatures over the byte-identical
 * backup-wrap request must match byte-for-byte, or layer 1 cannot exist —
 * browser zones must reject the wallet outright.
 */
export function backupSignaturesDeterministic(sig1: Uint8Array, sig2: Uint8Array): boolean {
  if (sig1.length === 0 || sig1.length !== sig2.length) return false;
  let diff = 0;
  for (let i = 0; i < sig1.length; i++) diff |= sig1[i]! ^ sig2[i]!;
  return diff === 0;
}

/** Argon2id v1 parameters (spec §4.2): m=256 MiB, t=3, p=1. */
export const ARGON2_PARAMS_V1 = { type: 'argon2id', m: 262144, t: 3, p: 1 } as const;

export const BLOB_NONCE_LENGTH = 24;

export interface SigKdfInfo {
  type: 'sig-hkdf-v1';
}

export interface PassKdfInfo {
  type: 'argon2id';
  salt: string; // base64, 16 bytes
  m: number; // KiB
  t: number;
  p: number;
}

export interface BlobHeader {
  v: 1;
  alg: 'xchacha20poly1305';
  nonce: string; // base64, 24 bytes
  kdf: SigKdfInfo | PassKdfInfo;
}

export interface WrappedBlob {
  header: BlobHeader;
  ciphertext: Uint8Array;
}

/**
 * Layer-1 wrap key (spec §4.1):
 *   wrapKey = HKDF-SHA256(ikm  = signature bytes,
 *                         salt = zoneRootCommitment,
 *                         info = "MOSAIC_BACKUP_V1" || rootAddress || zone || network)
 */
export function wrapKeyFromSignature(
  signature: Uint8Array,
  commitment: Uint8Array,
  ref: ZoneRef,
): Uint8Array {
  if (signature.length === 0) throw new Error('blob: empty signature');
  const info = concatBytes(
    utf8ToBytes(BACKUP_DOMAIN_V1),
    utf8ToBytes(ref.rootAddress),
    utf8ToBytes(ref.zone),
    utf8ToBytes(ref.network),
  );
  return hkdf(sha256, signature, commitment, info, 32);
}

function blobAad(ref: ZoneRef): Uint8Array {
  return canonicalBytes(backupWrapMessage(ref));
}

function seal(key: Uint8Array, zoneRootSecret: Uint8Array, ref: ZoneRef, kdf: BlobHeader['kdf']): WrappedBlob {
  if (zoneRootSecret.length !== ZONE_ROOT_SECRET_LENGTH) {
    throw new Error(`blob: zoneRootSecret must be ${ZONE_ROOT_SECRET_LENGTH} bytes`);
  }
  const nonce = randomBytes(BLOB_NONCE_LENGTH);
  const ciphertext = xchacha20poly1305(key, nonce, blobAad(ref)).encrypt(zoneRootSecret);
  return {
    header: { v: 1, alg: 'xchacha20poly1305', nonce: base64.encode(nonce), kdf },
    ciphertext,
  };
}

function open(key: Uint8Array, blob: WrappedBlob, ref: ZoneRef): Uint8Array {
  const { header } = blob;
  if (header.v !== 1 || header.alg !== 'xchacha20poly1305') {
    throw new Error(`blob: unsupported header (v=${header.v}, alg=${header.alg})`);
  }
  const nonce = base64.decode(header.nonce);
  if (nonce.length !== BLOB_NONCE_LENGTH) throw new Error('blob: bad nonce length');
  // AEAD failure throws; no partial state escapes.
  const secret = xchacha20poly1305(key, nonce, blobAad(ref)).decrypt(blob.ciphertext);
  if (secret.length !== ZONE_ROOT_SECRET_LENGTH) throw new Error('blob: bad plaintext length');
  return secret;
}

/** Layer 1: wrap the zone secret under the wallet's backup-wrap signature. */
export function sealSignatureBlob(
  signature: Uint8Array,
  zoneRootSecret: Uint8Array,
  ref: ZoneRef,
): WrappedBlob {
  const commitment = zoneRootCommitment(zoneRootSecret);
  const key = wrapKeyFromSignature(signature, commitment, ref);
  return seal(key, zoneRootSecret, ref, { type: 'sig-hkdf-v1' });
}

/**
 * Layer 1 unwrap. `commitmentHex` comes from zone metadata; the decrypted
 * secret is verified against it before being returned (spec §4.1 mandatory
 * check — catches corrupted blobs and changed wallet signing behavior).
 */
export function openSignatureBlob(
  signature: Uint8Array,
  blob: WrappedBlob,
  ref: ZoneRef,
  commitmentHex: string,
): Uint8Array {
  if (blob.header.kdf.type !== 'sig-hkdf-v1') throw new Error('blob: not a signature-wrapped blob');
  const key = wrapKeyFromSignature(signature, hexToBytesStrict(commitmentHex), ref);
  const secret = open(key, blob, ref);
  if (zoneRootCommitmentHex(secret) !== commitmentHex.toLowerCase()) {
    throw new Error('blob: commitment mismatch after unwrap');
  }
  return secret;
}

/** Layer 2: wrap under a passphrase-derived kek. Caller runs Argon2id. */
export function sealPassphraseBlob(
  kek: Uint8Array,
  argonSalt: Uint8Array,
  zoneRootSecret: Uint8Array,
  ref: ZoneRef,
): WrappedBlob {
  if (kek.length !== 32) throw new Error('blob: kek must be 32 bytes');
  if (argonSalt.length !== 16) throw new Error('blob: argon2 salt must be 16 bytes');
  return seal(kek, zoneRootSecret, ref, {
    type: 'argon2id',
    salt: base64.encode(argonSalt),
    m: ARGON2_PARAMS_V1.m,
    t: ARGON2_PARAMS_V1.t,
    p: ARGON2_PARAMS_V1.p,
  });
}

/**
 * Read + assert the Argon2id parameters a passphrase blob was created with
 * (spec §9). The caller derives the kek with exactly these params.
 */
export function passphraseKdfParams(blob: WrappedBlob): PassKdfInfo & { saltBytes: Uint8Array } {
  const { kdf } = blob.header;
  if (kdf.type !== 'argon2id') throw new Error('blob: not a passphrase-wrapped blob');
  if (kdf.m !== ARGON2_PARAMS_V1.m || kdf.t !== ARGON2_PARAMS_V1.t || kdf.p !== ARGON2_PARAMS_V1.p) {
    throw new Error(`blob: unexpected argon2id params m=${kdf.m} t=${kdf.t} p=${kdf.p}`);
  }
  return { ...kdf, saltBytes: base64.decode(kdf.salt) };
}

export function openPassphraseBlob(
  kek: Uint8Array,
  blob: WrappedBlob,
  ref: ZoneRef,
  commitmentHex: string,
): Uint8Array {
  passphraseKdfParams(blob); // asserts kdf type + params
  const secret = open(kek, blob, ref);
  if (zoneRootCommitmentHex(secret) !== commitmentHex.toLowerCase()) {
    throw new Error('blob: commitment mismatch after unwrap');
  }
  return secret;
}

// --- Backup file (auto-downloaded at creation; blobs are safe anywhere) ---

export interface BackupFile {
  format: 'mosaic-zone-backup';
  v: 1;
  protocol: string;
  rootChain: ZoneRef['rootChain'];
  rootAddress: string;
  zone: string;
  network: ZoneRef['network'];
  commitment: string;
  createdAt: string;
  blobs: Partial<Record<'sig' | 'pass', { header: BlobHeader; ciphertext: string }>>;
  /** Latest mutable encrypted vault data, when exported from an unlocked vault. */
  data?: { header: VaultDataBlobHeader; ciphertext: string };
}

export function encodeBackupFile(
  ref: ZoneRef,
  commitmentHex: string,
  blobs: Partial<Record<'sig' | 'pass', WrappedBlob>>,
  createdAt: string,
  data?: WrappedVaultData,
): BackupFile {
  const encoded: BackupFile['blobs'] = {};
  for (const kind of ['sig', 'pass'] as const) {
    const blob = blobs[kind];
    if (blob) encoded[kind] = { header: blob.header, ciphertext: base64.encode(blob.ciphertext) };
  }
  return {
    format: 'mosaic-zone-backup',
    v: 1,
    protocol: 'MOSAIC_ZONE_DERIVATION_V1',
    rootChain: ref.rootChain,
    rootAddress: ref.rootAddress,
    zone: ref.zone,
    network: ref.network,
    commitment: commitmentHex,
    createdAt,
    blobs: encoded,
    ...(data ? { data: { header: data.header, ciphertext: base64.encode(data.ciphertext) } } : {}),
  };
}

export function decodeBackupBlob(entry: { header: BlobHeader; ciphertext: string }): WrappedBlob {
  return { header: entry.header, ciphertext: base64.decode(entry.ciphertext) };
}

export function decodeVaultDataBackupBlob(entry: { header: VaultDataBlobHeader; ciphertext: string }): WrappedVaultData {
  return { header: entry.header, ciphertext: base64.decode(entry.ciphertext) };
}

function hexToBytesStrict(hex: string): Uint8Array {
  const clean = hex.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error('blob: expected 32-byte hex commitment');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
