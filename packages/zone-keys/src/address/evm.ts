import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

/** EIP-55 checksummed address from a secp256k1 public key (any encoding). */
export function evmAddressFromPublicKey(publicKey: Uint8Array): string {
  let uncompressed = publicKey;
  if (publicKey.length === 33) {
    uncompressed = secp256k1.Point.fromBytes(publicKey).toBytes(false);
  }
  if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) {
    throw new Error('evm: expected secp256k1 public key (33 or 65 bytes)');
  }
  const hash = keccak_256(uncompressed.slice(1));
  return toEip55(bytesToHex(hash.slice(-20)));
}

export function evmAddressFromPrivateKey(privateKey: Uint8Array): string {
  return evmAddressFromPublicKey(secp256k1.getPublicKey(privateKey, false));
}

/** EIP-55 mixed-case checksum encoding. */
export function toEip55(addressHexLower: string): string {
  const lower = addressHexLower.replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(lower)) throw new Error('evm: invalid address hex');
  const hash = bytesToHex(keccak_256(utf8ToBytes(lower)));
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    out += Number.parseInt(hash[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i]!;
  }
  return out;
}
