import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const ZONE_ROOT_SECRET_LENGTH = 32;

/** zoneRootCommitment = SHA256(zoneRootSecret) (spec §3.1). */
export function zoneRootCommitment(zoneRootSecret: Uint8Array): Uint8Array {
  if (zoneRootSecret.length !== ZONE_ROOT_SECRET_LENGTH) {
    throw new Error(`zoneRootSecret must be ${ZONE_ROOT_SECRET_LENGTH} bytes`);
  }
  return sha256(zoneRootSecret);
}

export function zoneRootCommitmentHex(zoneRootSecret: Uint8Array): string {
  return bytesToHex(zoneRootCommitment(zoneRootSecret));
}

/** Mandatory post-unwrap check (spec §4.1): run before any derivation. */
export function verifyCommitment(zoneRootSecret: Uint8Array, expectedCommitmentHex: string): boolean {
  return zoneRootCommitmentHex(zoneRootSecret) === expectedCommitmentHex.toLowerCase();
}
