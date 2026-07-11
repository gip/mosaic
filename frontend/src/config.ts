/** Public build-time config. VITE_* values are baked into the bundle — never secrets. */
export const MCP_URL: string = import.meta.env.VITE_MCP_URL ?? 'http://localhost:8788/mcp';
export const WALLETCONNECT_PROJECT_ID: string = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? '';
