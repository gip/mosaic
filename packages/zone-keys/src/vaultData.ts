import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64, utf8 } from '@scure/base';
import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalBytes } from './canonical.js';
import { zoneRootCommitment } from './commitment.js';
import type { ZoneRef } from './types.js';

/** FROZEN domain string for mutable, zone-secret-encrypted JSON data. */
export const VAULT_DATA_DOMAIN_V1 = 'MOSAIC_VAULT_DATA_V1';
export const VAULT_DATA_MAX_PLAINTEXT_BYTES = 64 * 1024;
export const VAULT_DATA_NONCE_LENGTH = 24;

export interface VaultIdentityV1 {
  chain: 'evm';
  addressName: string;
  address: string;
  index: number;
}

export interface VaultDataV1 {
  v: 1;
  identities?: Record<string, VaultIdentityV1>;
  connections?: {
    guardian?: {
      evmAddress: string;
      xmtpEnvironment: 'dev' | 'production';
    };
  };
  /** Applications may add JSON values under namespaced keys. */
  extensions?: Record<string, unknown>;
}

export interface VaultDataBlobHeader {
  v: 1;
  schema: 'mosaic-vault-data';
  alg: 'xchacha20poly1305';
  nonce: string;
  revision: number;
}

export interface WrappedVaultData {
  header: VaultDataBlobHeader;
  ciphertext: Uint8Array;
}

function assertRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('vault data: revision must be a positive safe integer');
}

function assertJsonValue(value: unknown, path = '$'): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`vault data: non-finite number at ${path}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== 'object') throw new Error(`vault data: non-JSON value at ${path}`);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined) throw new Error(`vault data: undefined value at ${path}.${key}`);
    assertJsonValue(item, `${path}.${key}`);
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function encodeData(data: VaultDataV1): Uint8Array {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.v !== 1) {
    throw new Error('vault data: expected a v1 JSON object');
  }
  assertJsonValue(data);
  const bytes = utf8ToBytes(stableJson(data));
  if (bytes.length > VAULT_DATA_MAX_PLAINTEXT_BYTES) {
    throw new Error(`vault data: plaintext exceeds ${VAULT_DATA_MAX_PLAINTEXT_BYTES} bytes`);
  }
  return bytes;
}

export function vaultDataKey(zoneRootSecret: Uint8Array, ref: ZoneRef): Uint8Array {
  const salt = zoneRootCommitment(zoneRootSecret);
  const info = concatBytes(
    utf8ToBytes(VAULT_DATA_DOMAIN_V1),
    utf8ToBytes(ref.rootAddress),
    utf8ToBytes(ref.zone),
    utf8ToBytes(ref.network),
  );
  return hkdf(sha256, zoneRootSecret, salt, info, 32);
}

function aad(ref: ZoneRef, revision: number): Uint8Array {
  return canonicalBytes({
    network: ref.network,
    protocol: VAULT_DATA_DOMAIN_V1,
    revision,
    rootAddress: ref.rootAddress,
    rootChain: ref.rootChain,
    schemaVersion: 1,
    zone: ref.zone,
  });
}

export function sealVaultData(
  zoneRootSecret: Uint8Array,
  ref: ZoneRef,
  data: VaultDataV1,
  revision: number,
): WrappedVaultData {
  assertRevision(revision);
  const plaintext = encodeData(data);
  const nonce = randomBytes(VAULT_DATA_NONCE_LENGTH);
  const key = vaultDataKey(zoneRootSecret, ref);
  try {
    return {
      header: {
        v: 1,
        schema: 'mosaic-vault-data',
        alg: 'xchacha20poly1305',
        nonce: base64.encode(nonce),
        revision,
      },
      ciphertext: xchacha20poly1305(key, nonce, aad(ref, revision)).encrypt(plaintext),
    };
  } finally {
    key.fill(0);
  }
}

export function openVaultData(zoneRootSecret: Uint8Array, ref: ZoneRef, blob: WrappedVaultData): VaultDataV1 {
  const { header } = blob;
  if (header.v !== 1 || header.schema !== 'mosaic-vault-data' || header.alg !== 'xchacha20poly1305') {
    throw new Error('vault data: unsupported header');
  }
  assertRevision(header.revision);
  const nonce = base64.decode(header.nonce);
  if (nonce.length !== VAULT_DATA_NONCE_LENGTH) throw new Error('vault data: bad nonce length');
  const key = vaultDataKey(zoneRootSecret, ref);
  let plaintext: Uint8Array;
  try {
    plaintext = xchacha20poly1305(key, nonce, aad(ref, header.revision)).decrypt(blob.ciphertext);
  } finally {
    key.fill(0);
  }
  if (plaintext.length > VAULT_DATA_MAX_PLAINTEXT_BYTES) throw new Error('vault data: plaintext too large');
  const parsed = JSON.parse(utf8.encode(plaintext)) as unknown;
  // Re-encoding validates the shape, JSON values, version, and size.
  encodeData(parsed as VaultDataV1);
  return parsed as VaultDataV1;
}
