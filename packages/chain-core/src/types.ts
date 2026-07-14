/**
 * Shared chain-service types for @mosaic/chain-core: DEX order books, quote
 * surfaces, and asset balances, implemented per chain by @mosaic/xrpl,
 * @mosaic/stellar, and @mosaic/evm.
 *
 * `DexChain` uses the same literals as `RootChain` in @mosaic/zone-keys, but is
 * declared locally: this package is public chain data only and must not pull
 * the custody/derivation package into its build graph. Structural typing keeps
 * the two interchangeable at call sites.
 */

export type DexChain = 'stellar' | 'xrpl' | 'evm';

export type Network = 'mainnet' | 'testnet';

/**
 * An asset on a chain's DEX. `issued` covers Stellar/XRPL issued assets
 * (code + issuer account); for future EVM support `issuer` is the token
 * contract address.
 */
export type Asset =
  | { kind: 'native' }
  | { kind: 'issued'; code: string; issuer: string };

/**
 * One price level. Values are decimal strings: Horizon and XRPL both return
 * strings, and Number cannot represent drop counts or 15-significant-digit
 * IOU values exactly. Convert to Number only at display boundaries.
 */
export interface OrderBookLevel {
  /** Price in quote units per one base unit. */
  price: string;
  /** Size in base units. */
  amount: string;
}

/**
 * Accounts that are funded in the corresponding pair asset. XRPL pathfinding
 * is account-specific, so it uses the quote-funded account to buy base and
 * the base-funded account to sell base. Stellar's asset-only path endpoints
 * use `null` for both fields.
 */
export interface FundedAccounts {
  base: string | null;
  quote: string | null;
}

export interface OrderBookRequest {
  chain: DexChain;
  network: Network;
  base: Asset;
  quote: Asset;
  fundedAccounts: FundedAccounts;
}

export interface OrderBookSnapshot {
  chain: DexChain;
  network: Network;
  base: Asset;
  quote: Asset;
  /** Best (highest price) first. */
  bids: OrderBookLevel[];
  /** Best (lowest price) first. */
  asks: OrderBookLevel[];
  /** Date.now() when the snapshot was assembled. */
  timestamp: number;
}

export interface OrderBookFeedOptions {
  /** Max levels per side. Default 500. */
  depth?: number;
  /** Override the HTTP endpoint (Horizon base URL / XRPL JSON-RPC URL). */
  httpEndpoint?: string;
  /** Override the stream endpoint (Horizon base URL for SSE / XRPL WS URL). */
  streamEndpoint?: string;
  /** Injectable fetch (REST + SSE). Default globalThis.fetch. */
  fetch?: typeof fetch;
  /** Injectable WebSocket constructor (XRPL). Default globalThis.WebSocket. */
  webSocket?: typeof WebSocket;
}

export type FeedStatus = 'idle' | 'connecting' | 'live' | 'reconnecting';

export type FeedEvent =
  | { type: 'snapshot'; snapshot: OrderBookSnapshot }
  | { type: 'status'; status: FeedStatus }
  | { type: 'error'; error: Error };

export interface OrderBookFeed {
  readonly request: OrderBookRequest;
  /** Last good snapshot; survives stream drops and failed refreshes. */
  readonly latest: OrderBookSnapshot | null;
  readonly status: FeedStatus;
  /** One-shot HTTP fetch; works whether or not the stream is running. */
  refresh(): Promise<OrderBookSnapshot>;
  /** Register a listener. Returns an unsubscribe function. */
  subscribe(cb: (event: FeedEvent) => void): () => void;
  /** Open the stream. Idempotent. */
  start(): void;
  /** Close the stream and stop reconnecting. */
  stop(): void;
}

export interface StreamHandle {
  close(): void;
}

/**
 * One point on the executable quote surface. `amount` is the base quantity
 * actually traded, `total` the quote paid (buy) or received (sell), and
 * `avgPrice` = total / amount in quote-per-base. Decimal strings throughout.
 */
export interface QuoteSample {
  amount: string;
  total: string;
  avgPrice: string;
  /**
   * Requested quote-side notional that produced this sample, when the feed
   * was configured with `quoteAmounts`. The actual `total` may vary slightly
   * when the underlying path API executes on the base side.
   */
  quoteAmount?: string;
}

/**
 * Executable quotes at sampled trade sizes, obtained via chain pathfinding
 * (multi-hop routes and AMM pools included — unlike the raw CLOB).
 */
export interface QuoteSurface {
  chain: DexChain;
  network: Network;
  base: Asset;
  quote: Asset;
  /** Proceeds of selling base, ascending by amount (bid-side executable). */
  sell: QuoteSample[];
  /** Cost of buying base, ascending by amount (ask-side executable). */
  buy: QuoteSample[];
  timestamp: number;
}

export interface QuoteSurfaceFeedOptions {
  /** Base-amount ladder to sample. Default: derived from visible book depth. */
  sampleSizes?: string[];
  /**
   * Quote-side notionals to sample. The feed converts these to base amounts
   * from its reference price, preserving the requested ladder for display.
   * Cannot be combined with `sampleSizes`.
   */
  quoteAmounts?: string[];
  /** Ladder length when deriving sizes. Default 5. */
  sampleCount?: number;
  /** Poll interval for chains without streaming pathfinding. Default 12000. */
  intervalMs?: number;
  /** Reference quote-per-base price (XRPL sell ladder). Default: book mid. */
  referencePrice?: string;
  httpEndpoint?: string;
  streamEndpoint?: string;
  fetch?: typeof fetch;
  webSocket?: typeof WebSocket;
}

