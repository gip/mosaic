import {
  decodeBackupBlob,
  deriveAgentAddresses,
  openPassphraseBlob,
  openSignatureBlob,
  passphraseKdfParams,
  type BlobHeader,
  type ZoneRef,
} from '@mosaic/zone-keys';
import { api, type ZoneAddressItem } from '../api';
import { deriveKek } from './argon2';
import { cacheZoneSecret, readCachedZoneSecret } from './cache';

/**
 * Returning-session unlock: cache hit needs nothing; cache miss is one
 * backup-wrap re-signature over the blob fetched from the backend. New
 * device, evicted storage, and cleared site data are all this same flow.
 */

export interface UnlockResult {
  addresses: DerivedVaultAddress[];
}

export interface DerivedVaultAddress extends ZoneAddressItem { address: string }

function deriveConfiguredAddresses(secret: Uint8Array, ref: ZoneRef, entries: ZoneAddressItem[]): DerivedVaultAddress[] {
  const byIndex = new Map<number, ReturnType<typeof deriveAgentAddresses>>();
  return entries.map((entry) => {
    let addresses = byIndex.get(entry.index);
    if (!addresses) {
      addresses = deriveAgentAddresses(secret, ref, entry.index);
      byIndex.set(entry.index, addresses);
    }
    return { ...entry, address: addresses[entry.chain] };
  });
}

export async function unlockFromCache(ref: ZoneRef, commitment: string, entries: ZoneAddressItem[]): Promise<UnlockResult | undefined> {
  const secret = await readCachedZoneSecret(ref, commitment);
  if (!secret) return undefined;
  try {
    return { addresses: deriveConfiguredAddresses(secret, ref, entries) };
  } finally {
    secret.fill(0);
  }
}

export async function unlockWithSignature(opts: {
  token: string;
  ref: ZoneRef;
  commitment: string;
  entries: ZoneAddressItem[];
  /** One backup-wrap re-signature (byte-identical message). */
  signBackupWrap: () => Promise<Uint8Array>;
}): Promise<UnlockResult> {
  const blob = await api.blobGet(opts.token, opts.ref.zone, 'sig');
  const wrapped = decodeBackupBlob({ header: blob.header as unknown as BlobHeader, ciphertext: blob.ciphertextB64 });
  const signature = await opts.signBackupWrap();
  // Throws on AEAD failure or commitment mismatch — callers fall back to the
  // passphrase path (wallet signing behavior may have changed, spec §4.2).
  const secret = openSignatureBlob(signature, wrapped, opts.ref, opts.commitment);
  try {
    await cacheZoneSecret(opts.ref, secret, opts.commitment);
    return { addresses: deriveConfiguredAddresses(secret, opts.ref, opts.entries) };
  } finally {
    secret.fill(0);
  }
}

export async function unlockWithPassphrase(opts: {
  token: string;
  ref: ZoneRef;
  commitment: string;
  passphrase: string;
  entries: ZoneAddressItem[];
}): Promise<UnlockResult> {
  const blob = await api.blobGet(opts.token, opts.ref.zone, 'pass');
  const wrapped = decodeBackupBlob({ header: blob.header as unknown as BlobHeader, ciphertext: blob.ciphertextB64 });
  const params = passphraseKdfParams(wrapped); // asserts Argon2id params
  const kek = await deriveKek(opts.passphrase, params.saltBytes, { m: params.m, t: params.t, p: params.p });
  try {
    const secret = openPassphraseBlob(kek, wrapped, opts.ref, opts.commitment);
    try {
      await cacheZoneSecret(opts.ref, secret, opts.commitment);
      return { addresses: deriveConfiguredAddresses(secret, opts.ref, opts.entries) };
    } finally {
      secret.fill(0);
    }
  } finally {
    kek.fill(0);
  }
}
