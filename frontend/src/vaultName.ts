export function vaultDisplayName(zone: string): string {
  if (zone === 'default') return 'Default';
  if (zone === 'trading') return 'Trading';
  return zone;
}