export type SurfaceFeedEvent =
  | { type: 'surface'; surface: QuoteSurface }
  | { type: 'status'; status: FeedStatus }
  | { type: 'error'; error: Error };

export interface QuoteSurfaceFeed {
  readonly request: OrderBookRequest;
  readonly latest: QuoteSurface | null;
  readonly status: FeedStatus;
  refresh(): Promise<QuoteSurface>;
  subscribe(cb: (event: SurfaceFeedEvent) => void): () => void;
  start(): void;
  stop(): void;
}

export type AdapterSurfaceEvent =
  | { type: 'surface'; surface: QuoteSurface }
  | { type: 'error'; error: Error }
  | { type: 'closed' };

export interface AdapterSurfaceOptions {
  /** Base-amount ladder, ascending. */
  sizes: string[];
  /** Quote-per-base reference price for chains that ladder the quote side. */
  referencePrice: string;
  /** Requested quote-side notionals corresponding to `sizes`, if supplied. */
  quoteAmounts?: string[];
  httpEndpoint?: string;
  streamEndpoint?: string;
  fetch: typeof fetch;
  webSocket: typeof WebSocket;
  signal?: AbortSignal;
}

/** Events an adapter stream reports to the feed. */
export type AdapterStreamEvent =
  | { type: 'snapshot'; snapshot: OrderBookSnapshot }
  | { type: 'error'; error: Error }
  | { type: 'closed' };

export interface AdapterFetchOptions {
  depth: number;
  httpEndpoint?: string;
  streamEndpoint?: string;
  fetch: typeof fetch;
  /** Used by chains whose one-shot fetch rides a WebSocket (XRPL). */
  webSocket?: typeof WebSocket;
  signal?: AbortSignal;
}

export interface AdapterStreamOptions {
  depth: number;
  streamEndpoint?: string;
  fetch: typeof fetch;
  webSocket: typeof WebSocket;
}

/** Implemented by each chain package (@mosaic/stellar, @mosaic/xrpl, @mosaic/evm). */
export interface DexAdapter {
  fetchOrderBook(req: OrderBookRequest, opts: AdapterFetchOptions): Promise<OrderBookSnapshot>;
  openStream(
    req: OrderBookRequest,
    opts: AdapterStreamOptions,
    emit: (event: AdapterStreamEvent) => void,
  ): StreamHandle;
  /** One-shot pathfinding sweep across the size ladder. */
  fetchQuoteSurface(req: OrderBookRequest, opts: AdapterSurfaceOptions): Promise<QuoteSurface>;
  /**
   * Streaming pathfinding, where the chain supports it (XRPL `path_find`).
   * Absent → the surface feed polls `fetchQuoteSurface` on `intervalMs`.
   */
  openSurfaceStream?(
    req: OrderBookRequest,
    opts: AdapterSurfaceOptions,
    emit: (event: AdapterSurfaceEvent) => void,
  ): StreamHandle;
}

/**
 * An asset whose balance a consumer tracks. Extends `Asset` with a display
 * symbol so results stay self-describing; for EVM `issued` assets `issuer` is
 * the ERC-20 contract address (as documented on `Asset`).
 */
export type KnownAsset = { symbol: string } & Asset;

export interface BalancesRequest {
  network: Network;
  /** Chain-native account addresses (r…, G…, 0x…). */
  addresses: string[];
  assets: KnownAsset[];
}

export interface AssetBalance {
  asset: KnownAsset;
  /** Decimal string; '0' when the account holds none of the asset. */
  amount: string;
}

export interface AccountBalances {
  address: string;
  /**
   * False when the account does not exist on-ledger (XRPL actNotFound,
   * Horizon 404). EVM accounts always report true.
   */
  funded: boolean;
  /** One entry per requested asset, in request order. */
  balances: AssetBalance[];
}

export interface BalancesSnapshot {
  network: Network;
  /** One entry per requested address, in request order. */
  accounts: AccountBalances[];
  /** Date.now() when the snapshot was assembled. */
  timestamp: number;
}

export type BalancesEvent =
  | { type: 'balances'; balances: BalancesSnapshot }
  | { type: 'status'; status: FeedStatus }
  | { type: 'error'; error: Error };

export interface BalancesFeedOptions {
  /** Poll interval. Default 30000. */
  intervalMs?: number;
  /** Override the HTTP endpoint (Horizon base URL / EVM JSON-RPC URL). */
  httpEndpoint?: string;
  /** Override the stream endpoint (XRPL WS URL). */
  streamEndpoint?: string;
  fetch?: typeof fetch;
  webSocket?: typeof WebSocket;
}

export interface BalancesFetchOptions {
  httpEndpoint?: string;
  streamEndpoint?: string;
  fetch: typeof fetch;
  webSocket?: typeof WebSocket;
  signal?: AbortSignal;
}

/** One-shot per-chain balance fetch; the polling feed wraps one of these. */
export type BalancesFetcher = (
  req: BalancesRequest,
  opts: BalancesFetchOptions,
) => Promise<BalancesSnapshot>;

export interface BalancesFeed {
  readonly request: BalancesRequest;
  /** Last good snapshot; survives failed polls. */
  readonly latest: BalancesSnapshot | null;
  readonly status: FeedStatus;
  /** One-shot fetch; works whether or not polling is running. */
  refresh(): Promise<BalancesSnapshot>;
  subscribe(cb: (event: BalancesEvent) => void): () => void;
  /** Start polling. Idempotent. */
  start(): void;
  /** Stop polling. */
  stop(): void;
}
