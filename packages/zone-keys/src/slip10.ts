import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * SLIP-0010 hierarchical derivation for ed25519 (hardened-only), validated
 * against the official SLIP-0010 test vectors in test/slip10.test.mjs.
 */

export interface Slip10Node {
  key: Uint8Array; // 32-byte private key (ed25519 seed)
  chainCode: Uint8Array;
}

const CURVE_SEED = utf8ToBytes('ed25519 seed');
const HARDENED = 0x80000000;

export function slip10MasterFromSeed(seed: Uint8Array): Slip10Node {
  const i = hmac(sha512, CURVE_SEED, seed);
  return { key: i.slice(0, 32), chainCode: i.slice(32) };
}

function ser32(index: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, index >>> 0, false);
  return out;
}

export function slip10DeriveHardened(node: Slip10Node, index: number): Slip10Node {
  if (!Number.isInteger(index) || index < 0 || index >= HARDENED) {
    throw new Error(`slip10: index out of range: ${index}`);
  }
  const data = concatBytes(new Uint8Array([0]), node.key, ser32(index + HARDENED));
  const i = hmac(sha512, node.chainCode, data);
  return { key: i.slice(0, 32), chainCode: i.slice(32) };
}

/** Derive a hardened-only path like "m/44'/148'/0'". */
export function slip10DerivePath(seed: Uint8Array, path: string): Slip10Node {
  const segments = path.split('/');
  if (segments[0] !== 'm') throw new Error(`slip10: path must start with m: ${path}`);
  let node = slip10MasterFromSeed(seed);
  for (const segment of segments.slice(1)) {
    if (!segment.endsWith("'")) {
      throw new Error(`slip10: ed25519 supports hardened derivation only: ${segment}`);
    }
    node = slip10DeriveHardened(node, Number.parseInt(segment.slice(0, -1), 10));
  }
  return node;
}
