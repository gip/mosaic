import type { BackupFile, BlobHeader, VaultDataBlobHeader, ZoneRef } from '@mosaic/zone-keys';
import { api, ApiError } from '../api';

export async function exportLatestVaultBackup(opts: {
  token: string;
  ref: ZoneRef;
  commitment: string;
  createdAt: string;
}): Promise<void> {
  const blobs: BackupFile['blobs'] = {};
  for (const kind of ['sig', 'pass'] as const) {
    try {
      const blob = await api.blobGet(opts.token, opts.ref.zone, kind);
      blobs[kind] = { header: blob.header as unknown as BlobHeader, ciphertext: blob.ciphertextB64 };
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'NOT_FOUND') throw error;
    }
  }
  let data: BackupFile['data'];
  try {
    const blob = await api.blobGet(opts.token, opts.ref.zone, 'data');
    data = { header: blob.header as unknown as VaultDataBlobHeader, ciphertext: blob.ciphertextB64 };
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'NOT_FOUND') throw error;
  }
  const backup: BackupFile = {
    format: 'mosaic-zone-backup',
    v: 1,
    protocol: 'MOSAIC_ZONE_DERIVATION_V1',
    rootChain: opts.ref.rootChain,
    rootAddress: opts.ref.rootAddress,
    zone: opts.ref.zone,
    network: opts.ref.network,
    commitment: opts.commitment,
    createdAt: opts.createdAt,
    blobs,
    ...(data ? { data } : {}),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = `mosaic-vault-backup-${opts.ref.zone}-${opts.ref.network}.json`;
    link.click();
  } finally { URL.revokeObjectURL(url); }
}
