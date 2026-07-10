import type {
  DexAdapter,
  FeedStatus,
  OrderBookRequest,
  OrderBookSnapshot,
  QuoteSurface,
  QuoteSurfaceFeed,
  QuoteSurfaceFeedOptions,
  StreamHandle,
  SurfaceFeedEvent,
} from './types.js';

const DEFAULT_SAMPLE_COUNT = 5;
/**
 * Book depth used to derive the sample ladder. Matches the order-book feed's
 * default display depth so the largest sample stays within the book a viewer
 * sees (charts overlay the surface on the depth view).
 */
const DERIVE_BOOK_DEPTH = 200;
const DEFAULT_INTERVAL_MS = 12_000;
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const FETCH_TIMEOUT_MS = 20_000;
const DERIVE_TIMEOUT_MS = 10_000;

interface SurfaceParams {
  sizes: string[];
  referencePrice: string;
}

/** Render a positive number with at most 6 decimals (valid on both chains). */
function toAmountString(value: number): string {
  return value.toFixed(6).replace(/\.?0+$/, '');
}

/**
 * Executable-quote-surface feed over a chain adapter. Chains with streaming
 * pathfinding (XRPL `path_find`) stream with reconnect/backoff; the rest
 * (Stellar `/paths`) poll `fetchQuoteSurface` on an interval. One interface
 * either way.
 */
export class SurfaceFeed implements QuoteSurfaceFeed {
  readonly request: OrderBookRequest;

  #adapter: DexAdapter;
  #options: QuoteSurfaceFeedOptions;
  #fetch: typeof fetch;
  #webSocket: typeof WebSocket;

  #listeners = new Set<(event: SurfaceFeedEvent) => void>();
  #latest: QuoteSurface | null = null;
  #status: FeedStatus = 'idle';
  #started = false;
  #handle: StreamHandle | null = null;
  #generation = 0;
  #backoffMs = BACKOFF_INITIAL_MS;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #derived: SurfaceParams | null = null;

  constructor(adapter: DexAdapter, request: OrderBookRequest, options: QuoteSurfaceFeedOptions = {}) {
    this.request = request;
    this.#adapter = adapter;
    this.#options = options;
    this.#fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.#webSocket = options.webSocket ?? globalThis.WebSocket;
  }

  get latest(): QuoteSurface | null {
    return this.#latest;
  }

  get status(): FeedStatus {
    return this.#status;
  }

  subscribe(cb: (event: SurfaceFeedEvent) => void): () => void {
    this.#listeners.add(cb);
    return () => {
      this.#listeners.delete(cb);
    };
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#backoffMs = BACKOFF_INITIAL_MS;
    this.#setStatus('connecting');
    const generation = ++this.#generation;
    void this.#run(generation);
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    this.#generation += 1;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#handle?.close();
    this.#handle = null;
    this.#setStatus('idle');
  }

  async refresh(): Promise<QuoteSurface> {
    const params = await this.#deriveParams();
    const surface = await this.#adapter.fetchQuoteSurface(this.request, {
      ...this.#surfaceOpts(params),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    this.#latest = surface;
    this.#emit({ type: 'surface', surface });
    return surface;
  }

