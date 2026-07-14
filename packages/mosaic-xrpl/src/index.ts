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

export {
  XRPL_HTTP_ENDPOINTS,
  XRPL_WS_ENDPOINTS,
  createAdapter,
  decodeCurrency,
  isValidXrplIssuer,
  normalizeCurrency,
  toXrplAmountSpec,
  wsRequestBatchSettled,
} from './adapter.js';
export type { XrplBatchOutcome, XrplRpcResult } from './adapter.js';
export { fetchBalances } from './balances.js';
export {
  prepareXrplCancel,
  prepareXrplOrder,
  getXrplOfferRemaining,
  lookupXrplTransaction,
  normalizeXrplAssetAmount,
  signXrplTransaction,
  submitXrplTransaction,
  verifyXrplTransaction,
  xrplTransactionHash,
  type PreparedXrplOrder,
} from './orders.js';

/** Streaming XRPL order-book feed (WS `subscribe` books + debounced `book_offers`). */
export function createOrderBookFeed(
  request: OrderBookRequest,
  options: OrderBookFeedOptions = {},
): OrderBookFeed {
  return new StreamingFeed(createAdapter(), request, options);
}

/** Executable-quote-surface feed streaming WS `path_find` cycles per ledger close. */
export function createQuoteSurfaceFeed(
  request: OrderBookRequest,
  options: QuoteSurfaceFeedOptions = {},
): QuoteSurfaceFeed {
  return new SurfaceFeed(createAdapter(), request, options);
}

/** Polling balances feed for known assets across XRPL accounts. */
export function createBalancesFeed(
  request: BalancesRequest,
  options: BalancesFeedOptions = {},
): BalancesFeed {
  return new PollingBalancesFeed(fetchBalances, request, options);
}
