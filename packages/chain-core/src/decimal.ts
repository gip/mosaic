/**
 * Minimal BigInt fixed-point arithmetic on decimal strings. Used to normalize
 * order-book amounts and prices without going through Number (drop counts and
 * XRPL IOU values exceed float53 precision). Results are truncated (rounded
 * toward zero) at the requested number of decimal places.
 */

/** Default working precision for derived values (XRPL IOUs carry 15 sig digits). */
export const PRICE_DECIMALS = 15;

const DECIMAL_RE = /^-?(\d+)(?:\.(\d+))?$/;
const SCI_RE = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/;

/** Expand scientific notation to plain decimal (XRPL IOU values may use it). */
function toPlainDecimal(value: string): string {
  const m = SCI_RE.exec(value);
  if (!m) return value;
  const [, sign, int, frac = '', expStr] = m;
  const exp = Number(expStr);
  const digits = int + frac;
  const point = int.length + exp; // digits before the decimal point
  let out: string;
  if (point <= 0) {
    out = `0.${'0'.repeat(-point)}${digits}`;
  } else if (point >= digits.length) {
    out = digits + '0'.repeat(point - digits.length);
  } else {
    out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  return sign + out;
}

/** Parse a decimal string into a BigInt scaled by 10^decimals (truncating). */
export function parseScaled(value: string, decimals: number): bigint {
  const plain = toPlainDecimal(value.trim());
  const m = DECIMAL_RE.exec(plain);
  if (!m) throw new Error(`invalid decimal: ${JSON.stringify(value)}`);
  const negative = plain.startsWith('-');
  const [, int, frac = ''] = m;
  const fracPadded = frac.slice(0, decimals).padEnd(decimals, '0');
  const scaled = BigInt(int) * 10n ** BigInt(decimals) + BigInt(fracPadded || '0');
  return negative ? -scaled : scaled;
}

/** Render a scaled BigInt back to a decimal string, trimming trailing zeros. */
export function formatScaled(scaled: bigint, decimals: number): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const base = 10n ** BigInt(decimals);
  const int = abs / base;
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

/** a / b as a decimal string with `decimals` fractional digits (truncated). */
export function divDecimals(a: string, b: string, decimals = PRICE_DECIMALS): string {
  const bScaled = parseScaled(b, decimals);
  if (bScaled === 0n) throw new Error('division by zero');
  const aScaled = parseScaled(a, decimals);
  return formatScaled((aScaled * 10n ** BigInt(decimals)) / bScaled, decimals);
}

/** a * b as a decimal string (truncated at `decimals`). */
export function mulDecimals(a: string, b: string, decimals = PRICE_DECIMALS): string {
  const product = parseScaled(a, decimals) * parseScaled(b, decimals);
  return formatScaled(product / 10n ** BigInt(decimals), decimals);
}

/** a * n / d as a decimal string (exact rational scaling, truncated). */
export function mulRatio(a: string, n: bigint, d: bigint, decimals = PRICE_DECIMALS): string {
  if (d === 0n) throw new Error('division by zero');
  return formatScaled((parseScaled(a, decimals) * n) / d, decimals);
}

/** a + b as a decimal string (exact at `decimals` fractional digits). */
export function addDecimals(a: string, b: string, decimals = PRICE_DECIMALS): string {
  return formatScaled(parseScaled(a, decimals) + parseScaled(b, decimals), decimals);
}

/** Compare two decimal strings numerically: -1, 0, or 1. */
export function cmpDecimals(a: string, b: string): number {
  const aScaled = parseScaled(a, PRICE_DECIMALS);
  const bScaled = parseScaled(b, PRICE_DECIMALS);
  return aScaled < bScaled ? -1 : aScaled > bScaled ? 1 : 0;
}

/** True when the decimal string is zero (at working precision). */
export function isZeroDecimal(value: string): boolean {
  return parseScaled(value, PRICE_DECIMALS) === 0n;
}

/** Integer drop count → XRP decimal string (1 XRP = 10^6 drops), exact. */
export function dropsToXrp(drops: string): string {
  if (!/^\d+$/.test(drops)) throw new Error(`invalid drops: ${JSON.stringify(drops)}`);
  return formatScaled(BigInt(drops), 6);
}

/** XRP decimal string → integer drop count, exact (truncates below 1 drop). */
export function xrpToDrops(xrp: string): string {
  const scaled = parseScaled(xrp, 6);
  if (scaled < 0n) throw new Error(`invalid XRP amount: ${JSON.stringify(xrp)}`);
  return scaled.toString();
}
