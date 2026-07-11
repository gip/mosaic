export type ChainFamily = 'evm' | 'xrpl' | 'stellar';
export type NetworkTag = 'mainnet' | 'testnet';
export type ChainSource = 'static' | 'database';
export type AssetTrustState = 'hidden' | 'review' | 'allowed';

export interface SupportedChain {
  id: string;
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

export interface ChainWithTrust extends SupportedChain {
  trusted: boolean;
}

export interface AssetWithTrust extends SupportedAsset {
  trustState: AssetTrustState;
}

export interface CatalogSnapshot {
  chains: ChainWithTrust[];
  assets: AssetWithTrust[];
}

export const BUILTIN_CHAINS: readonly SupportedChain[] = [
  { id: 'base-mainnet', name: 'Base', family: 'evm', network: 'mainnet', source: 'static', evmChainId: 8453 },
  { id: 'base-sepolia', name: 'Base Sepolia', family: 'evm', network: 'testnet', source: 'static', evmChainId: 84532 },
  { id: 'xrpl-mainnet', name: 'XRPL', family: 'xrpl', network: 'mainnet', source: 'static' },
  { id: 'xrpl-testnet', name: 'XRPL Testnet', family: 'xrpl', network: 'testnet', source: 'static' },
  { id: 'stellar-mainnet', name: 'Stellar', family: 'stellar', network: 'mainnet', source: 'static' },
  { id: 'stellar-testnet', name: 'Stellar Testnet', family: 'stellar', network: 'testnet', source: 'static' },
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
    chains: BUILTIN_CHAINS.map((chain) => ({ ...chain, trusted: true })),
    assets: BUILTIN_ASSETS.map((asset) => ({ ...asset, deployments: [...asset.deployments], trustState: 'allowed' })),
  };
}

export function deploymentFor(asset: SupportedAsset, chainId: string): AssetDeployment | undefined {
  return asset.deployments.find((deployment) => deployment.chainId === chainId);
}
