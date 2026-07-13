import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64, utf8 } from '@scure/base';
import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalBytes } from './canonical.js';
import { zoneRootCommitment } from './commitment.js';
import type { ZoneRef } from './types.js';

/** Frozen domain for the independently versioned encrypted agent secret store. */
export const AGENT_SECRET_STORE_DOMAIN_V1 = 'MOSAIC_AGENT_SECRET_STORE_V1';
export const AGENT_SECRET_STORE_MAX_PLAINTEXT_BYTES = 64 * 1024;
export const AGENT_SECRET_STORE_NONCE_LENGTH = 24;

export type AgentSecretCustody = 'guardian-only' | 'supervisor-session';
export type AgentSecretPurpose =
  | 'xmtp-owner'
  | 'xmtp-database'
  | 'wss-credential'
  | 'transaction-signing'
  | 'imported';

export interface AgentSecretRecordV1 {
  keyId: string;
  purpose: AgentSecretPurpose;
  algorithm: 'secp256k1' | 'ed25519' | 'bytes32' | 'opaque';
  custody: AgentSecretCustody;
  materialB64: string;
  createdAt: string;
}

export interface AgentSecretStoreV1 {
  v: 1;
  agentId: string;
  secrets: AgentSecretRecordV1[];
}

export interface AgentSecretStoreHeaderV1 {
  v: 1;
  schema: 'mosaic-agent-secrets';
  alg: 'xchacha20poly1305';
  nonce: string;
  revision: number;
}

export interface WrappedAgentSecretStore {
  header: AgentSecretStoreHeaderV1;
  ciphertext: Uint8Array;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function assertRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('agent secrets: revision must be a positive safe integer');
}

function assertAgentId(agentId: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agentId) || agentId.length > 64) throw new Error('agent secrets: invalid agentId');
}

function validateStore(store: AgentSecretStoreV1): Uint8Array {
  if (store.v !== 1 || !Array.isArray(store.secrets)) throw new Error('agent secrets: invalid store');
  assertAgentId(store.agentId);
  const ids = new Set<string>();
  for (const secret of store.secrets) {
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(secret.keyId) || ids.has(secret.keyId)) throw new Error('agent secrets: invalid or duplicate keyId');
    ids.add(secret.keyId);
    if (!['guardian-only', 'supervisor-session'].includes(secret.custody)) throw new Error('agent secrets: invalid custody');
    if (!['xmtp-owner', 'xmtp-database', 'wss-credential', 'transaction-signing', 'imported'].includes(secret.purpose)) throw new Error('agent secrets: invalid purpose');
    if (!['secp256k1', 'ed25519', 'bytes32', 'opaque'].includes(secret.algorithm)) throw new Error('agent secrets: invalid algorithm');
    const material = base64.decode(secret.materialB64);
    if (material.length === 0 || material.length > 4096) throw new Error('agent secrets: invalid material length');
    if ((secret.algorithm === 'secp256k1' || secret.algorithm === 'bytes32') && material.length !== 32) throw new Error('agent secrets: key must be 32 bytes');
    if (!Number.isFinite(Date.parse(secret.createdAt))) throw new Error('agent secrets: invalid createdAt');
    if (secret.purpose === 'transaction-signing' && secret.custody !== 'guardian-only') throw new Error('agent secrets: transaction keys must be Guardian-only');
  }
  const bytes = utf8ToBytes(stableJson(store));
  if (bytes.length > AGENT_SECRET_STORE_MAX_PLAINTEXT_BYTES) throw new Error('agent secrets: plaintext exceeds maximum');
  return bytes;
}

export function agentSecretStoreKey(zoneRootSecret: Uint8Array, ref: ZoneRef): Uint8Array {
  const info = concatBytes(
    utf8ToBytes(AGENT_SECRET_STORE_DOMAIN_V1),
    utf8ToBytes(ref.rootAddress),
    utf8ToBytes(ref.zone),
    utf8ToBytes(ref.network),
  );
  return hkdf(sha256, zoneRootSecret, zoneRootCommitment(zoneRootSecret), info, 32);
}

function aad(ref: ZoneRef, revision: number): Uint8Array {
  return canonicalBytes({
    network: ref.network,
    protocol: AGENT_SECRET_STORE_DOMAIN_V1,
    revision,
    rootAddress: ref.rootAddress,
    rootChain: ref.rootChain,
    schemaVersion: 1,
    zone: ref.zone,
  });
}

export function sealAgentSecretStore(
  zoneRootSecret: Uint8Array,
  ref: ZoneRef,
  store: AgentSecretStoreV1,
  revision: number,
  nonce: Uint8Array = randomBytes(AGENT_SECRET_STORE_NONCE_LENGTH),
): WrappedAgentSecretStore {
  assertRevision(revision);
  if (store.agentId !== ref.zone) throw new Error('agent secrets: agentId must equal vault zone');
  if (nonce.length !== AGENT_SECRET_STORE_NONCE_LENGTH) throw new Error('agent secrets: bad nonce length');
  const plaintext = validateStore(store);
  const key = agentSecretStoreKey(zoneRootSecret, ref);
  try {
    return {
      header: { v: 1, schema: 'mosaic-agent-secrets', alg: 'xchacha20poly1305', nonce: base64.encode(nonce), revision },
      ciphertext: xchacha20poly1305(key, nonce, aad(ref, revision)).encrypt(plaintext),
    };
  } finally { plaintext.fill(0); key.fill(0); }
}

export function openAgentSecretStore(
  zoneRootSecret: Uint8Array,
  ref: ZoneRef,
  wrapped: WrappedAgentSecretStore,
): AgentSecretStoreV1 {
  const { header } = wrapped;
  if (header.v !== 1 || header.schema !== 'mosaic-agent-secrets' || header.alg !== 'xchacha20poly1305') throw new Error('agent secrets: unsupported header');
  assertRevision(header.revision);
  const nonce = base64.decode(header.nonce);
  if (nonce.length !== AGENT_SECRET_STORE_NONCE_LENGTH) throw new Error('agent secrets: bad nonce length');
  const key = agentSecretStoreKey(zoneRootSecret, ref);
  let plaintext: Uint8Array;
  try { plaintext = xchacha20poly1305(key, nonce, aad(ref, header.revision)).decrypt(wrapped.ciphertext); }
  finally { key.fill(0); }
  if (plaintext.length > AGENT_SECRET_STORE_MAX_PLAINTEXT_BYTES) throw new Error('agent secrets: plaintext exceeds maximum');
  try {
    const parsed = JSON.parse(utf8.encode(plaintext)) as AgentSecretStoreV1;
    validateStore(parsed);
    if (parsed.agentId !== ref.zone) throw new Error('agent secrets: agentId must equal vault zone');
    return parsed;
  } finally { plaintext.fill(0); }
}