  async #run(generation: number): Promise<void> {
    let params: SurfaceParams;
    try {
      params = await this.#deriveParams();
    } catch (err) {
      // Derivation failures (empty book, bad request) cannot self-heal.
      if (!this.#started || generation !== this.#generation) return;
      this.#started = false;
      this.#emit({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
      this.#setStatus('idle');
      return;
    }
    if (!this.#started || generation !== this.#generation) return;
    if (this.#adapter.openSurfaceStream) {
      this.#openStream(params);
    } else {
      void this.#pollOnce(params, generation);
    }
  }

  #openStream(params: SurfaceParams): void {
    const generation = ++this.#generation;
    this.#handle = this.#adapter.openSurfaceStream!(this.request, this.#surfaceOpts(params), (event) => {
      if (!this.#started || generation !== this.#generation) return;
      if (event.type === 'surface') {
        this.#latest = event.surface;
        this.#backoffMs = BACKOFF_INITIAL_MS;
        this.#setStatus('live');
        this.#emit({ type: 'surface', surface: event.surface });
      } else if (event.type === 'error') {
        this.#emit({ type: 'error', error: event.error });
      } else {
        this.#scheduleStreamReconnect(params);
      }
    });
  }

  #scheduleStreamReconnect(params: SurfaceParams): void {
    if (!this.#started || this.#timer !== null) return;
    this.#generation += 1;
    this.#handle?.close();
    this.#handle = null;
    this.#setStatus('reconnecting');
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(this.#backoffMs * 2, BACKOFF_MAX_MS);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#started) this.#openStream(params);
    }, delay);
  }

  async #pollOnce(params: SurfaceParams, generation: number): Promise<void> {
    let delay: number;
    try {
      const surface = await this.#adapter.fetchQuoteSurface(this.request, {
        ...this.#surfaceOpts(params),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!this.#started || generation !== this.#generation) return;
      this.#latest = surface;
      this.#backoffMs = BACKOFF_INITIAL_MS;
      this.#setStatus('live');
      this.#emit({ type: 'surface', surface });
      delay = this.#options.intervalMs ?? DEFAULT_INTERVAL_MS;
    } catch (err) {
      if (!this.#started || generation !== this.#generation) return;
      this.#emit({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
      this.#setStatus('reconnecting');
      delay = this.#backoffMs;
      this.#backoffMs = Math.min(this.#backoffMs * 2, BACKOFF_MAX_MS);
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#started && generation === this.#generation) void this.#pollOnce(params, generation);
    }, delay);
  }

  /**
   * Resolve the sample ladder and reference price, fetching the order book
   * once to derive whatever the caller did not pin explicitly. Pairs whose
   * liquidity is AMM-only (empty CLOB — pathfinding still routes) fall back
   * to a 1-unit pathfinding probe for the price and a geometric ladder.
   */
  async #deriveParams(): Promise<SurfaceParams> {
    if (this.#derived) return this.#derived;
    let sizes = this.#options.sampleSizes;
    let referencePrice = this.#options.referencePrice;
    const count = this.#options.sampleCount ?? DEFAULT_SAMPLE_COUNT;
    if (!sizes || !referencePrice) {
      let book: OrderBookSnapshot | null = null;
      try {
        book = await this.#adapter.fetchOrderBook(this.request, {
          depth: DERIVE_BOOK_DEPTH,
          httpEndpoint: this.#options.httpEndpoint,
          streamEndpoint: this.#options.streamEndpoint,
          fetch: this.#fetch,
          webSocket: this.#webSocket,
          signal: AbortSignal.timeout(DERIVE_TIMEOUT_MS),
        });
      } catch {
        // The CLOB is only a sizing heuristic; pathfinding may still work.
      }
      if (!referencePrice) referencePrice = (book && midPrice(book)) ?? (await this.#probeReferencePrice());
      if (!sizes) sizes = (book && deriveSizes(book, count)) ?? geometricSizes(count);
    }
    this.#derived = { sizes, referencePrice };
    return this.#derived;
  }

  /** Buy 1 base unit via pathfinding; its avg price anchors the ladder. */
  async #probeReferencePrice(): Promise<string> {
    const probe = await this.#adapter.fetchQuoteSurface(this.request, {
      ...this.#surfaceOpts({ sizes: ['1'], referencePrice: '0' }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const price = probe.buy[0]?.avgPrice;
    if (!price) {
      throw new Error(
        'cannot derive a reference price: empty order book and no pathfinding route for 1 base unit — pass referencePrice',
      );
    }
    return price;
  }

  #surfaceOpts(params: SurfaceParams) {
    return {
      sizes: params.sizes,
      referencePrice: params.referencePrice,
      httpEndpoint: this.#options.httpEndpoint,
      streamEndpoint: this.#options.streamEndpoint,
      fetch: this.#fetch,
      webSocket: this.#webSocket,
    };
  }

  #setStatus(status: FeedStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#emit({ type: 'status', status });
  }

  #emit(event: SurfaceFeedEvent): void {
    for (const cb of [...this.#listeners]) {
      try {
        cb(event);
      } catch {
        // A throwing listener must not break the feed or other listeners.
      }
    }
  }
}

function midPrice(book: OrderBookSnapshot): string | null {
  const prices = [book.bids[0]?.price, book.asks[0]?.price].filter((p): p is string => Boolean(p));
  if (prices.length === 0) return null;
  return toAmountString(prices.reduce((sum, p) => sum + Number(p), 0) / prices.length);
}

function deriveSizes(book: OrderBookSnapshot, count: number): string[] | null {
  const depthOf = (levels: { amount: string }[]) =>
    levels.reduce((sum, level) => sum + Number(level.amount), 0);
  const sides = [depthOf(book.bids), depthOf(book.asks)].filter((d) => d > 0);
  if (sides.length === 0) return null;
  const depth = Math.min(...sides);
  const sizes: string[] = [];
  for (let i = 1; i <= count; i++) {
    const size = (depth * i) / count;
    if (size > 0) sizes.push(toAmountString(size));
  }
  return sizes.length > 0 ? sizes : null;
}

/** 1, 10, 100, … — the sizing fallback when there is no visible book. */
function geometricSizes(count: number): string[] {
  return Array.from({ length: count }, (_, i) => (10 ** i).toString());
}
