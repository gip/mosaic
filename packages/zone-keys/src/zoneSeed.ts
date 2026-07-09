import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { ZoneRef } from './types.js';

/**
 * FROZEN domain string. Changing it re-keys every zone ever created.
 * Golden vectors in vectors/ enforce this.
 */
export const ZONE_DOMAIN_V1 = 'MOSAIC_ZONE_V1';

export const ZONE_SEED_LENGTH = 64;

/**
 * Zone-bound derivation seed (spec §3.2):
 *
 *   seed = HKDF-SHA256(ikm  = zoneRootSecret,
 *                      salt = SHA256("MOSAIC_ZONE_V1"),
 *                      info = "MOSAIC_ZONE_V1" || rootAddress || zone || network)
 *
 * Zone separation is cryptographic: a different zone or network yields an
 * unrelated seed even from the same secret.
 */
export function zoneSeed(zoneRootSecret: Uint8Array, ref: ZoneRef): Uint8Array {
  const salt = sha256(utf8ToBytes(ZONE_DOMAIN_V1));
  const info = concatBytes(
    utf8ToBytes(ZONE_DOMAIN_V1),
    utf8ToBytes(ref.rootAddress),
    utf8ToBytes(ref.zone),
    utf8ToBytes(ref.network),
  );
  return hkdf(sha256, zoneRootSecret, salt, info, ZONE_SEED_LENGTH);
}
