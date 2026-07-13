import { createHash } from 'node:crypto';
import { canonicalJson, type DigestHex } from './contracts.js';

/**
 * Node-only digest helpers. Kept out of contracts.ts so the browser frontend
 * can import the pure constants/types without pulling in node:crypto.
 */

export function sha256Hex(value: string | Uint8Array): DigestHex {
  return createHash('sha256').update(value).digest('hex');
}

export function contractDigest(value: unknown): DigestHex {
  return sha256Hex(canonicalJson(value));
}
