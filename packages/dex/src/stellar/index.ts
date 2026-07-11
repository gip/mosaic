import { cmpDecimals, divDecimals, mulRatio } from '../decimal.js';
import { readSseStream } from '../sse.js';
import type {
  AdapterFetchOptions,
  AdapterStreamEvent,
  AdapterStreamOptions,
  AdapterSurfaceOptions,
  Asset,
  DexAdapter,
  Network,
  OrderBookRequest,
  OrderBookSnapshot,
  QuoteSample,
  QuoteSurface,
  StreamHandle,
} from '../types.js';

export const HORIZON_ENDPOINTS: Record<Network, string> = {
  mainnet: 'https://horizon.stellar.org',
  testnet: 'https://horizon-testnet.stellar.org',
};

interface HorizonLevel {
  price_r: { n: number; d: number };
  price: string;
  amount: string;
}

interface HorizonBook {
  bids: HorizonLevel[];
  asks: HorizonLevel[];
}

function assetParams(side: 'selling' | 'buying' | 'source' | 'destination', asset: Asset): [string, string][] {
  if (asset.kind === 'native') return [[`${side}_asset_type`, 'native']];
  if (!/^[A-Za-z0-9]{1,12}$/.test(asset.code)) {
    throw new Error(`invalid Stellar asset code: ${JSON.stringify(asset.code)}`);
  }
  const type = asset.code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12';
  return [
    [`${side}_asset_type`, type],
    [`${side}_asset_code`, asset.code],
    [`${side}_asset_issuer`, asset.issuer],
  ];
}

function orderBookUrl(req: OrderBookRequest, depth: number, endpoint: string | undefined): string {
  const base = (endpoint ?? HORIZON_ENDPOINTS[req.network]).replace(/\/$/, '');
  const params = new URLSearchParams([
    ...assetParams('selling', req.base),
    ...assetParams('buying', req.quote),
    ['limit', String(depth)],
  ]);
  return `${base}/order_book?${params.toString()}`;
}

/**
 * Horizon's `price` is quote-per-base on both sides, but ask `amount` is in
 * base units while bid `amount` is in quote (counter) units. Bid base amount
 * is recovered exactly via the rational price: amount × d / n.
 */
function normalizeBook(book: HorizonBook, req: OrderBookRequest): OrderBookSnapshot {
  return {
    chain: req.chain,
    network: req.network,
    base: req.base,
    quote: req.quote,
    asks: book.asks.map((l) => ({ price: l.price, amount: l.amount })),
    bids: book.bids.map((l) => ({
      price: l.price,
      amount: mulRatio(l.amount, BigInt(l.price_r.d), BigInt(l.price_r.n)),
    })),
    timestamp: Date.now(),
  };
}

/** Asset-list form used by the path endpoints' plural parameters. */
function assetListSpec(asset: Asset): string {
  return asset.kind === 'native' ? 'native' : `${asset.code}:${asset.issuer}`;
}

interface HorizonPathRecord {
  source_amount: string;
  destination_amount: string;
}

function isHorizonBook(value: unknown): value is HorizonBook {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as HorizonBook).bids) &&
    Array.isArray((value as HorizonBook).asks)
  );
}

function pickBest(
  records: HorizonPathRecord[],
  field: 'source_amount' | 'destination_amount',
  direction: 'min' | 'max',
): HorizonPathRecord | null {
  let best: HorizonPathRecord | null = null;
  for (const record of records) {
    if (!record?.[field]) continue;
    if (
      best === null ||
      (direction === 'max'
        ? cmpDecimals(record[field], best[field]) > 0
        : cmpDecimals(record[field], best[field]) < 0)
    ) {
      best = record;
    }
  }
  return best;
}

