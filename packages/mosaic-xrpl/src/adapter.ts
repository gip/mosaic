import {
  cmpDecimals,
  divDecimals,
  dropsToXrp,
  isZeroDecimal,
  mulDecimals,
  xrpToDrops,
} from '@mosaic/chain-core';
import type {
  AdapterFetchOptions,
  AdapterStreamEvent,
  AdapterStreamOptions,
  AdapterSurfaceEvent,
  AdapterSurfaceOptions,
  Asset,
  DexAdapter,
  Network,
  OrderBookLevel,
  OrderBookRequest,
  OrderBookSnapshot,
  QuoteSample,
  QuoteSurface,
  StreamHandle,
} from '@mosaic/chain-core';

export const XRPL_HTTP_ENDPOINTS: Record<Network, string> = {
  mainnet: 'https://xrplcluster.com',
  testnet: 'https://s.altnet.rippletest.net:51234',
};

export const XRPL_WS_ENDPOINTS: Record<Network, string> = {
  mainnet: 'wss://xrplcluster.com',
  testnet: 'wss://s.altnet.rippletest.net:51233',
};

const REFETCH_DEBOUNCE_MS = 300;
// xrplcluster.com takes ~15s to answer the first path_find on a connection.
const PATHFIND_SAMPLE_TIMEOUT_MS = 20_000;

type XrplAmountSpec = { currency: 'XRP' } | { currency: string; issuer: string };

type XrplAmount = string | { currency: string; issuer?: string; value: string };

interface XrplOffer {
  TakerGets: XrplAmount;
  TakerPays: XrplAmount;
  taker_gets_funded?: XrplAmount;
  taker_pays_funded?: XrplAmount;
}

/**
 * XRPL currency codes are either 3 printable-ASCII characters (but never the
 * literal 'XRP') or 40 hex chars; anything else is ASCII-encoded into the
 * 160-bit hex form, zero-padded.
 */
export function normalizeCurrency(code: string): string {
  if (/^[0-9A-Fa-f]{40}$/.test(code)) return code.toUpperCase();
  if (code.toUpperCase() === 'XRP') {
    throw new Error("issued assets cannot use the currency code 'XRP'");
  }
  if (/^[!-~]{3}$/.test(code)) return code;
  const bytes = new TextEncoder().encode(code);
  if (bytes.length === 0 || bytes.length > 20) {
    throw new Error(`invalid XRPL currency code: ${JSON.stringify(code)}`);
  }
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex.toUpperCase().padEnd(40, '0');
}

export function toXrplAmountSpec(asset: Asset): XrplAmountSpec {
  if (asset.kind === 'native') return { currency: 'XRP' };
  return { currency: normalizeCurrency(asset.currencyCode ?? asset.code), issuer: asset.issuer };
}

function amountValue(amount: XrplAmount): string {
  return typeof amount === 'string' ? dropsToXrp(amount) : amount.value;
}

function matchesSpec(amount: XrplAmount, spec: XrplAmountSpec): boolean {
  if (typeof amount === 'string') return spec.currency === 'XRP';
  return (
    'issuer' in spec && amount.currency === spec.currency && amount.issuer === spec.issuer
  );
}

/**
 * Turn one offer into a level, oriented by which side of the pair the offer
 * is giving away. Uses funded amounts when rippled provides them. Returns
 * null for offers that are empty or belong to neither book side.
 */
function offerToLevel(
  offer: XrplOffer,
  base: XrplAmountSpec,
  quote: XrplAmountSpec,
): { side: 'ask' | 'bid'; level: OrderBookLevel } | null {
  const originalGetsValue = amountValue(offer.TakerGets);
  const originalPaysValue = amountValue(offer.TakerPays);
  const fundedGetsValue = amountValue(offer.taker_gets_funded ?? offer.TakerGets);
  const fundedPaysValue = amountValue(offer.taker_pays_funded ?? offer.TakerPays);
  if (isZeroDecimal(fundedGetsValue) || isZeroDecimal(fundedPaysValue)) return null;
  if (matchesSpec(offer.TakerGets, base) && matchesSpec(offer.TakerPays, quote)) {
    // Price always comes from the original offer ratio. Funded amounts are
    // independently rounded and can wildly distort the ratio for dust offers.
    return {
      side: 'ask',
      level: { price: divDecimals(originalPaysValue, originalGetsValue), amount: fundedGetsValue },
    };
  }
  if (matchesSpec(offer.TakerGets, quote) && matchesSpec(offer.TakerPays, base)) {
    return {
      side: 'bid',
      level: { price: divDecimals(originalGetsValue, originalPaysValue), amount: fundedPaysValue },
    };
  }
  return null;
}

