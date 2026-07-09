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
