import type { Network, RootChain, ZoneMessage } from '@mosaic/zone-keys';

export type { Network, RootChain, ZoneMessage };

/** How the wallet was reached — drives UI affordances (QR vs popup). */
export type ConnectorTransport = 'extension' | 'walletconnect' | 'xaman';

export interface ConnectedRootWallet {
  chain: RootChain;
  address: string;
  transport: ConnectorTransport;
  /**
   * Sign a canonical zone message with the root wallet. Returns the raw
   * signature bytes (layer-1 wrapKey ikm) plus the envelope the MCP server
   * verifies. XRPL wallets sign via server-created Xaman payloads instead —
   * their connector does not implement this (see @mosaic/web-connector/xrpl).
   */
  signZoneMessage?(message: ZoneMessage): Promise<SignedZoneMessage>;
  disconnect(): Promise<void>;
}

export interface SignedZoneMessage {
  /** Raw signature bytes — HKDF ikm for backup-wrap. */
  signatureBytes: Uint8Array;
  /** Envelope for the MCP server's auth_verify / zone_create. */
  envelope:
    | { type: 'evm'; signature: `0x${string}` }
    | { type: 'stellar'; signatureB64: string };
}
