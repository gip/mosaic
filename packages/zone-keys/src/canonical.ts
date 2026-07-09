import { utf8ToBytes } from '@noble/hashes/utils.js';

export type CanonicalScalar = string | number | boolean | null;

/**
 * Canonical JSON per spec §2: flat object, keys sorted lexicographically,
 * no whitespace, UTF-8. Every signed message and every AAD goes through this
 * one function — signer and verifier must never serialize independently.
 */
export function canonicalJson(message: object): string {
  const record = message as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const value = record[key];
    if (value === undefined) continue;
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
      throw new Error(`canonicalJson: non-scalar value for key ${key}`);
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error(`canonicalJson: non-finite number for key ${key}`);
    }
    parts.push(`${JSON.stringify(key)}:${JSON.stringify(value)}`);
  }
  return `{${parts.join(',')}}`;
}

export function canonicalBytes(message: object): Uint8Array {
  return utf8ToBytes(canonicalJson(message));
}
