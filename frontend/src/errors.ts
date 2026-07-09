/**
 * Human-readable message from any thrown value. Wallet providers (MetaMask,
 * WalletConnect) reject with plain `{ code, message }` objects rather than
 * Error instances, which `String(err)` renders as "[object Object]".
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return String(err);
}
