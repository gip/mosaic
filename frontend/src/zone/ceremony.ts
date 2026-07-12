import {
  ARGON2_PARAMS_V1,
  backupSignaturesDeterministic,
  canonicalJson,
  deriveAgentAddresses,
  encodeBackupFile,
  sealPassphraseBlob,
  sealSignatureBlob,
  zoneRootCommitmentHex,
  type AgentAddresses,
  type WrappedBlob,
  type ZoneRef,
} from '@mosaic/zone-keys';
import { api, type SignatureEnvelope } from '../api';
import { deriveKek } from './argon2';
import { cacheZoneSecret } from './cache';

export type CeremonyStep =
  | 'begin'
  | 'authorize'
  | 'selftest-1'
  | 'selftest-2'
  | 'wrap'
  | 'passphrase-kdf'
  | 'upload'
  | 'done';

export const CEREMONY_STEP_LABELS: Record<CeremonyStep, string> = {
  begin: 'Preparing vault…',
  authorize: 'Sign the vault authorization with your wallet',
  'selftest-1': 'Backup signature 1 of 2 (determinism self-test)',
  'selftest-2': 'Backup signature 2 of 2 (determinism self-test)',
  wrap: 'Encrypting recovery blobs…',
  'passphrase-kdf': 'Deriving passphrase key (intentionally slow)…',
  upload: 'Storing recovery blobs…',
  done: 'Vault ready',
};

export class NonDeterministicWalletError extends Error {
  constructor() {
    super(
      'This wallet does not produce repeatable signatures (hardware or smart-contract wallet). ' +
        'Browser vaults require a deterministic wallet — signature recovery would be impossible.',
    );
    this.name = 'NonDeterministicWalletError';
  }
}

/** Per-chain signing strategy for the ceremony (EVM/Stellar sign in the page;
 * XRPL signs via server-created Xaman payloads rendered as QR codes). */
export interface CeremonySigner {
  signAuthorizeZone(args: {
    begin: { challengeId: string; nonce: string; issuedAt: string; expiresAt: string };
    localSignerPublicKey: string;
    policyHash: string;
    zoneRootCommitment: string;
  }): Promise<SignatureEnvelope>;
  /** Sign the timeless backup-wrap message; returns raw signature bytes. */
  signBackupWrap(): Promise<Uint8Array>;
}

/** Placeholder policy for the MVP — hashed into authorize-zone (spec §2.1). */
export const DEFAULT_POLICY = {
  allowedChains: 'evm,xrpl,stellar',
  note: 'mosaic-x MVP placeholder policy: derivation and display only, no agent spending',
  version: 1,
} as const;

export async function policyHashHex(): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(DEFAULT_POLICY));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const HOST_ID_KEY = 'mosaic.host-id';

/** Stable per-browser identifier recorded as localSignerPublicKey. */
export function browserHostId(): string {
  try {
    let id = localStorage.getItem(HOST_ID_KEY);
    if (!id) {
      id = `browser:${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
      localStorage.setItem(HOST_ID_KEY, id);
    }
    return id;
  } catch {
    return 'browser:ephemeral';
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s);
}

function downloadBackupFile(name: string, contents: object): void {
  const blob = new Blob([JSON.stringify(contents, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export interface CeremonyResult {
  zoneId: string;
  createdAt: string;
  commitment: string;
  addresses: AgentAddresses;
}

/**
 * The full zone-creation ceremony (spec §3.1 + §4.1 + §4.2), browser-zone
 * variant: the blob on the backend is the source of truth, so the zone goes
 * live only after both recovery blobs are stored (and a copy downloaded).
 */
export async function runZoneCeremony(opts: {
  token: string;
  ref: ZoneRef;
  passphrase: string;
  signer: CeremonySigner;
  onStep: (step: CeremonyStep) => void;
}): Promise<CeremonyResult> {
  const { token, ref, signer, onStep } = opts;

  onStep('begin');
  const begin = await api.zoneBegin(token, ref.zone);
  const secret = crypto.getRandomValues(new Uint8Array(32));

  try {
    const commitment = zoneRootCommitmentHex(secret);
    const localSignerPublicKey = browserHostId();
    const policyHash = await policyHashHex();

    onStep('authorize');
    const envelope = await signer.signAuthorizeZone({
      begin,
      localSignerPublicKey,
      policyHash,
      zoneRootCommitment: commitment,
    });

    // Determinism self-test (spec §4.1): two byte-identical requests must
    // yield byte-identical signatures, or layer 1 cannot exist and the
    // browser-zone model rejects the wallet outright.
    onStep('selftest-1');
    const sig1 = await signer.signBackupWrap();
    onStep('selftest-2');
    const sig2 = await signer.signBackupWrap();
    if (!backupSignaturesDeterministic(sig1, sig2)) throw new NonDeterministicWalletError();

    onStep('wrap');
    const blobSig = sealSignatureBlob(sig1, secret, ref);

    onStep('passphrase-kdf');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const kek = await deriveKek(opts.passphrase, salt, ARGON2_PARAMS_V1);
    const blobPass = sealPassphraseBlob(kek, salt, secret, ref);
    kek.fill(0);

    onStep('upload');
    const created = await api.zoneCreate({
      token,
      challengeId: begin.challengeId,
      zone: ref.zone,
      localSignerPublicKey,
      policyHash,
      zoneRootCommitment: commitment,
      signature: envelope,
    });
    await putBlob(token, ref.zone, 'sig', blobSig);
    await putBlob(token, ref.zone, 'pass', blobPass);
    downloadBackupFile(
      `mosaic-vault-backup-${ref.zone}-${ref.network}.json`,
      encodeBackupFile(ref, commitment, { sig: blobSig, pass: blobPass }, new Date().toISOString()),
    );

    await cacheZoneSecret(ref, secret, commitment);
    const addresses = deriveAgentAddresses(secret, ref, 0);
    onStep('done');
    return { zoneId: created.zoneId, createdAt: created.createdAt, commitment, addresses };
  } finally {
    secret.fill(0);
  }
}

function putBlob(token: string, zone: string, kind: 'sig' | 'pass', blob: WrappedBlob): Promise<{ version: number }> {
  return api.blobPut({
    token,
    zone,
    kind,
    ciphertextB64: bytesToBase64(blob.ciphertext),
    header: blob.header as unknown as Record<string, unknown>,
  });
}
