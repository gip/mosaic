import { useState } from 'react';
import { X } from 'lucide-react';
import type { OrderBookLevel, OrderBookSnapshot, QuoteSample, QuoteSurface } from '@mosaic/dex';
import type { UTCTimestamp } from 'lightweight-charts';
import Banner from '../ui/Banner';
import Button from '../ui/Button';
import StatusDot, { type StatusTone } from '../ui/StatusDot';
import BookChart, { type PricePoint } from './charts';
import {
  CHART_KIND_SOURCE,
  assetLabel,
  pairLabel,
  type ChartKind,
  type PairConfig,
  type PairSources,
} from './types';
import { isUnsupportedChain, useOrderBookFeed } from './useOrderBookFeed';
import { useQuoteSurfaceFeed } from './useQuoteSurfaceFeed';

const CHAIN_LABELS = { evm: 'EVM', xrpl: 'XRPL', stellar: 'Stellar' } as const;
const CHART_KINDS: { id: ChartKind; label: string }[] = [
  { id: 'depth', label: 'Depth' },
  { id: 'mid', label: 'Mid price' },
  { id: 'spread', label: 'Spread' },
  { id: 'quotes', label: 'Quotes' },
];
const SOURCE_LABELS: { id: keyof PairSources; label: string }[] = [
  { id: 'clob', label: 'Book' },
  { id: 'paths', label: 'Paths' },
];
const HISTORY_MAX = 600;
const QUOTE_AMOUNTS = ['1', '10', '100', '1000', '10000', '100000'];

const STATUS_TONES: Record<string, StatusTone> = {
  live: 'ok',
  connecting: 'busy',
  reconnecting: 'warn',
  idle: 'idle',
};

function fmt(value: string | number, digits = 7): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (n === 0) return '0';
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return String(Number(n.toPrecision(digits)));
}

function bookAveragePrice(levels: OrderBookLevel[], baseAmount: number): number | null {
  if (!Number.isFinite(baseAmount) || baseAmount <= 0) return null;
  let remainingBase = baseAmount;
  let quoteTotal = 0;
  for (const level of levels) {
    const price = Number(level.price);
    const availableBase = Number(level.amount);
    if (!Number.isFinite(price) || !Number.isFinite(availableBase) || price <= 0 || availableBase <= 0) continue;
    const baseHere = Math.min(remainingBase, availableBase);
    quoteTotal += baseHere * price;
    remainingBase -= baseHere;
    if (remainingBase <= Math.max(baseAmount, 1) * 1e-12) break;
  }
  if (remainingBase > Math.max(baseAmount, 1) * 1e-12) return null;
  return quoteTotal / baseAmount;
}

function executionBps(averagePrice: number | null, midPrice: number | null, side: 'sell' | 'buy'): number | null {
  if (
    averagePrice === null ||
    midPrice === null ||
    !Number.isFinite(averagePrice) ||
    !Number.isFinite(midPrice) ||
    averagePrice <= 0 ||
    midPrice <= 0
  ) {
    return null;
  }
  return side === 'sell'
    ? ((midPrice - averagePrice) / midPrice) * 10_000
    : ((averagePrice - midPrice) / midPrice) * 10_000;
}

function sampleAveragePrice(samples: QuoteSample[], quoteAmount: string): number | null {
  const sample = samples.find((item) => item.quoteAmount === quoteAmount);
  const price = Number(sample?.avgPrice);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function marketMid(snapshot: OrderBookSnapshot | null): number | null {
  const bid = Number(snapshot?.bids[0]?.price);
  const ask = Number(snapshot?.asks[0]?.price);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || bid > ask) return null;
  return (bid + ask) / 2;
}

function formatBps(value: number | null): string {
  if (value === null) return '—';
  const rounded = Math.abs(value) < 0.05 ? 0 : Math.round(value * 10) / 10;
  return `${rounded.toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} bps`;
}

