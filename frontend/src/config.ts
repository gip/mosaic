import type { Network } from '@mosaic/chain-core';

/** Public build-time config. VITE_* values are baked into the bundle — never secrets. */
export const MCP_URL: string = import.meta.env.VITE_MCP_URL ?? 'http://127.0.0.1:8788/mcp';
export const WALLETCONNECT_PROJECT_ID: string = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? '';

/** Optional XRPL WebSocket node per network; unset falls back to @mosaic/xrpl's public defaults. */
export const XRPL_WS_ENDPOINTS: Partial<Record<Network, string>> = {
  mainnet: import.meta.env.VITE_XRPL_WS_MAINNET || undefined,
  testnet: import.meta.env.VITE_XRPL_WS_TESTNET || undefined,
};