function buildSnapshot(
  offers: XrplOffer[],
  req: OrderBookRequest,
  base: XrplAmountSpec,
  quote: XrplAmountSpec,
  depth: number,
): OrderBookSnapshot {
  const asks: OrderBookLevel[] = [];
  const bids: OrderBookLevel[] = [];
  for (const offer of offers) {
    const entry = offerToLevel(offer, base, quote);
    if (entry === null) continue;
    (entry.side === 'ask' ? asks : bids).push(entry.level);
  }
  asks.sort((a, b) => cmpDecimals(a.price, b.price));
  bids.sort((a, b) => cmpDecimals(b.price, a.price));
  return {
    chain: req.chain,
    network: req.network,
    base: req.base,
    quote: req.quote,
    asks: asks.slice(0, depth),
    bids: bids.slice(0, depth),
    timestamp: Date.now(),
  };
}

/** An amount spec with a value attached: drops string for XRP, IOU object otherwise. */
function amountWithValue(spec: XrplAmountSpec, value: string): XrplAmount {
  return 'issuer' in spec ? { ...spec, value } : xrpToDrops(value);
}

/** Reject accountless or whitespace-only XRPL pathfinding requests early. */
function fundedPathfindAccounts(req: OrderBookRequest): { base: string; quote: string } {
  const base = req.fundedAccounts?.base?.trim();
  const quote = req.fundedAccounts?.quote?.trim();
  if (!base || !quote) {
    throw new Error('XRPL pathfinding requires a funded account for both the base and quote assets');
  }
  if (req.base.kind === 'issued' && base === req.base.issuer) {
    throw new Error('XRPL pathfinding base funded account must not be the asset issuer');
  }
  if (req.quote.kind === 'issued' && quote === req.quote.issuer) {
    throw new Error('XRPL pathfinding quote funded account must not be the asset issuer');
  }
  return { base, quote };
}

interface PathAlternative {
  source_amount: XrplAmount;
}

/** Cheapest alternative's source amount, normalized to a decimal string. */
function bestSourceAmount(alternatives: PathAlternative[]): string | null {
  let best: string | null = null;
  for (const alt of alternatives) {
    if (alt?.source_amount === undefined) continue;
    const value = amountValue(alt.source_amount);
    if (best === null || cmpDecimals(value, best) < 0) best = value;
  }
  return best;
}

export interface XrplRpcResult {
  status?: string;
  error?: string;
  error_message?: string;
  ledger_index?: number;
  offers?: XrplOffer[];
  asks?: XrplOffer[];
  bids?: XrplOffer[];
  /** Command-specific payload fields (account_data, lines, …). */
  [key: string]: unknown;
}

function assertRpcSuccess(result: XrplRpcResult | undefined): XrplRpcResult {
  if (!result || result.status !== 'success') {
    const detail = result?.error_message ?? result?.error ?? 'unknown error';
    throw new Error(`XRPL request failed: ${detail}`);
  }
  return result;
}

/** Per-request outcome of a settled WS batch: a result or the rippled error code. */
export interface XrplBatchOutcome {
  result?: XrplRpcResult;
  error?: string;
}

/**
 * Fire a batch of commands over an ephemeral WebSocket and resolve with
 * id-ordered per-request outcomes once every request has been answered.
 * Used for one-shot fetches: browsers cannot reach most XRPL JSON-RPC
 * endpoints (no CORS headers), while the WS endpoints work everywhere.
 * Per-request errors (e.g. `actNotFound`) are outcomes, not rejections;
 * only transport failures reject.
 */
