import { assertReviewFresh, reviewedUnits, type Asset, type TransactionReview } from '@mosaic/chain-core';
import { Account, Asset as StellarAsset, Networks, Operation, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { buildStellarOfferOperation } from './orders.js';

function asset(value: Asset): StellarAsset {
  return value.kind === 'native' ? StellarAsset.native() : new StellarAsset(value.code, value.issuer);
}

export function assertReviewedStellarTransaction(unsignedXdr: string, review: TransactionReview): void {
  assertReviewFresh(review, 'stellar', 'XLM');
  const tx = TransactionBuilder.fromXDR(unsignedXdr, review.network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET);
  if (!(tx instanceof Transaction) || tx.source !== review.sourceAddress || tx.signatures.length !== 0 || tx.operations.length !== 1) {
    throw new Error('unreviewed Stellar source, signatures, or operations');
  }
  if (BigInt(tx.fee) !== reviewedUnits(review.fee, 7) || BigInt(tx.fee) <= 0n || tx.memo.type !== 'none') {
    throw new Error('unreviewed Stellar fee or memo');
  }
  if (!tx.timeBounds || tx.timeBounds.minTime !== '0' || BigInt(tx.timeBounds.maxTime) <= BigInt(Math.floor(Date.now() / 1000)) ||
      BigInt(tx.timeBounds.maxTime) > BigInt(Math.ceil(Date.parse(review.expiresAt) / 1000))) {
    throw new Error('unreviewed Stellar validity window');
  }
  // Compare the entire envelope to a locally built transaction. This also
  // rejects extra signers, ledger bounds, preconditions, and operation sources.
  let expectedOperation;
  if (review.kind === 'transfer') {
    if (tx.operations[0]!.type === 'createAccount' && review.asset.kind === 'native') {
      expectedOperation = Operation.createAccount({ destination: review.destinationAddress, startingBalance: review.amount });
    } else {
      expectedOperation = Operation.payment({ destination: review.destinationAddress, asset: asset(review.asset), amount: review.amount });
    }
  } else if (review.action === 'cancel') {
    if (!review.offerId || !/^[1-9]\d*$/.test(review.offerId)) throw new Error('missing reviewed offer ID');
    expectedOperation = Operation.manageSellOffer({
      selling: asset(review.side === 'sell' ? review.base : review.quote), buying: asset(review.side === 'sell' ? review.quote : review.base),
      amount: '0', price: '1', offerId: review.offerId,
    });
  } else expectedOperation = buildStellarOfferOperation(review);
  const rebuilt = new TransactionBuilder(new Account(tx.source, (BigInt(tx.sequence) - 1n).toString()), {
    fee: tx.fee, networkPassphrase: tx.networkPassphrase, timebounds: tx.timeBounds,
  }).addOperation(expectedOperation).build();
  if (rebuilt.toXDR() !== tx.toXDR()) throw new Error('Stellar transaction differs from review');
}