export function createAdapter(): DexAdapter {
  return {
    async fetchOrderBook(req: OrderBookRequest, opts: AdapterFetchOptions): Promise<OrderBookSnapshot> {
      const res = await opts.fetch(orderBookUrl(req, opts.depth, opts.httpEndpoint), {
        headers: { accept: 'application/json' },
        signal: opts.signal,
      });
      if (!res.ok) throw new Error(`Horizon responded ${res.status}`);
      const book: unknown = await res.json();
      if (!isHorizonBook(book)) throw new Error('Horizon order_book: unexpected response shape');
      return normalizeBook(book, req);
    },

    /**
     * Executable quote surface via Horizon pathfinding (order books + AMM
     * pools, multi-hop). Horizon has no streaming form of these endpoints,
     * so there is no openSurfaceStream — the surface feed polls this.
     */
    async fetchQuoteSurface(req: OrderBookRequest, opts: AdapterSurfaceOptions): Promise<QuoteSurface> {
      const endpoint = (opts.httpEndpoint ?? HORIZON_ENDPOINTS[req.network]).replace(/\/$/, '');
      const quoteList = assetListSpec(req.quote);

      const fetchPaths = async (path: string, params: [string, string][]) => {
        const url = `${endpoint}/paths/${path}?${new URLSearchParams(params).toString()}`;
        const res = await opts.fetch(url, { headers: { accept: 'application/json' }, signal: opts.signal });
        if (!res.ok) throw new Error(`Horizon responded ${res.status}`);
        const body = (await res.json()) as { _embedded?: { records?: HorizonPathRecord[] } };
        return body._embedded?.records ?? [];
      };

      const samples = await Promise.all(
        opts.sizes.map(async (size, index) => {
          const [sellRecords, buyRecords] = await Promise.all([
            // Sell: send exactly `size` base, receive as much quote as possible.
            fetchPaths('strict-send', [
              ...assetParams('source', req.base),
              ['source_amount', size],
              ['destination_assets', quoteList],
            ]),
            // Buy: receive exactly `size` base, pay as little quote as possible.
            fetchPaths('strict-receive', [
              ...assetParams('destination', req.base),
              ['destination_amount', size],
              ['source_assets', quoteList],
            ]),
          ]);
          const bestSell = pickBest(sellRecords, 'destination_amount', 'max');
          const bestBuy = pickBest(buyRecords, 'source_amount', 'min');
          return {
            sell:
              bestSell &&
              withQuoteAmount(
                {
                  amount: size,
                  total: bestSell.destination_amount,
                  avgPrice: divDecimals(bestSell.destination_amount, size),
                },
                opts.quoteAmounts?.[index],
              ),
            buy:
              bestBuy &&
              withQuoteAmount(
                {
                  amount: size,
                  total: bestBuy.source_amount,
                  avgPrice: divDecimals(bestBuy.source_amount, size),
                },
                opts.quoteAmounts?.[index],
              ),
          };
        }),
      );

      return {
        chain: req.chain,
        network: req.network,
        base: req.base,
        quote: req.quote,
        sell: samples.map((s) => s.sell).filter((s): s is QuoteSample => Boolean(s)),
        buy: samples.map((s) => s.buy).filter((s): s is QuoteSample => Boolean(s)),
        timestamp: Date.now(),
      };
    },

    openStream(
      req: OrderBookRequest,
      opts: AdapterStreamOptions,
      emit: (event: AdapterStreamEvent) => void,
    ): StreamHandle {
      const url = `${orderBookUrl(req, opts.depth, opts.streamEndpoint)}&cursor=now`;
      const controller = new AbortController();

      void (async () => {
        const res = await opts.fetch(url, {
          headers: { accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`Horizon responded ${res.status}`);
        await readSseStream(res.body, (message) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(message.data);
          } catch {
            return;
          }
          // Skips Horizon's "hello"/"byebye" string frames.
          if (!isHorizonBook(parsed)) return;
          emit({ type: 'snapshot', snapshot: normalizeBook(parsed, req) });
        });
        // Horizon recycles long-lived SSE connections; let the feed reopen.
        if (!controller.signal.aborted) emit({ type: 'closed' });
      })().catch((err: unknown) => {
        if (controller.signal.aborted) return;
        emit({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
        emit({ type: 'closed' });
      });

      return {
        close() {
          controller.abort();
        },
      };
    },
  };
}

function withQuoteAmount(sample: QuoteSample, quoteAmount: string | undefined): QuoteSample {
  return quoteAmount === undefined ? sample : { ...sample, quoteAmount };
}
