import type {
  BalancesFeed,
  BalancesFeedOptions,
  BalancesRequest,
  DexChain,
  Network,
  OrderBookFeed,
  OrderBookFeedOptions,
  OrderBookRequest,
  QuoteSurfaceFeed,
  QuoteSurfaceFeedOptions,
} from '@mosaic/chain-core';
import { XRPL_WS_ENDPOINTS } from '../config';

/** The factory surface every chain package exports. */
export interface ChainModule {
  createOrderBookFeed(request: OrderBookRequest, options?: OrderBookFeedOptions): OrderBookFeed;
  createQuoteSurfaceFeed(request: OrderBookRequest, options?: QuoteSurfaceFeedOptions): QuoteSurfaceFeed;
  createBalancesFeed(request: BalancesRequest, options?: BalancesFeedOptions): BalancesFeed;
  /** Chain-native validation helpers, loaded with the chain's lazy chunk. */
  isValidXrplIssuer?(address: string): boolean;
  isValidStellarIssuer?(address: string): boolean;
  normalizeCurrency?(code: string): string;
  decodeCurrency?(code: string): string | null;
}

/**
 * Dynamic-import the chain package for a chain family. Literal specifiers per
 * case keep Vite code-splitting one lazy chunk per chain, so the entry bundle
 * carries none of them.
 */
export function loadChainModule(chain: DexChain): Promise<ChainModule> {
  switch (chain) {
    case 'xrpl':
      return import('@mosaic/xrpl');
    case 'stellar':
      return import('@mosaic/stellar');
    case 'evm':
      return import('@mosaic/evm');
  }
}

/** Configured node overrides to spread into any feed's options for a chain. */
export function feedEndpoints(chain: DexChain, network: Network): { streamEndpoint?: string } {
  const streamEndpoint = chain === 'xrpl' ? XRPL_WS_ENDPOINTS[network] : undefined;
  return streamEndpoint ? { streamEndpoint } : {};
}