export function wsRequestBatchSettled(
  webSocket: typeof WebSocket,
  url: string,
  requests: Record<string, unknown>[],
  signal: AbortSignal | undefined,
): Promise<XrplBatchOutcome[]> {
  if (requests.length === 0) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const ws = new webSocket(url);
    const outcomes: XrplBatchOutcome[] = new Array(requests.length) as XrplBatchOutcome[];
    let remaining = requests.length;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      fn();
    };
    signal?.addEventListener('abort', () => finish(() => reject(new Error('XRPL request timed out'))));
    ws.onopen = () => {
      requests.forEach((request, i) => ws.send(JSON.stringify({ id: i + 1, ...request })));
    };
    ws.onmessage = (event: MessageEvent) => {
      let msg: { id?: number; status?: string; error?: string; error_message?: string; result?: XrplRpcResult };
      try {
        msg = JSON.parse(String(event.data)) as typeof msg;
      } catch {
        return;
      }
      if (typeof msg.id !== 'number' || msg.id < 1 || msg.id > requests.length) return;
      if (outcomes[msg.id - 1] !== undefined) return;
      outcomes[msg.id - 1] =
        msg.status === 'success' && msg.result
          ? { result: { ...msg.result, status: 'success' } }
          : { error: msg.error ?? msg.error_message ?? 'unknown error' };
      if (--remaining === 0) finish(() => resolve(outcomes));
    };
    ws.onerror = () => finish(() => reject(new Error('XRPL WebSocket error')));
    ws.onclose = () => finish(() => reject(new Error('XRPL WebSocket closed')));
  });
}

/** Strict batch: any per-request error rejects the whole batch. */
async function wsRequestBatch(
  webSocket: typeof WebSocket,
  url: string,
  requests: Record<string, unknown>[],
  signal: AbortSignal | undefined,
): Promise<XrplRpcResult[]> {
  const outcomes = await wsRequestBatchSettled(webSocket, url, requests, signal);
  return outcomes.map((outcome) => {
    if (!outcome.result) throw new Error(`XRPL request failed: ${outcome.error ?? 'unknown error'}`);
    return outcome.result;
  });
}

