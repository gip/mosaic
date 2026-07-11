import type {
  BalancesEvent,
  BalancesFeed,
  BalancesFeedOptions,
  BalancesFetcher,
  BalancesRequest,
  BalancesSnapshot,
  FeedStatus,
} from './types.js';

const DEFAULT_INTERVAL_MS = 30_000;
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const FETCH_TIMEOUT_MS = 20_000;

/**
 * Polling balances feed over a chain-specific fetcher. No chain exposes a
 * balance push API worth the connection cost, so all three chains poll; the
 * lifecycle (`subscribe/start/stop/refresh/latest/status`) matches the
 * order-book and quote-surface feeds. A failed poll keeps `latest`, reports
 * `reconnecting`, and backs off until the next success.
 */
export class PollingBalancesFeed implements BalancesFeed {
  readonly request: BalancesRequest;

  #fetcher: BalancesFetcher;
  #options: BalancesFeedOptions;
  #fetch: typeof fetch;
  #webSocket: typeof WebSocket | undefined;

  #listeners = new Set<(event: BalancesEvent) => void>();
  #latest: BalancesSnapshot | null = null;
  #status: FeedStatus = 'idle';
  #started = false;
  #generation = 0;
  #backoffMs = BACKOFF_INITIAL_MS;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #controller: AbortController | null = null;

  constructor(fetcher: BalancesFetcher, request: BalancesRequest, options: BalancesFeedOptions = {}) {
    this.request = request;
    this.#fetcher = fetcher;
    this.#options = options;
    this.#fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.#webSocket = options.webSocket ?? globalThis.WebSocket;
  }

  get latest(): BalancesSnapshot | null {
    return this.#latest;
  }

  get status(): FeedStatus {
    return this.#status;
  }

  subscribe(cb: (event: BalancesEvent) => void): () => void {
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
    void this.#pollOnce(generation);
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    this.#generation += 1;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    // Abort the in-flight fetch so ephemeral transports (XRPL WS) close now.
    this.#controller?.abort();
    this.#controller = null;
    this.#setStatus('idle');
  }

  async refresh(): Promise<BalancesSnapshot> {
    const snapshot = await this.#fetchOnce(AbortSignal.timeout(FETCH_TIMEOUT_MS));
    this.#latest = snapshot;
    this.#emit({ type: 'balances', balances: snapshot });
    return snapshot;
  }

  async #pollOnce(generation: number): Promise<void> {
    let delay: number;
    const controller = new AbortController();
    this.#controller = controller;
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const snapshot = await this.#fetchOnce(controller.signal);
      if (!this.#started || generation !== this.#generation) return;
      this.#latest = snapshot;
      this.#backoffMs = BACKOFF_INITIAL_MS;
      this.#setStatus('live');
      this.#emit({ type: 'balances', balances: snapshot });
      delay = this.#options.intervalMs ?? DEFAULT_INTERVAL_MS;
    } catch (err) {
      if (!this.#started || generation !== this.#generation) return;
      this.#emit({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
      this.#setStatus('reconnecting');
      delay = this.#backoffMs;
      this.#backoffMs = Math.min(this.#backoffMs * 2, BACKOFF_MAX_MS);
    } finally {
      clearTimeout(timeout);
      if (this.#controller === controller) this.#controller = null;
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#started && generation === this.#generation) void this.#pollOnce(generation);
    }, delay);
  }

  #fetchOnce(signal: AbortSignal): Promise<BalancesSnapshot> {
    return this.#fetcher(this.request, {
      httpEndpoint: this.#options.httpEndpoint,
      streamEndpoint: this.#options.streamEndpoint,
      fetch: this.#fetch,
      webSocket: this.#webSocket,
      signal,
    });
  }

  #setStatus(status: FeedStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#emit({ type: 'status', status });
  }

  #emit(event: BalancesEvent): void {
    for (const cb of [...this.#listeners]) {
      try {
        cb(event);
      } catch {
        // A throwing listener must not break the feed or other listeners.
      }
    }
  }
}
