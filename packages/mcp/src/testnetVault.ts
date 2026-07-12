import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { canonicalJson, verifyCommitment, type ZoneRef } from '@mosaic/zone-keys';

export const TESTNET_SERVER_POLICY = 'testnet-server-v1';

export interface ServerTestnetHeader {
  v: 1;
  alg: 'aes-256-gcm-server-v1';
  ivB64: string;
  tagB64: string;
}

function aad(ref: ZoneRef, commitment: string): Buffer {
  return Buffer.from(canonicalJson({ ...ref, commitment, v: 1, mode: TESTNET_SERVER_POLICY }), 'utf8');
}

function assertKey(key: Uint8Array): Buffer {
  if (key.byteLength !== 32) throw new Error('Testnet server key must be exactly 32 bytes');
  return Buffer.from(key);
}

export function parseTestnetServerKey(raw: string | undefined): Uint8Array | undefined {
  if (!raw) return undefined;
  if (!/^[0-9a-f]{64}$/i.test(raw)) {
    throw new Error('MOSAIC_TESTNET_VAULT_KEY must be 64 hexadecimal characters');
  }
  return new Uint8Array(Buffer.from(raw, 'hex'));
}

export function sealTestnetSecret(
  secret: Uint8Array,
  key: Uint8Array,
  ref: ZoneRef,
  commitment: string,
): { ciphertext: Uint8Array; header: ServerTestnetHeader } {
  if (secret.byteLength !== 32) throw new Error('Testnet zone secret must be exactly 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', assertKey(key), iv);
  cipher.setAAD(aad(ref, commitment));
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return {
    ciphertext: new Uint8Array(ciphertext),
    header: {
      v: 1,
      alg: 'aes-256-gcm-server-v1',
      ivB64: iv.toString('base64'),
      tagB64: cipher.getAuthTag().toString('base64'),
    },
  };
}

export function openTestnetSecret(
  ciphertext: Uint8Array,
  header: ServerTestnetHeader,
  key: Uint8Array,
  ref: ZoneRef,
  commitment: string,
): Uint8Array {
  if (header.v !== 1 || header.alg !== 'aes-256-gcm-server-v1') {
    throw new Error('Unsupported Testnet server blob');
  }
  const decipher = createDecipheriv('aes-256-gcm', assertKey(key), Buffer.from(header.ivB64, 'base64'));
  decipher.setAAD(aad(ref, commitment));
  decipher.setAuthTag(Buffer.from(header.tagB64, 'base64'));
  const secret = new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  if (secret.byteLength !== 32 || !verifyCommitment(secret, commitment)) {
    secret.fill(0);
    throw new Error('Testnet server secret commitment mismatch');
  }
  return secret;
}
