import {
  openVaultData,
  type VaultDataBlobHeader,
  type VaultDataV1,
  type ZoneRef,
} from '@mosaic/zone-keys';
import { api, ApiError } from '../api';
import { readCachedZoneSecret } from './cache';

export interface VaultDataSnapshot {
  data: VaultDataV1;
  /** Optimistic storage version assigned by the MCP backend. */
  version: number;
  /** Cryptographic revision bound into the encrypted blob's AAD. */
  revision: number;
  stored: boolean;
}

function base64ToBytes(value: string): Uint8Array {
  const raw = atob(value);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

/**
 * Fetch and decrypt the latest mutable data for an unlocked browser vault.
 * The backend still sees and serves only ciphertext; the short-lived plaintext
 * secret is read from the browser session cache and zeroed immediately.
 */
export async function readVaultData(opts: {
  token: string;
  ref: ZoneRef;
  commitment: string;
}): Promise<VaultDataSnapshot> {
  const secret = await readCachedZoneSecret(opts.ref, opts.commitment);
  if (!secret) throw new Error('Vault data is unavailable because this vault is locked. Unlock it and try again.');

  try {
    let blob;
    try {
      blob = await api.blobGet(opts.token, opts.ref.zone, 'data');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NOT_FOUND') {
        return { data: { v: 1 }, version: 0, revision: 0, stored: false };
      }
      throw error;
    }
    if (blob.commitment !== opts.commitment) throw new Error('Vault data commitment mismatch.');

    const header = blob.header as unknown as VaultDataBlobHeader;
    return {
      data: openVaultData(secret, opts.ref, {
        header,
        ciphertext: base64ToBytes(blob.ciphertextB64),
      }),
      version: blob.version,
      revision: header.revision,
      stored: true,
    };
  } finally {
    secret.fill(0);
  }
}
