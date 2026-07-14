import type { Asset, Network } from './types.js';

export type TradingChain = 'xrpl' | 'stellar';
export type OrderSide = 'buy' | 'sell';
export type OrderAction = OrderSide | 'cancel';
export type OrderStatus =
  | 'awaiting_signature'
  | 'submitted'
  | 'confirmed'
  | 'open'
  | 'partially_filled'
  | 'filled'
  | 'cancelled'
  | 'failed'
  | 'expired'
  | 'unknown';

export interface DexOrderIntent {
  chain: TradingChain;
  network: Network;
  sourceAddress: string;
  sourceKind: 'root' | 'vault';
  zone?: string;
  addressId?: string;
  addressName?: string;
  side: OrderSide;
  base: Asset;
  quote: Asset;
  baseSymbol: string;
  quoteSymbol: string;
  /** Base units to buy or sell. Decimal string, never a JS number. */
  amount: string;
  /** Quote units per one base unit. Decimal string, never a JS number. */
  limitPrice: string;
}

export interface OrderPreview extends DexOrderIntent {
  action: OrderAction;
  quoteTotal: string;
  fee: string;
  feeSymbol: string;
  reserveImpact: string | null;
  expiresAt: string;
}

export interface ActivityRecord extends OrderPreview {
  id: string;
  cursor: number;
  orderId: string;
  status: OrderStatus;
  filledAmount: string;
  remainingAmount: string;
  averagePrice?: string;
  offerId?: string;
  transactionHash?: string;
  ledger?: string;
  resultCode?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  confirmedAt?: string;
}

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export type DecimalRounding = 'floor' | 'ceil';

export function assertPositiveDecimal(value: string, field: string): void {
  if (!DECIMAL.test(value) || !/[1-9]/.test(value)) throw new Error(`${field} must be a positive decimal string`);
}

/**
 * Quantize a positive decimal to an asset's supported fractional precision.
 * Uses exact BigInt arithmetic; `ceil` is useful for minimum proceeds on a
 * sell order, while `floor` is appropriate for maximum spend on a buy order.
 */
export function quantizeDecimal(value: string, decimals: number, rounding: DecimalRounding = 'floor'): string {
  assertPositiveDecimal(value, 'value');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) throw new Error('decimals must be an integer from 0 to 77');
  const [whole, fraction = ''] = value.split('.');
  const retained = fraction.slice(0, decimals).padEnd(decimals, '0');
  const discarded = fraction.slice(decimals);
  let scaled = BigInt(`${whole}${retained}`);
  if (rounding === 'ceil' && /[1-9]/.test(discarded)) scaled += 1n;
  if (decimals === 0) return scaled.toString();
  const text = scaled.toString().padStart(decimals + 1, '0');
  const normalizedFraction = text.slice(-decimals).replace(/0+$/, '');
  return normalizedFraction ? `${text.slice(0, -decimals)}.${normalizedFraction}` : text.slice(0, -decimals);
}

/** Exact decimal multiplication with trailing zero removal. */
export function multiplyDecimals(left: string, right: string): string {
  assertPositiveDecimal(left, 'left');
  assertPositiveDecimal(right, 'right');
  const [li, lf = ''] = left.split('.');
  const [ri, rf = ''] = right.split('.');
  const scale = lf.length + rf.length;
  const product = BigInt(`${li}${lf}`) * BigInt(`${ri}${rf}`);
  if (scale === 0) return product.toString();
  const padded = product.toString().padStart(scale + 1, '0');
  const whole = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
