import type {
  DexAdapter,
  FeedEvent,
  FeedStatus,
  OrderBookFeed,
  OrderBookFeedOptions,
  OrderBookRequest,
  OrderBookSnapshot,
  StreamHandle,
} from './types.js';

const DEFAULT_DEPTH = 20;
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const REFRESH_TIMEOUT_MS = 10_000;

/**
 * Streaming order-book feed over a chain adapter. Reconnects with exponential
 * backoff while started; stream errors surface as events, never as throws.
 */
export class StreamingFeed implements OrderBookFeed {
  readonly request: OrderBookRequest;

  #adapter: DexAdapter;
  #depth: number;
  #httpEndpoint: string | undefined;
  #streamEndpoint: string | undefined;
  #fetch: typeof fetch;
  #webSocket: typeof WebSocket;

  #listeners = new Set<(event: FeedEvent) => void>();
  #latest: OrderBookSnapshot | null = null;
  #status: FeedStatus = 'idle';
  #started = false;
  #handle: StreamHandle | null = null;
  /** Incremented per stream open so events from stale handles are ignored. */
  #generation = 0;
  #backoffMs = BACKOFF_INITIAL_MS;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(adapter: DexAdapter, request: OrderBookRequest, options: OrderBookFeedOptions = {}) {
    this.request = request;
    this.#adapter = adapter;
    this.#depth = options.depth ?? DEFAULT_DEPTH;
    this.#httpEndpoint = options.httpEndpoint;
    this.#streamEndpoint = options.streamEndpoint;
    this.#fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.#webSocket = options.webSocket ?? globalThis.WebSocket;
  }

  get latest(): OrderBookSnapshot | null {
    return this.#latest;
  }

  get status(): FeedStatus {
    return this.#status;
  }

  subscribe(cb: (event: FeedEvent) => void): () => void {
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
    this.#open();
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#generation += 1;
    this.#handle?.close();
    this.#handle = null;
    this.#setStatus('idle');
  }

  async refresh(): Promise<OrderBookSnapshot> {
    const snapshot = await this.#adapter.fetchOrderBook(this.request, {
      depth: this.#depth,
      httpEndpoint: this.#httpEndpoint,
      streamEndpoint: this.#streamEndpoint,
      fetch: this.#fetch,
      webSocket: this.#webSocket,
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
    this.#latest = snapshot;
    this.#emit({ type: 'snapshot', snapshot });
    return snapshot;
  }

  #open(): void {
    const generation = ++this.#generation;
    try {
      this.#handle = this.#adapter.openStream(
        this.request,
        {
          depth: this.#depth,
          streamEndpoint: this.#streamEndpoint,
          fetch: this.#fetch,
          webSocket: this.#webSocket,
        },
        (event) => {
          if (!this.#started || generation !== this.#generation) return;
          if (event.type === 'snapshot') {
            this.#latest = event.snapshot;
            this.#backoffMs = BACKOFF_INITIAL_MS;
            this.#setStatus('live');
            this.#emit({ type: 'snapshot', snapshot: event.snapshot });
          } else if (event.type === 'error') {
            this.#emit({ type: 'error', error: event.error });
          } else {
            this.#scheduleReconnect();
          }
        },
      );
    } catch (err) {
      // Deterministic failure (e.g. invalid asset spec): report and stop
      // rather than reconnect-looping on an error that cannot heal.
      this.#started = false;
      this.#handle = null;
      this.#emit({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
      this.#setStatus('idle');
    }
  }

  #scheduleReconnect(): void {
    if (!this.#started || this.#reconnectTimer !== null) return;
    this.#generation += 1;
    this.#handle?.close();
    this.#handle = null;
    this.#setStatus('reconnecting');
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(this.#backoffMs * 2, BACKOFF_MAX_MS);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (this.#started) this.#open();
    }, delay);
  }

  #setStatus(status: FeedStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#emit({ type: 'status', status });
  }

  #emit(event: FeedEvent): void {
    for (const cb of [...this.#listeners]) {
      try {
        cb(event);
      } catch {
        // A throwing listener must not break the feed or other listeners.
      }
    }
  }
}
