import { PollingBalancesFeed, UnsupportedChainError } from '@mosaic/chain-core';
import type {
  BalancesFeed,
  BalancesFeedOptions,
  BalancesRequest,
  DexAdapter,
  OrderBookFeed,
  OrderBookFeedOptions,
  OrderBookRequest,
  QuoteSurfaceFeed,
  QuoteSurfaceFeedOptions,
} from '@mosaic/chain-core';
import { fetchBalances } from './balances.js';

export { EVM_RPC_ENDPOINTS, fetchBalances } from './balances.js';
export {
  evmTransactionHash,
  lookupEvmTransfer,
  prepareEvmTransfer,
  signEvmTransfer,
  submitEvmTransfer,
  verifyEvmTransfer,
  verifyWalletEvmTransfer,
  type EvmTransactionRequest,
  type PreparedEvmTransfer,
} from './transfers.js';

/** EVM DEX order books are not supported yet. */
export function createAdapter(): DexAdapter {
  throw new UnsupportedChainError('evm');
}

/** Throws synchronously: EVM DEX order books are not supported yet. */
export function createOrderBookFeed(
  _request: OrderBookRequest,
  _options: OrderBookFeedOptions = {},
): OrderBookFeed {
  throw new UnsupportedChainError('evm');
}

/** Throws synchronously: EVM quote surfaces are not supported yet. */
export function createQuoteSurfaceFeed(
  _request: OrderBookRequest,
  _options: QuoteSurfaceFeedOptions = {},
): QuoteSurfaceFeed {
  throw new UnsupportedChainError('evm');
}

/** Polling balances feed for known assets across EVM (Base) accounts. */
export function createBalancesFeed(
  request: BalancesRequest,
  options: BalancesFeedOptions = {},
): BalancesFeed {
  return new PollingBalancesFeed(fetchBalances, request, options);
}
