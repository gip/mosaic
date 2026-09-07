import type { ActivityRecord, OrderPreview } from './trading.js';
import type { TransferPreview } from './transfers.js';

export type TransactionReview = TransferPreview | (OrderPreview & Pick<ActivityRecord, 'offerId'>);

/** Exact base-unit conversion for signing checks. Never round reviewed values. */
export function reviewedUnits(value: string, decimals: number): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) || value.length > 160) {
    throw new Error('invalid reviewed amount');
  }
  const [whole, fraction = ''] = value.split('.');
  if (/[1-9]/.test(fraction.slice(decimals))) throw new Error('reviewed amount exceeds asset precision');
  return BigInt(whole! + fraction.slice(0, decimals).padEnd(decimals, '0'));
}

export function assertReviewFresh(review: TransactionReview, chain: string, feeSymbol: string): void {
  if (review.chain !== chain || !['mainnet', 'testnet'].includes(review.network) || review.feeSymbol !== feeSymbol) {
    throw new Error('transaction review chain or fee asset mismatch');
  }
  if (!Number.isFinite(Date.parse(review.expiresAt)) || Date.parse(review.expiresAt) <= Date.now()) {
    throw new Error('transaction review expired');
  }
  if (review.kind === 'order' && (review.action !== 'cancel' && review.action !== review.side)) {
    throw new Error('order action does not match reviewed side');
  }
}

/** Reject added fields as well as changed fields, including nested authority. */
export function assertReviewedFields(actual: unknown, expected: unknown): void {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]));
    }
    return value;
  };
  if (JSON.stringify(normalize(actual)) !== JSON.stringify(normalize(expected))) {
    throw new Error('transaction differs from the reviewed operation');
  }
}
