import { PollingBalancesFeed, StreamingFeed, SurfaceFeed } from '@mosaic/chain-core';
import type {
  BalancesFeed,
  BalancesFeedOptions,
  BalancesRequest,
  OrderBookFeed,
  OrderBookFeedOptions,
  OrderBookRequest,
  QuoteSurfaceFeed,
  QuoteSurfaceFeedOptions,
} from '@mosaic/chain-core';
import { createAdapter } from './adapter.js';
import { fetchBalances } from './balances.js';

export { HORIZON_ENDPOINTS, createAdapter } from './adapter.js';
export { readSseStream } from './sse.js';
export type { SseMessage } from './sse.js';
export { fetchBalances } from './balances.js';

/** Streaming Stellar order-book feed (Horizon SSE over `fetch`). */
export function createOrderBookFeed(
  request: OrderBookRequest,
  options: OrderBookFeedOptions = {},
): OrderBookFeed {
  return new StreamingFeed(createAdapter(), request, options);
}

/** Executable-quote-surface feed polling Horizon `/paths/strict-send|receive`. */
export function createQuoteSurfaceFeed(
  request: OrderBookRequest,
  options: QuoteSurfaceFeedOptions = {},
): QuoteSurfaceFeed {
  return new SurfaceFeed(createAdapter(), request, options);
}

/** Polling balances feed for known assets across Stellar accounts. */
export function createBalancesFeed(
  request: BalancesRequest,
  options: BalancesFeedOptions = {},
): BalancesFeed {
  return new PollingBalancesFeed(fetchBalances, request, options);
}
