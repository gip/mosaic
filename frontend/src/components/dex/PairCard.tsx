import { useState } from 'react';
import { X } from 'lucide-react';
import type { OrderBookLevel, OrderBookSnapshot, QuoteSurface } from '@mosaic/dex';
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
const TABLE_LEVELS = 8;
const HISTORY_MAX = 600;

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

function BookTable({ snapshot }: { snapshot: OrderBookSnapshot }) {
  const asks = snapshot.asks.slice(0, TABLE_LEVELS);
  const bids = snapshot.bids.slice(0, TABLE_LEVELS);
  const maxAmount = Math.max(...[...asks, ...bids].map((l) => Number(l.amount)), 1e-18);
  const bestBid = bids[0];
  const bestAsk = asks[0];
  const spread = bestBid && bestAsk ? Number(bestAsk.price) - Number(bestBid.price) : null;
  const mid = bestBid && bestAsk ? (Number(bestAsk.price) + Number(bestBid.price)) / 2 : null;

  // Positional keys: several offers can share one price level.
  const row = (level: OrderBookLevel, side: 'ask' | 'bid', index: number) => (
    <tr
      key={`${side}-${index}`}
      className={side}
      style={{
        backgroundImage: `linear-gradient(to left, var(--${side === 'ask' ? 'sell' : 'buy'}-dim) ${
          (Number(level.amount) / maxAmount) * 100
        }%, transparent 0)`,
      }}
    >
      <td className="dex-price">{fmt(level.price)}</td>
      <td>{fmt(level.amount)}</td>
    </tr>
  );

  return (
    <table className="dex-book">
      <thead>
        <tr>
          <th>Price ({assetLabel(snapshot.quote, snapshot.chain)})</th>
          <th>Size ({assetLabel(snapshot.base, snapshot.chain)})</th>
        </tr>
      </thead>
      <tbody>
        {[...asks].reverse().map((l, i) => row(l, 'ask', i))}
        <tr className="dex-spread">
          <td colSpan={2}>
            {spread !== null && mid !== null
              ? `spread ${fmt(spread, 4)} (${fmt((spread / mid) * 100, 3)}%)`
              : 'one-sided book'}
          </td>
        </tr>
        {bids.map((l, i) => row(l, 'bid', i))}
      </tbody>
    </table>
  );
}

function SurfaceTable({ surface }: { surface: QuoteSurface }) {
  const rows = Math.max(surface.sell.length, surface.buy.length);
  if (rows === 0) return <p className="dex-waiting">No executable routes found for the sampled sizes.</p>;
  const baseSym = assetLabel(surface.base, surface.chain);
  const quoteSym = assetLabel(surface.quote, surface.chain);
  return (
    <table className="dex-book dex-surface">
      <thead>
        <tr>
          <th>Sell size ({baseSym})</th>
          <th>Sell avg ({quoteSym})</th>
          <th>Buy size ({baseSym})</th>
          <th>Buy avg ({quoteSym})</th>
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }, (_, i) => {
          const sell = surface.sell[i];
          const buy = surface.buy[i];
          return (
            <tr key={i}>
              <td className="bid dex-price">{sell ? fmt(sell.amount) : '—'}</td>
              <td className="bid">{sell ? fmt(sell.avgPrice) : '—'}</td>
              <td className="ask dex-price">{buy ? fmt(buy.amount) : '—'}</td>
              <td className="ask">{buy ? fmt(buy.avgPrice) : '—'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default function PairCard({ pair, onRemove }: { pair: PairConfig; onRemove: () => void }) {
  const [sources, setSources] = useState<PairSources>(pair.sources);
  const request = {
    chain: pair.chain,
    network: pair.network,
    base: pair.base,
    quote: pair.quote,
  };
  const book = useOrderBookFeed(request, sources.clob);
  const paths = useQuoteSurfaceFeed(request, sources.paths);

  const availableKinds = CHART_KINDS.filter(({ id }) => sources[CHART_KIND_SOURCE[id]]);
  const defaultKind = sources.clob ? 'depth' : 'quotes';
  const [chartKind, setChartKind] = useState<ChartKind>(defaultKind);
  const activeKind = availableKinds.some(({ id }) => id === chartKind)
    ? chartKind
    : (availableKinds[0]?.id ?? defaultKind);

  const [history, setHistory] = useState<PricePoint[]>([]);
  const unsupported = isUnsupportedChain(book.error) || isUnsupportedChain(paths.error);

  function toggleSource(id: keyof PairSources) {
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
          {sources.paths && paths.surface && <SurfaceTable surface={paths.surface} />}
          {sources.clob && book.snapshot && <BookTable snapshot={book.snapshot} />}
          {!hasData && feedErrors.length === 0 && (
            <p className="dex-waiting">Waiting for the first market data…</p>
          )}
        </>
      )}
    </div>
  );
}
