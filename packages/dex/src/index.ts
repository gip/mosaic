export type {
  AdapterFetchOptions,
  AdapterStreamEvent,
  AdapterStreamOptions,
  AdapterSurfaceEvent,
  AdapterSurfaceOptions,
  Asset,
  DexAdapter,
  DexChain,
  FeedEvent,
  FeedStatus,
  FundedAccounts,
  Network,
  OrderBookFeed,
  OrderBookFeedOptions,
  OrderBookLevel,
  OrderBookRequest,
  OrderBookSnapshot,
  QuoteSample,
  QuoteSurface,
  QuoteSurfaceFeed,
  QuoteSurfaceFeedOptions,
  StreamHandle,
  SurfaceFeedEvent,
} from './types.js';
export { UnsupportedChainError } from './errors.js';
export { StreamingFeed } from './feed.js';
export { SurfaceFeed } from './surfaceFeed.js';

import { StreamingFeed } from './feed.js';
import { SurfaceFeed } from './surfaceFeed.js';
import { UnsupportedChainError } from './errors.js';
import type {
  DexAdapter,
  DexChain,
  OrderBookFeed,
  OrderBookFeedOptions,
  OrderBookRequest,
  QuoteSurfaceFeed,
  QuoteSurfaceFeedOptions,
} from './types.js';

/**
 * Create a streaming order-book feed for a pair. Rejects with
 * UnsupportedChainError at creation time for chains without DEX support
 * (currently 'evm'). Chain modules are imported on demand so browser bundles
 * only carry the chains they use.
 */
export async function createOrderBookFeed(
  request: OrderBookRequest,
  options: OrderBookFeedOptions = {},
): Promise<OrderBookFeed> {
  const adapter = await loadAdapter(request.chain);
  return new StreamingFeed(adapter, request, options);
}

/**
 * Create an executable-quote-surface feed (chain pathfinding sampled across a
 * ladder of trade sizes). XRPL streams via `path_find`; Stellar polls its
 * `/paths` endpoints; the interface is identical. Rejects with
 * UnsupportedChainError for chains without DEX support (currently 'evm').
 */
export async function createQuoteSurfaceFeed(
  request: OrderBookRequest,
  options: QuoteSurfaceFeedOptions = {},
): Promise<QuoteSurfaceFeed> {
  const adapter = await loadAdapter(request.chain);
  return new SurfaceFeed(adapter, request, options);
}

async function loadAdapter(chain: DexChain): Promise<DexAdapter> {
  switch (chain) {
    case 'stellar':
      return (await import('./stellar/index.js')).createAdapter();
    case 'xrpl':
      return (await import('./xrpl/index.js')).createAdapter();
    case 'evm':
      return (await import('./evm/index.js')).createAdapter();
    default:
      throw new UnsupportedChainError(String(chain));
  }
}