export function createAdapter(): DexAdapter {
  return {
    async fetchOrderBook(req: OrderBookRequest, opts: AdapterFetchOptions): Promise<OrderBookSnapshot> {
      const base = toXrplAmountSpec(req.base);
      const quote = toXrplAmountSpec(req.quote);
      const bookParams = (takerGets: XrplAmountSpec, takerPays: XrplAmountSpec) => ({
        taker_gets: takerGets,
        taker_pays: takerPays,
        limit: opts.depth,
        ledger_index: 'validated',
      });

      // Sellers of base and sellers of quote live in two opposite books.
      let askOffers: XrplOffer[];
      let bidOffers: XrplOffer[];
      if (opts.httpEndpoint) {
        // Explicit JSON-RPC endpoint (Node-side use; browsers hit CORS here).
        const bookOffers = async (params: Record<string, unknown>) => {
          const res = await opts.fetch(opts.httpEndpoint!, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ method: 'book_offers', params: [params] }),
            signal: opts.signal,
          });
          if (!res.ok) throw new Error(`XRPL JSON-RPC responded ${res.status}`);
          const json = (await res.json()) as { result?: XrplRpcResult };
          return assertRpcSuccess(json.result).offers ?? [];
        };
        [askOffers, bidOffers] = await Promise.all([
          bookOffers(bookParams(base, quote)),
          bookOffers(bookParams(quote, base)),
        ]);
      } else {
        const url = opts.streamEndpoint ?? XRPL_WS_ENDPOINTS[req.network];
        const webSocket = opts.webSocket ?? globalThis.WebSocket;
        const [askSide, bidSide] = await wsRequestBatch(
          webSocket,
          url,
          [
            { command: 'book_offers', ...bookParams(base, quote) },
            { command: 'book_offers', ...bookParams(quote, base) },
          ],
          opts.signal,
        );
        askOffers = askSide.offers ?? [];
        bidOffers = bidSide.offers ?? [];
      }
      return buildSnapshot([...askOffers, ...bidOffers], req, base, quote, opts.depth);
    },

    /** One-shot surface: a single streaming cycle over an ephemeral socket. */
    fetchQuoteSurface(req: OrderBookRequest, opts: AdapterSurfaceOptions): Promise<QuoteSurface> {
      return new Promise((resolve, reject) => {
        let settled = false;
        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          handle.close();
          fn();
        };
        const handle = this.openSurfaceStream!(req, opts, (event) => {
          if (event.type === 'surface') settle(() => resolve(event.surface));
          else if (event.type === 'error') settle(() => reject(event.error));
          else settle(() => reject(new Error('XRPL pathfinding closed before producing a surface')));
        });
        opts.signal?.addEventListener('abort', () =>
          settle(() => reject(new Error('XRPL pathfinding timed out'))),
        );
      });
    },

    /**
     * Streaming quote surface via the WebSocket `path_find` API. A connection
     * carries one pathfinding request at a time, so the ladder is cycled
     * (create → first reply with alternatives → next); a `ledger` stream
     * subscription re-runs the cycle each ledger close. Samples settle on the
     * first reply carrying alternatives rather than on `full_reply` — some
     * servers (xrplcluster) answer the create with alternatives after ~15s
     * and never send a full reply or async updates. Both sides use the
     * exact-receive form — `send_max` + `-1` returns no alternatives on
     * current rippled — so the sell side ladders the quote asset via
     * `referencePrice` and reads the base amount back from the result.
     *
     * XRPL pathfinding models an actual Payment, not a generic market query.
     * The caller therefore supplies a real account funded in each pair asset:
     * quote-funded source → base account for buys, and base-funded source →
     * quote account for sells. Issuers are deliberately not used as synthetic
     * sources because their mint/redeem privileges distort the route.
     *
     * Note: most public mainnet servers disable pathfinding (`noPermission`);
     * the testnet server allows it. Point `streamEndpoint` at your own
     * rippled for mainnet surfaces.
     */
    openSurfaceStream(
      req: OrderBookRequest,
      opts: AdapterSurfaceOptions,
      emit: (event: AdapterSurfaceEvent) => void,
    ): StreamHandle {
      // All of these throw synchronously on invalid pairs.
      const base = toXrplAmountSpec(req.base);
      const quote = toXrplAmountSpec(req.quote);
      const fundedAccounts = fundedPathfindAccounts(req);

      const url = opts.streamEndpoint ?? XRPL_WS_ENDPOINTS[req.network];
      const ws = new opts.webSocket(url);
      let closed = false;
      let nextId = 1;
      const waiters = new Map<
        number,
        { resolve: (r: { alternatives: PathAlternative[] | null; error?: Error }) => void; timer: ReturnType<typeof setTimeout> }
      >();
      const rpcWaiters = new Map<
        number,
        { resolve: (r: XrplRpcResult) => void; reject: (e: Error) => void }
      >();
      let accounts: {
        buy: { source_account: string; destination_account: string };
        sell: { source_account: string; destination_account: string };
      } | null = null;
      let cycleRunning = false;
      let dirty = false;

      const rpcRequest = (command: string, params: Record<string, unknown>): Promise<XrplRpcResult> =>
        new Promise((resolve, reject) => {
          const id = nextId++;
          rpcWaiters.set(id, { resolve, reject });
          ws.send(JSON.stringify({ id, command, ...params }));
        });

      const settleWaiter = (id: number, r: { alternatives: PathAlternative[] | null; error?: Error }) => {
        const waiter = waiters.get(id);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        waiters.delete(id);
        waiter.resolve(r);
      };

      const pathFindCreate = (
        fields: Record<string, unknown>,
      ): Promise<{ alternatives: PathAlternative[] | null; error?: Error }> =>
        new Promise((resolve) => {
          const id = nextId++;
          const timer = setTimeout(() => {
            waiters.delete(id);
            resolve({ alternatives: null, error: new Error('path_find timed out') });
          }, PATHFIND_SAMPLE_TIMEOUT_MS);
          waiters.set(id, { resolve, timer });
          ws.send(JSON.stringify({ id, command: 'path_find', subcommand: 'create', ...fields }));
        });

      const runCycle = async () => {
        cycleRunning = true;
        try {
          const buy: QuoteSample[] = [];
          const sell: QuoteSample[] = [];
          let firstError: Error | undefined;

          for (const [index, size] of opts.sizes.entries()) {
            if (closed) return;
            // Buy: receive `size` base, pay as little quote as possible.
            const buyRes = await pathFindCreate({
              ...accounts!.buy,
              destination_amount: amountWithValue(base, size),
              source_currencies: [quote],
            });
            if (closed) return;
            if (buyRes.error) firstError ??= buyRes.error;
            const buyTotal = buyRes.alternatives && bestSourceAmount(buyRes.alternatives);
            if (buyTotal) {
              buy.push(withQuoteAmount({ amount: size, total: buyTotal, avgPrice: divDecimals(buyTotal, size) }, opts.quoteAmounts?.[index]));
            }

            // Sell: receive `size × referencePrice` quote, pay as little base
            // as possible; the base actually paid is the sample's amount.
            const quoteTarget = opts.quoteAmounts?.[index] ?? mulDecimals(size, opts.referencePrice, 6);
            if (isZeroDecimal(quoteTarget)) continue;
            const sellRes = await pathFindCreate({
              ...accounts!.sell,
              destination_amount: amountWithValue(quote, quoteTarget),
              source_currencies: [base],
            });
            if (closed) return;
            if (sellRes.error) firstError ??= sellRes.error;
            const basePaid = sellRes.alternatives && bestSourceAmount(sellRes.alternatives);
            if (basePaid && !isZeroDecimal(basePaid)) {
              sell.push(
                withQuoteAmount(
                  { amount: basePaid, total: quoteTarget, avgPrice: divDecimals(quoteTarget, basePaid) },
                  opts.quoteAmounts?.[index],
                ),
              );
            }
          }

          // Stop server-side pathfinding until the next ledger re-cycle.
          ws.send(JSON.stringify({ id: nextId++, command: 'path_find', subcommand: 'close' }));

          if (buy.length === 0 && sell.length === 0 && firstError) {
            emit({ type: 'error', error: firstError });
            return;
          }
          sell.sort((a, b) => cmpDecimals(a.amount, b.amount));
          emit({
            type: 'surface',
            surface: {
              chain: req.chain,
              network: req.network,
              base: req.base,
              quote: req.quote,
              sell,
              buy,
              timestamp: Date.now(),
            },
          });
        } catch (err) {
          if (!closed) emit({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
        } finally {
          cycleRunning = false;
          if (dirty && !closed) {
            dirty = false;
            void runCycle();
          }
        }
      };

      const scheduleCycle = () => {
        if (closed || accounts === null) return;
        if (cycleRunning) {
          dirty = true;
          return;
        }
        void runCycle();
      };

      ws.onopen = () => {
        void (async () => {
          await rpcRequest('subscribe', { streams: ['ledger'] });
          accounts = {
            buy: {
              source_account: fundedAccounts.quote,
              destination_account: fundedAccounts.base,
            },
            sell: {
              source_account: fundedAccounts.base,
              destination_account: fundedAccounts.quote,
            },
          };
          void runCycle();
        })().catch((err: unknown) => {
          if (!closed) emit({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
        });
      };

      ws.onmessage = (event: MessageEvent) => {
        let msg: {
          id?: number;
          type?: string;
          status?: string;
          error?: string;
          error_message?: string;
          full_reply?: boolean;
          alternatives?: PathAlternative[];
          result?: XrplRpcResult & { full_reply?: boolean; alternatives?: PathAlternative[] };
        };
        try {
          msg = JSON.parse(String(event.data)) as typeof msg;
        } catch {
          return;
        }
        if (msg.type === 'response' && typeof msg.id === 'number' && rpcWaiters.has(msg.id)) {
          const rpc = rpcWaiters.get(msg.id)!;
          rpcWaiters.delete(msg.id);
          if (msg.status === 'success' && msg.result) rpc.resolve(msg.result);
          else rpc.reject(new Error(`XRPL request failed: ${msg.error_message ?? msg.error ?? 'unknown error'}`));
          return;
        }
        if (msg.type === 'response' && typeof msg.id === 'number' && waiters.has(msg.id)) {
          if (msg.status !== 'success') {
            settleWaiter(msg.id, {
              alternatives: null,
              error: new Error(`XRPL path_find failed: ${msg.error_message ?? msg.error ?? 'unknown error'}`),
            });
          } else if ((msg.result?.alternatives?.length ?? 0) > 0 || msg.result?.full_reply) {
            // Take the first reply that carries alternatives: xrplcluster
            // never sends the full reply, only this initial response.
            settleWaiter(msg.id, { alternatives: msg.result?.alternatives ?? [] });
          }
          // Empty partial reply: wait for an asynchronous `path_find` update
          // (or the sample timeout) to decide there is no route.
          return;
        }
        if (msg.type === 'path_find' && typeof msg.id === 'number') {
          if ((msg.alternatives?.length ?? 0) > 0 || msg.full_reply) {
            settleWaiter(msg.id, { alternatives: msg.alternatives ?? [] });
          }
          return;
        }
        if (msg.type === 'ledgerClosed') scheduleCycle();
      };

      ws.onerror = () => {
        if (!closed) emit({ type: 'error', error: new Error('XRPL WebSocket error') });
      };

      ws.onclose = () => {
        for (const id of [...waiters.keys()]) {
          settleWaiter(id, { alternatives: null, error: new Error('XRPL WebSocket closed') });
        }
        for (const rpc of rpcWaiters.values()) rpc.reject(new Error('XRPL WebSocket closed'));
        rpcWaiters.clear();
        if (!closed) emit({ type: 'closed' });
      };

      return {
        close() {
          closed = true;
          for (const id of [...waiters.keys()]) settleWaiter(id, { alternatives: null });
          for (const rpc of rpcWaiters.values()) rpc.reject(new Error('closed'));
          rpcWaiters.clear();
          ws.close();
        },
      };
    },

    openStream(
      req: OrderBookRequest,
      opts: AdapterStreamOptions,
      emit: (event: AdapterStreamEvent) => void,
    ): StreamHandle {
      // Throws synchronously on invalid asset specs (deterministic failure).
      const base = toXrplAmountSpec(req.base);
      const quote = toXrplAmountSpec(req.quote);
      const url = opts.streamEndpoint ?? XRPL_WS_ENDPOINTS[req.network];

      const ws = new opts.webSocket(url);
      let closed = false;
      let nextId = 1;
      const pending = new Map<number, { resolve: (r: XrplRpcResult) => void; reject: (e: Error) => void }>();
      let refetchTimer: ReturnType<typeof setTimeout> | null = null;
      let fetching = false;
      let dirty = false;

      const request = (command: string, params: Record<string, unknown>): Promise<XrplRpcResult> =>
        new Promise((resolve, reject) => {
          const id = nextId++;
          pending.set(id, { resolve, reject });
          ws.send(JSON.stringify({ id, command, ...params }));
        });

      const fail = (err: unknown) => {
        if (closed) return;
        emit({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
      };

      const fetchBook = async () => {
        // Pin both halves to one validated ledger. Apart from preventing a
        // ledger-close race, book_offers supplies funded amounts and omits
        // fully unfunded offers that can still appear in subscription data.
        const askSide = await request('book_offers', {
          taker_gets: base,
          taker_pays: quote,
          limit: opts.depth,
          ledger_index: 'validated',
        });
        const bidSide = await request('book_offers', {
          taker_gets: quote,
          taker_pays: base,
          limit: opts.depth,
          ledger_index: askSide.ledger_index ?? 'validated',
        });
        const offers = [...(askSide.offers ?? []), ...(bidSide.offers ?? [])];
        if (!closed) {
          emit({ type: 'snapshot', snapshot: buildSnapshot(offers, req, base, quote, opts.depth) });
        }
      };

      // Transaction events are only a change signal: coalesce bursts (several
      // per ledger) into one debounced refetch, with a trailing run when more
      // arrive mid-fetch.
      const scheduleRefetch = () => {
        if (closed) return;
        if (fetching) {
          dirty = true;
          return;
        }
        if (refetchTimer !== null) return;
        refetchTimer = setTimeout(() => {
          refetchTimer = null;
          if (closed) return;
          fetching = true;
          fetchBook()
            .catch(fail)
            .finally(() => {
              fetching = false;
              if (dirty) {
                dirty = false;
                scheduleRefetch();
              }
            });
        }, REFETCH_DEBOUNCE_MS);
      };

      ws.onopen = () => {
        request('subscribe', {
          books: [{ taker_gets: base, taker_pays: quote, both: true }],
        })
          // Subscription book data is only a change signal. Always source the
          // displayed snapshot from book_offers so funding is authoritative.
          .then(fetchBook)
          .catch(fail);
      };

      ws.onmessage = (event: MessageEvent) => {
        let msg: { id?: number; type?: string; status?: string; result?: XrplRpcResult; error?: string; error_message?: string };
        try {
          msg = JSON.parse(String(event.data)) as typeof msg;
        } catch {
          return;
        }
        if (typeof msg.id === 'number' && pending.has(msg.id)) {
          const entry = pending.get(msg.id)!;
          pending.delete(msg.id);
          if (msg.status === 'success' && msg.result) {
            entry.resolve({ ...msg.result, status: 'success' });
          } else {
            entry.reject(new Error(`XRPL request failed: ${msg.error_message ?? msg.error ?? 'unknown error'}`));
          }
          return;
        }
        if (msg.type === 'transaction') scheduleRefetch();
      };

      ws.onerror = () => {
        fail(new Error('XRPL WebSocket error'));
      };

      ws.onclose = () => {
        for (const entry of pending.values()) entry.reject(new Error('XRPL WebSocket closed'));
        pending.clear();
        if (!closed) emit({ type: 'closed' });
      };

      return {
        close() {
          closed = true;
          if (refetchTimer !== null) {
            clearTimeout(refetchTimer);
            refetchTimer = null;
          }
          ws.close();
        },
      };
    },
  };
}

function withQuoteAmount(sample: QuoteSample, quoteAmount: string | undefined): QuoteSample {
  return quoteAmount === undefined ? sample : { ...sample, quoteAmount };
}
