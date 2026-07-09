import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalBytes } from '../canonical.js';
import { SEP53_PREFIX, type ZoneMessage } from '../messages.js';
import { stellarPublicKeyFromAddress } from '../address/stellar.js';

/**
 * SEP-0053 digest: SHA256("Stellar Signed Message:\n" ‖ message). This is what
 * Freighter (and every SEP-0053 wallet) actually ed25519-signs. Signer and
 * verifier share this one helper so they can never drift.
 */
export function sep53Digest(message: Uint8Array): Uint8Array {
  return sha256(concatBytes(utf8ToBytes(SEP53_PREFIX), message));
}

/** Stellar wallets sign the canonical JSON string of the zone message. */
export function stellarSigningPayload(message: ZoneMessage): Uint8Array {
  return canonicalBytes(message);
}

export function verifyStellarZoneSignature(
  message: ZoneMessage,
  signature: Uint8Array,
  expectedAddress: string,
): boolean {
  try {
    const digest = sep53Digest(stellarSigningPayload(message));
    return ed25519.verify(signature, digest, stellarPublicKeyFromAddress(expectedAddress));
  } catch {
    return false;
  }
}
