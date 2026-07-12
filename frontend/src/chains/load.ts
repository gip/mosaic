import type {
  BalancesFeed,
  BalancesFeedOptions,
  BalancesRequest,
  DexChain,
  OrderBookFeed,
  OrderBookFeedOptions,
  OrderBookRequest,
  QuoteSurfaceFeed,
  QuoteSurfaceFeedOptions,
} from '@mosaic/chain-core';

/** The factory surface every chain package exports. */
export interface ChainModule {
  createOrderBookFeed(request: OrderBookRequest, options?: OrderBookFeedOptions): OrderBookFeed;
  createQuoteSurfaceFeed(request: OrderBookRequest, options?: QuoteSurfaceFeedOptions): QuoteSurfaceFeed;
  createBalancesFeed(request: BalancesRequest, options?: BalancesFeedOptions): BalancesFeed;
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
