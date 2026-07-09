import { HDKey } from '@scure/bip32';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { zoneSeed } from './zoneSeed.js';
import { slip10DerivePath } from './slip10.js';
import { evmAddressFromPublicKey } from './address/evm.js';
import { xrplAddressFromPublicKey } from './address/xrpl.js';
import { stellarAddressFromPublicKey } from './address/stellar.js';
import type { AgentChain, ZoneRef } from './types.js';

/**
 * FROZEN derivation paths (spec §3.2). XRPL is pinned to secp256k1 — never
 * ed25519 for XRPL agent accounts.
 *
 *   EVM(i):     m/44'/60'/0'/0/i   secp256k1 (BIP32)
 *   Stellar(i): m/44'/148'/i'      ed25519   (SLIP-0010)
 *   XRPL(i):    m/44'/144'/0'/0/i  secp256k1 (BIP32)
 */

export interface AgentKey {
  chain: AgentChain;
  index: number;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  address: string;
}

function bip32Key(seed: Uint8Array, path: string): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const node = HDKey.fromMasterSeed(seed).derive(path);
  if (!node.privateKey || !node.publicKey) throw new Error(`derive: no key at ${path}`);
  return { privateKey: node.privateKey, publicKey: node.publicKey };
}

export function deriveEvmAgentKey(seed: Uint8Array, index: number): AgentKey {
  const { privateKey } = bip32Key(seed, `m/44'/60'/0'/0/${index}`);
  const publicKey = secp256k1.getPublicKey(privateKey, false);
  return { chain: 'evm', index, privateKey, publicKey, address: evmAddressFromPublicKey(publicKey) };
}

export function deriveXrplAgentKey(seed: Uint8Array, index: number): AgentKey {
  const { privateKey } = bip32Key(seed, `m/44'/144'/0'/0/${index}`);
  const publicKey = secp256k1.getPublicKey(privateKey, true);
  return { chain: 'xrpl', index, privateKey, publicKey, address: xrplAddressFromPublicKey(publicKey) };
}

export function deriveStellarAgentKey(seed: Uint8Array, index: number): AgentKey {
  const node = slip10DerivePath(seed, `m/44'/148'/${index}'`);
  const publicKey = ed25519.getPublicKey(node.key);
  return { chain: 'stellar', index, privateKey: node.key, publicKey, address: stellarAddressFromPublicKey(publicKey) };
}

export interface AgentAddresses {
  evm: string;
  xrpl: string;
  stellar: string;
}

/** The product surface: one secret + zone ref + index → 3 addresses. */
export function deriveAgentAddresses(zoneRootSecret: Uint8Array, ref: ZoneRef, index: number): AgentAddresses {
  const seed = zoneSeed(zoneRootSecret, ref);
  return {
    evm: deriveEvmAgentKey(seed, index).address,
    xrpl: deriveXrplAgentKey(seed, index).address,
    stellar: deriveStellarAgentKey(seed, index).address,
  };
}
