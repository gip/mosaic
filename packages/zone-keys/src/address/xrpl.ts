import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { base58xrp } from '@scure/base';

/**
 * XRPL classic address from a 33-byte compressed secp256k1 public key:
 * base58 (ripple alphabet) of 0x00 ‖ ripemd160(sha256(pubkey)) ‖ 4-byte
 * double-SHA256 checksum.
 */
export function xrplAddressFromPublicKey(compressedPublicKey: Uint8Array): string {
  if (compressedPublicKey.length !== 33) {
    throw new Error('xrpl: expected 33-byte compressed public key');
  }
  const accountId = ripemd160(sha256(compressedPublicKey));
  const payload = concatBytes(new Uint8Array([0x00]), accountId);
  const checksum = sha256(sha256(payload)).slice(0, 4);
  return base58xrp.encode(concatBytes(payload, checksum));
}
