import type { OrderBookLevel, OrderBookSnapshot, OrderSide, QuoteSample, QuoteSurface } from '@mosaic/chain-core';
import { EXECUTION_QUOTE_AMOUNTS } from './types';

export interface CostOrderSelection {
  side: OrderSide;
  amount: string;
  price: string;
}

interface BookExecution {
  averagePrice: number;
  limitPrice: string;
}

function bookExecution(levels: OrderBookLevel[], baseAmount: number): BookExecution | null {
  if (!Number.isFinite(baseAmount) || baseAmount <= 0) return null;
  let remainingBase = baseAmount;
  let quoteTotal = 0;
  let limitPrice = '';
  for (const level of levels) {
    const price = Number(level.price);
    const availableBase = Number(level.amount);
    if (!Number.isFinite(price) || !Number.isFinite(availableBase) || price <= 0 || availableBase <= 0) continue;
    const baseHere = Math.min(remainingBase, availableBase);
    quoteTotal += baseHere * price;
    remainingBase -= baseHere;
    limitPrice = level.price;
    if (remainingBase <= Math.max(baseAmount, 1) * 1e-12) break;
  }
  return remainingBase > Math.max(baseAmount, 1) * 1e-12 || !limitPrice
    ? null
    : { averagePrice: quoteTotal / baseAmount, limitPrice };
}

function executionBps(averagePrice: number | null, midPrice: number | null, side: 'sell' | 'buy'): number | null {
  if (averagePrice === null || midPrice === null || averagePrice <= 0 || midPrice <= 0) return null;
  return side === 'sell'
    ? ((midPrice - averagePrice) / midPrice) * 10_000
    : ((averagePrice - midPrice) / midPrice) * 10_000;
}

function sampleAveragePrice(samples: QuoteSample[], quoteAmount: string): number | null {
  const price = Number(samples.find((item) => item.quoteAmount === quoteAmount)?.avgPrice);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function marketMid(snapshot: OrderBookSnapshot | null): number | null {
  const bid = Number(snapshot?.bids[0]?.price);
  const ask = Number(snapshot?.asks[0]?.price);
  return Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 && bid <= ask ? (bid + ask) / 2 : null;
}

function formatBps(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const rounded = Math.abs(value) < 0.05 ? 0 : Math.round(value * 10) / 10;
  return `${rounded.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} bps`;
}

function formatOrderAmount(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const amount = value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return Number(amount) > 0 ? amount : null;
}

function CostCell({
  side,
  quoteAmount,
  baseAmount,
  execution,
  mid,
  onSelectOrder,
}: {
  side: OrderSide;
  quoteAmount: string;
  baseAmount: number;
  execution: BookExecution | null;
  mid: number | null;
  onSelectOrder?: (selection: CostOrderSelection) => void;
}) {
  const label = formatBps(executionBps(execution?.averagePrice ?? null, mid, side));
  const amount = formatOrderAmount(baseAmount);
  if (!onSelectOrder || !execution || !amount) return <td className={side}>{label}</td>;
  return <td className={side}>
    <button
      type="button"
      className="dex-cost-action"
      aria-label={`Create ${side} order for ${quoteAmount} quote units`}
      title={`Use this book cost to create a ${side} limit order`}
      onClick={() => onSelectOrder({ side, amount, price: execution.limitPrice })}
    >
      {label}
    </button>
  </td>;
}

export default function ExecutionCostTable({
  snapshot,
  surface,
  quoteSymbol,
  pathAvailable,
  pathError,
  onSelectOrder,
}: {
  snapshot: OrderBookSnapshot | null;
  surface: QuoteSurface | null;
  quoteSymbol: string;
  pathAvailable: boolean;
  pathError?: string;
  onSelectOrder?: (selection: CostOrderSelection) => void;
}) {
  const mid = marketMid(snapshot);
  return <div className="dex-cost-view">
    <div className="dex-cost-intro">
      <p>Execution cost versus the current order-book midpoint. Lower is better.</p>
    </div>
    <div className="dex-execution-scroll">
      <table className="dex-book dex-execution-table">
        <thead><tr><th>Notional ({quoteSymbol})</th><th className="sell">Book sell</th><th className="buy">Book buy</th>{pathAvailable && <><th className="sell">Path sell</th><th className="buy">Path buy</th></>}</tr></thead>
        <tbody>{EXECUTION_QUOTE_AMOUNTS.map((amount) => {
          const baseAmount = mid === null ? 0 : Number(amount) / mid;
          const sellExecution = bookExecution(snapshot?.bids ?? [], baseAmount);
          const buyExecution = bookExecution(snapshot?.asks ?? [], baseAmount);
          return <tr key={amount}>
            <th scope="row">{Number(amount).toLocaleString()}</th>
            <CostCell side="sell" quoteAmount={amount} baseAmount={baseAmount} execution={sellExecution} mid={mid} onSelectOrder={onSelectOrder} />
            <CostCell side="buy" quoteAmount={amount} baseAmount={baseAmount} execution={buyExecution} mid={mid} onSelectOrder={onSelectOrder} />
            {pathAvailable && <><td className="sell">{formatBps(executionBps(sampleAveragePrice(surface?.sell ?? [], amount), mid, 'sell'))}</td><td className="buy">{formatBps(executionBps(sampleAveragePrice(surface?.buy ?? [], amount), mid, 'buy'))}</td></>}
          </tr>;
        })}</tbody>
      </table>
    </div>
    {pathError && <p className="activity-summary-error">Path view: {pathError}</p>}
  </div>;
}
