/** Display-only truncation to 4 fractional digits; never round-trips Number. */
export function formatAmount(amount: string): string {
  const [int, frac = ''] = amount.split('.');
  const trimmed = frac.slice(0, 4).replace(/0+$/, '');
  return trimmed ? `${int}.${trimmed}` : int;
}
