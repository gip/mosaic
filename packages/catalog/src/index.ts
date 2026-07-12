export type ChainFamily = 'evm' | 'xrpl' | 'stellar';
export type NetworkTag = 'mainnet' | 'testnet';
export type ChainSource = 'static' | 'database';
export type AssetTrustState = 'hidden' | 'review' | 'allowed';

export interface SupportedChain {
  id: string;
  /** Groups the mainnet/testnet variants of one logical chain; custom chains use their own id. */
  chainKey: string;
  name: string;
  family: ChainFamily;
  network: NetworkTag;
  source: ChainSource;
  evmChainId?: number;
}

export interface AssetDeployment {
  chainId: string;
  symbol: string;
  kind: 'native' | 'issued';
  /** Issuer account for XRPL/Stellar, contract address for EVM. */
  address?: string;
}

export interface SupportedAsset {
  id: string;
  name: string;
  deployments: readonly AssetDeployment[];
}

export interface ChainWithEnabled extends SupportedChain {
  enabled: boolean;
}

export interface AssetWithTrust extends SupportedAsset {
  trustState: AssetTrustState;
}

export interface CatalogSnapshot {
  chains: ChainWithEnabled[];
  assets: AssetWithTrust[];
}

// Product-wide family order: XRPL, Stellar, EVM. Catalog consumers render in this order.
export const BUILTIN_CHAINS: readonly SupportedChain[] = [
  { id: 'xrpl-mainnet', chainKey: 'xrpl', name: 'XRPL', family: 'xrpl', network: 'mainnet', source: 'static' },
  { id: 'xrpl-testnet', chainKey: 'xrpl', name: 'XRPL Testnet', family: 'xrpl', network: 'testnet', source: 'static' },
  { id: 'stellar-mainnet', chainKey: 'stellar', name: 'Stellar', family: 'stellar', network: 'mainnet', source: 'static' },
  { id: 'stellar-testnet', chainKey: 'stellar', name: 'Stellar Testnet', family: 'stellar', network: 'testnet', source: 'static' },
  { id: 'base-mainnet', chainKey: 'base', name: 'Base', family: 'evm', network: 'mainnet', source: 'static', evmChainId: 8453 },
  { id: 'base-sepolia', chainKey: 'base', name: 'Base Sepolia', family: 'evm', network: 'testnet', source: 'static', evmChainId: 84532 },
] as const;

export const BUILTIN_ASSETS: readonly SupportedAsset[] = [
  {
    id: 'xrp',
    name: 'XRP',
    deployments: [
      { chainId: 'xrpl-mainnet', symbol: 'XRP', kind: 'native' },
      { chainId: 'xrpl-testnet', symbol: 'XRP', kind: 'native' },
    ],
  },
  {
    id: 'eth',
    name: 'ETH',
    deployments: [
      { chainId: 'base-mainnet', symbol: 'ETH', kind: 'native' },
      { chainId: 'base-sepolia', symbol: 'ETH', kind: 'native' },
    ],
  },
  {
    id: 'xlm',
    name: 'XLM',
    deployments: [
      { chainId: 'stellar-mainnet', symbol: 'XLM', kind: 'native' },
      { chainId: 'stellar-testnet', symbol: 'XLM', kind: 'native' },
    ],
  },
  {
    id: 'usdc',
    name: 'USDC',
    deployments: [
      { chainId: 'base-mainnet', symbol: 'USDC', kind: 'issued', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
      { chainId: 'base-sepolia', symbol: 'USDC', kind: 'issued', address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
      { chainId: 'stellar-mainnet', symbol: 'USDC', kind: 'issued', address: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
      { chainId: 'stellar-testnet', symbol: 'USDC', kind: 'issued', address: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
      { chainId: 'xrpl-mainnet', symbol: 'USDC', kind: 'issued', address: 'rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE' },
      { chainId: 'xrpl-testnet', symbol: 'USDC', kind: 'issued', address: 'rHuGNhqTG32mfmAvWA8hUyWRLV3tCSwKQt' },
    ],
  },
  {
    id: 'rlusd',
    name: 'RLUSD',
    deployments: [
      { chainId: 'xrpl-mainnet', symbol: 'RLUSD', kind: 'issued', address: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' },
      { chainId: 'xrpl-testnet', symbol: 'RLUSD', kind: 'issued', address: 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV' },
    ],
  },
] as const;

export function defaultCatalogSnapshot(): CatalogSnapshot {
  return {
    chains: BUILTIN_CHAINS.map((chain) => ({ ...chain, enabled: true })),
    assets: BUILTIN_ASSETS.map((asset) => ({ ...asset, deployments: [...asset.deployments], trustState: 'allowed' })),
  };
}

export function deploymentFor(asset: SupportedAsset, chainId: string): AssetDeployment | undefined {
  return asset.deployments.find((deployment) => deployment.chainId === chainId);
}
