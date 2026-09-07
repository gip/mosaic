import { assertReviewFresh, assertReviewedFields, reviewedUnits, type Asset, type TransactionReview } from '@mosaic/chain-core';
import { normalizeCurrency } from './adapter.js';

function amount(asset: Asset, value: string): unknown {
  if (asset.kind === 'native') return reviewedUnits(value, 6).toString();
  return { currency: normalizeCurrency(asset.currencyCode ?? asset.code), issuer: asset.issuer, value };
}

/** Networkless, default-deny validation before any private key is loaded. */
export function assertReviewedXrplTransaction(transaction: Record<string, unknown>, review: TransactionReview): void {
  assertReviewFresh(review, 'xrpl', 'XRP');
  const { Sequence, LastLedgerSequence, SourceTag, Fee, SigningPubKey, Flags, ...operation } = transaction;
  for (const [key, value] of Object.entries({ Sequence, LastLedgerSequence, SourceTag })) {
    if (!Number.isSafeInteger(value) || Number(value) < (key === 'SourceTag' ? 0 : 1) || Number(value) > 0xffff_ffff) {
      throw new Error(`invalid XRPL ${key}`);
    }
  }
  if (typeof Fee !== 'string' || !/^\d+$/.test(Fee) || BigInt(Fee) !== reviewedUnits(review.fee, 6) || BigInt(Fee) <= 0n) {
    throw new Error('XRPL fee differs from review');
  }
  if (SigningPubKey !== undefined && SigningPubKey !== '') throw new Error('transaction is already signed');
  const expectedFlags = review.kind === 'order' && review.action === 'sell' ? 0x00080000 : 0;
  if (Flags !== undefined && Flags !== expectedFlags && Flags !== expectedFlags + 0x80000000) {
    throw new Error('unreviewed XRPL flags');
  }
  if (Flags === undefined && expectedFlags !== 0) throw new Error('missing reviewed XRPL sell flag');
  const common = { Account: review.sourceAddress };
  if (review.kind === 'transfer') {
    assertReviewedFields(operation, { ...common, TransactionType: 'Payment', Destination: review.destinationAddress, Amount: amount(review.asset, review.amount) });
  } else if (review.action === 'cancel') {
    if (!review.offerId || !/^[1-9]\d*$/.test(review.offerId)) throw new Error('missing reviewed offer ID');
    assertReviewedFields(operation, { ...common, TransactionType: 'OfferCancel', OfferSequence: Number(review.offerId) });
  } else {
    assertReviewedFields(operation, {
      ...common, TransactionType: 'OfferCreate',
      TakerGets: amount(review.side === 'sell' ? review.base : review.quote, review.side === 'sell' ? review.amount : review.quoteTotal),
      TakerPays: amount(review.side === 'sell' ? review.quote : review.base, review.side === 'sell' ? review.quoteTotal : review.amount),
    });
  }
}