function ExecutionCostTable({
  snapshot,
  surface,
  sources,
}: {
  snapshot: OrderBookSnapshot | null;
  surface: QuoteSurface | null;
  sources: PairSources;
}) {
  const quote = snapshot ?? surface;
  if (!quote) return null;
  const quoteSym = assetLabel(quote.quote, quote.chain);
  const mid = marketMid(snapshot);

  return (
    <section className="dex-execution" aria-label="Execution cost">
      <div className="dex-execution-head">
        <h4>Execution cost</h4>
        <p>Execution cost versus the current mid price; lower is better.</p>
      </div>
      <div className="dex-execution-scroll">
        <table className="dex-book dex-execution-table">
          <thead>
            <tr>
              <th>Notional ({quoteSym})</th>
              {sources.clob && <th className="sell">Book sell</th>}
              {sources.clob && <th className="buy">Book buy</th>}
              {sources.paths && <th className="sell">Paths sell</th>}
              {sources.paths && <th className="buy">Paths buy</th>}
            </tr>
          </thead>
          <tbody>
            {QUOTE_AMOUNTS.map((amount) => (
              <tr key={amount}>
                <th scope="row">{fmt(amount, 6)}</th>
                {sources.clob && (
                  <td className="sell">
                    {formatBps(
                      executionBps(
                        bookAveragePrice(snapshot?.bids ?? [], mid === null ? 0 : Number(amount) / mid),
                        mid,
                        'sell',
                      ),
                    )}
                  </td>
                )}
                {sources.clob && (
                  <td className="buy">
                    {formatBps(
                      executionBps(
                        bookAveragePrice(snapshot?.asks ?? [], mid === null ? 0 : Number(amount) / mid),
                        mid,
                        'buy',
                      ),
                    )}
                  </td>
                )}
                {sources.paths && (
                  <td className="sell">
                    {formatBps(executionBps(sampleAveragePrice(surface?.sell ?? [], amount), mid, 'sell'))}
                  </td>
                )}
                {sources.paths && (
                  <td className="buy">
                    {formatBps(executionBps(sampleAveragePrice(surface?.buy ?? [], amount), mid, 'buy'))}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function PairCard({ pair, onRemove }: { pair: PairConfig; onRemove: () => void }) {
  const [sources, setSources] = useState<PairSources>(pair.sources);
  const request = {
    chain: pair.chain,
    network: pair.network,
    base: pair.base,
    quote: pair.quote,
    fundedAccounts: pair.fundedAccounts,
  };
  const book = useOrderBookFeed(request, sources.clob);
  const paths = useQuoteSurfaceFeed(request, sources.paths, QUOTE_AMOUNTS);

  const availableKinds = CHART_KINDS.filter(({ id }) => sources[CHART_KIND_SOURCE[id]]);
  const defaultKind = sources.clob ? 'depth' : 'quotes';
  const [chartKind, setChartKind] = useState<ChartKind>(defaultKind);
  const activeKind = availableKinds.some(({ id }) => id === chartKind)
    ? chartKind
    : (availableKinds[0]?.id ?? defaultKind);

  const [history, setHistory] = useState<PricePoint[]>([]);
  const unsupported = isUnsupportedChain(book.error) || isUnsupportedChain(paths.error);
  const xrplPathfindingUnavailable =
    pair.chain === 'xrpl' && (!pair.fundedAccounts.base?.trim() || !pair.fundedAccounts.quote?.trim());

  function toggleSource(id: keyof PairSources) {
    if (id === 'paths' && xrplPathfindingUnavailable) return;
    setSources((s) => {
      const next = { ...s, [id]: !s[id] };
      return next.clob || next.paths ? next : s; // keep at least one source on
    });
  }

  // Append one history point per snapshot (state-during-render pattern).
  const [prevSnapshot, setPrevSnapshot] = useState<OrderBookSnapshot | null>(null);
  if (book.snapshot !== prevSnapshot) {
    setPrevSnapshot(book.snapshot);
    const bestBid = book.snapshot?.bids[0];
    const bestAsk = book.snapshot?.asks[0];
    if (book.snapshot && bestBid && bestAsk) {
      const snapshot = book.snapshot;
      const time = Math.floor(snapshot.timestamp / 1000) as UTCTimestamp;
      const mid = (Number(bestBid.price) + Number(bestAsk.price)) / 2;
      const spread = Number(bestAsk.price) - Number(bestBid.price);
      setHistory((h) => {
        // lightweight-charts needs ascending times: same-second updates replace.
        const next = h.length > 0 && h[h.length - 1].time === time ? h.slice(0, -1) : h.slice();
        next.push({ time, mid, spread });
        return next.length > HISTORY_MAX ? next.slice(next.length - HISTORY_MAX) : next;
      });
    }
  }

  const feedErrors = [
    sources.clob && book.error && !unsupported ? { label: 'book', error: book.error } : null,
    sources.paths && paths.error && !unsupported ? { label: 'paths', error: paths.error } : null,
  ].filter((e): e is { label: string; error: Error } => e !== null);
  const hasData = book.snapshot !== null || paths.surface !== null;

  return (
    <div className="dex-card">
      <div className="dex-card-head">
        <h3>{pairLabel(pair)}</h3>
        <span className="tile-note">
          {CHAIN_LABELS[pair.chain]} · {pair.network}
        </span>
        {!unsupported && (
          <span className="dex-statuses">
            {sources.clob && <StatusDot tone={STATUS_TONES[book.status] ?? 'idle'}>book</StatusDot>}
            {sources.paths && <StatusDot tone={STATUS_TONES[paths.status] ?? 'idle'}>paths</StatusDot>}
          </span>
        )}
        <Button size="sm" variant="ghost" onClick={onRemove} aria-label={`Remove ${pairLabel(pair)}`}>
          <X size={14} strokeWidth={1.75} aria-hidden="true" />
        </Button>
      </div>

      {unsupported ? (
        <Banner tone="info">
          Order books are not supported on EVM chains yet. Add a Stellar or XRPL pair to see live data.
        </Banner>
      ) : (
        <>
          <div className="dex-card-controls">
            <div className="chart-picker" role="group" aria-label="Data sources">
              {SOURCE_LABELS.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={sources[id]}
                  className={sources[id] ? 'active' : ''}
                  onClick={() => toggleSource(id)}
                  disabled={id === 'paths' && xrplPathfindingUnavailable}
                  title={
                    id === 'paths' && xrplPathfindingUnavailable
                      ? 'Add funded XRPL accounts when creating the pair to enable pathfinding'
                      : undefined
                  }
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="chart-picker" role="tablist" aria-label="Chart type">
              {availableKinds.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={activeKind === id}
                  className={activeKind === id ? 'active' : ''}
                  onClick={() => setChartKind(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <BookChart kind={activeKind} snapshot={book.snapshot} surface={paths.surface} history={history} />
          {feedErrors.map(({ label, error }) =>
            hasData ? (
              <div key={label} className="dex-error">
                {label}: {error.message}
              </div>
            ) : (
              <Banner key={label} tone="err">
                {label}: {error.message}
              </Banner>
            ),
          )}
          <ExecutionCostTable snapshot={book.snapshot} surface={paths.surface} sources={sources} />
          {!hasData && feedErrors.length === 0 && (
            <p className="dex-waiting">Waiting for the first market data…</p>
          )}
        </>
      )}
    </div>
  );
}
