import type { Asset, DexChain, OrderBookRequest } from '@mosaic/chain-core';

/** Which market-data sources a pair card displays. */
export interface PairSources {
  /** Central limit order book, streamed. */
  clob: boolean;
  /** Executable quote surface via pathfinding. */
  paths: boolean;
}

/** A configured trading pair on the /dex page. */
export interface PairConfig extends OrderBookRequest {
  id: string;
  sources: PairSources;
}

export type ChartKind = 'depth' | 'mid' | 'spread' | 'quotes';

export const CHART_KIND_SOURCE: Record<ChartKind, keyof PairSources> = {
  depth: 'clob',
  mid: 'clob',
  spread: 'clob',
  quotes: 'paths',
};

export const NATIVE_SYMBOLS: Record<DexChain, string> = {
  stellar: 'XLM',
  xrpl: 'XRP',
  evm: 'ETH',
};

export function assetLabel(asset: Asset, chain: DexChain): string {
  return asset.kind === 'native' ? NATIVE_SYMBOLS[chain] : asset.code;
}

export function pairLabel(pair: PairConfig): string {
  return `${assetLabel(pair.base, pair.chain)} / ${assetLabel(pair.quote, pair.chain)}`;
}
