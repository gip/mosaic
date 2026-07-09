import type { Network, RootChain, ZoneRef } from './types.js';

/**
 * Canonical message shapes (spec §2). Three purposes; a wallet must never be
 * asked to sign one purpose in a flow belonging to another. All field names
 * and values are FROZEN — golden signatures in tests enforce this.
 */

export const ZONE_PROTOCOL = 'MOSAIC_ZONE_DERIVATION_V1';

export interface AuthorizeZoneMessage {
  protocol: typeof ZONE_PROTOCOL;
  purpose: 'authorize-zone';
  rootChain: RootChain;
  rootAddress: string;
  zone: string;
  network: Network;
  localSignerPublicKey: string;
  policyHash: string;
  zoneRootCommitment: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  version: 1;
}

/** Deliberately timeless (spec §2.2): must re-sign identically years later. */
export interface BackupWrapMessage {
  protocol: typeof ZONE_PROTOCOL;
  purpose: 'backup-wrap';
  rootChain: RootChain;
  rootAddress: string;
  zone: string;
  network: Network;
  version: 1;
}

export interface SessionAuthMessage {
  protocol: typeof ZONE_PROTOCOL;
  purpose: 'session-auth';
  rootChain: RootChain;
  rootAddress: string;
  network: Network;
  audience: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  version: 1;
}

export type ZoneMessage = AuthorizeZoneMessage | BackupWrapMessage | SessionAuthMessage;

export const SESSION_AUDIENCE = 'mosaic-mcp';

export function backupWrapMessage(ref: ZoneRef): BackupWrapMessage {
  return {
    protocol: ZONE_PROTOCOL,
    purpose: 'backup-wrap',
    rootChain: ref.rootChain,
    rootAddress: ref.rootAddress,
    zone: ref.zone,
    network: ref.network,
    version: 1,
  };
}

export function authorizeZoneMessage(
  ref: ZoneRef,
  fields: {
    localSignerPublicKey: string;
    policyHash: string;
    zoneRootCommitment: string;
    nonce: string;
    issuedAt: string;
    expiresAt: string;
  },
): AuthorizeZoneMessage {
  return {
    protocol: ZONE_PROTOCOL,
    purpose: 'authorize-zone',
    rootChain: ref.rootChain,
    rootAddress: ref.rootAddress,
    zone: ref.zone,
    network: ref.network,
    ...fields,
    version: 1,
  };
}

export function sessionAuthMessage(fields: {
  rootChain: RootChain;
  rootAddress: string;
  network: Network;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}): SessionAuthMessage {
  return {
    protocol: ZONE_PROTOCOL,
    purpose: 'session-auth',
    audience: SESSION_AUDIENCE,
    ...fields,
    version: 1,
  };
}

// --- EIP-712 (spec §2.3: EVM signs typed data only, never personal_sign) ---

export const EIP712_DOMAIN_NAME = 'MosaicZone';
export const EIP712_DOMAIN_VERSION = '1';

/** EIP-712 domain chainId per network (Base mainnet / Base Sepolia). */
export const EVM_CHAIN_IDS: Record<Network, number> = { mainnet: 8453, testnet: 84532 };

export function eip712Domain(chainId: number): {
  name: string;
  version: string;
  chainId: number;
} {
  return { name: EIP712_DOMAIN_NAME, version: EIP712_DOMAIN_VERSION, chainId };
}

/** Field order is part of the EIP-712 struct hash — FROZEN. */
export const EIP712_TYPES = {
  AuthorizeZone: [
    { name: 'protocol', type: 'string' },
    { name: 'purpose', type: 'string' },
    { name: 'rootChain', type: 'string' },
    { name: 'rootAddress', type: 'string' },
    { name: 'zone', type: 'string' },
    { name: 'network', type: 'string' },
    { name: 'localSignerPublicKey', type: 'string' },
    { name: 'policyHash', type: 'string' },
    { name: 'zoneRootCommitment', type: 'string' },
    { name: 'nonce', type: 'string' },
    { name: 'issuedAt', type: 'string' },
    { name: 'expiresAt', type: 'string' },
    { name: 'version', type: 'uint256' },
  ],
  BackupWrap: [
    { name: 'protocol', type: 'string' },
    { name: 'purpose', type: 'string' },
    { name: 'rootChain', type: 'string' },
    { name: 'rootAddress', type: 'string' },
    { name: 'zone', type: 'string' },
    { name: 'network', type: 'string' },
    { name: 'version', type: 'uint256' },
  ],
  SessionAuth: [
    { name: 'protocol', type: 'string' },
    { name: 'purpose', type: 'string' },
    { name: 'rootChain', type: 'string' },
    { name: 'rootAddress', type: 'string' },
    { name: 'network', type: 'string' },
    { name: 'audience', type: 'string' },
    { name: 'nonce', type: 'string' },
    { name: 'issuedAt', type: 'string' },
    { name: 'expiresAt', type: 'string' },
    { name: 'version', type: 'uint256' },
  ],
} as const;

export type Eip712PrimaryType = keyof typeof EIP712_TYPES;

export function eip712PrimaryType(purpose: ZoneMessage['purpose']): Eip712PrimaryType {
  switch (purpose) {
    case 'authorize-zone':
      return 'AuthorizeZone';
    case 'backup-wrap':
      return 'BackupWrap';
    case 'session-auth':
      return 'SessionAuth';
  }
}

/** Full eth_signTypedData_v4 payload for a zone message. */
export function eip712TypedData(message: ZoneMessage, chainId: number): {
  domain: ReturnType<typeof eip712Domain>;
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: Eip712PrimaryType;
  message: ZoneMessage;
} {
  const primaryType = eip712PrimaryType(message.purpose);
  return {
    domain: eip712Domain(chainId),
    types: { [primaryType]: EIP712_TYPES[primaryType] },
    primaryType,
    message,
  };
}

// --- SEP-53 (Stellar signed message digest) ---

export const SEP53_PREFIX = 'Stellar Signed Message:\n';

// --- XRPL memo domain ---

export const XRPL_MEMO_TYPE = 'mosaic/zone-v1';
