export function envNumber(name: string, fallback: number, opts: { allowZero?: boolean } = {}): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || (!opts.allowZero && value === 0)) {
    throw new Error(`invalid ${name}: ${raw}`);
  }
  return value;
}

export function envString(name: string, fallback?: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

export function requireEnv(name: string): string {
  const raw = envString(name);
  if (!raw) throw new Error(`missing required env var ${name}`);
  return raw;
}

const UINT32_MAX = 0xffff_ffff;

/** Parse one required, base-10 UInt32 environment value without coercion. */
export function requireEnvUint32(name: string, raw: string | undefined = process.env[name]): number {
  if (raw === undefined || raw === '') throw new Error(`missing required env var ${name}`);
  if (!/^\d+$/.test(raw)) throw new Error(`invalid ${name}: expected a decimal UInt32`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > UINT32_MAX) {
    throw new Error(`invalid ${name}: expected a decimal UInt32`);
  }
  return value;
}

export function validateUint32(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new Error(`invalid ${name}: expected a UInt32 integer`);
  }
  return value;
}
