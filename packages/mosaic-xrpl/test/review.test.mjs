import test from 'node:test';
import assert from 'node:assert/strict';
import { assertReviewedXrplTransaction, prepareXrplOrder, prepareXrplTransfer, prepareXrplCancel } from '../dist/index.js';

const source = 'rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn';
const destination = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
const common = { chain: 'xrpl', network: 'testnet', sourceAddress: source, sourceKind: 'vault', fee: '0.000012', feeSymbol: 'XRP', expiresAt: new Date(Date.now() + 180000).toISOString() };
const transfer = { ...common, kind: 'transfer', destinationAddress: destination, assetId: 'xrp', asset: { kind: 'native' }, assetSymbol: 'XRP', amount: '2' };
const client = () => ({ connect: async () => {}, disconnect: async () => {}, request: async () => ({ result: { lines: [{ account: destination, currency: 'USD' }] } }), autofill: async (tx) => ({ ...tx, Sequence: 1, LastLedgerSequence: 200, Fee: '12' }) });

test('XRPL review accepts prepared payments and rejects substituted funds or authority', async () => {
  const { unsignedTransaction: tx } = await prepareXrplTransfer(transfer, 77, client);
  assertReviewedXrplTransaction(tx, transfer);
  for (const patch of [
    { Destination: source }, { Amount: '3000000' }, { Account: destination }, { Fee: '1000000' },
    { TransactionType: 'AccountDelete' }, { RegularKey: destination }, { Signers: [] },
    { Flags: 0x00020000 }, { SendMax: '3000000' }, { Paths: [] }, { SigningPubKey: 'key' },
  ]) assert.throws(() => assertReviewedXrplTransaction({ ...tx, ...patch }, transfer), /review|signed/);
  assert.throws(() => assertReviewedXrplTransaction(tx, { ...transfer, expiresAt: 'invalid' }), /expired/);
  const issued = { ...transfer, asset: { kind: 'issued', code: 'USD', issuer: destination }, assetSymbol: 'USD' };
  const prepared = await prepareXrplTransfer(issued, 77, client);
  assertReviewedXrplTransaction(prepared.unsignedTransaction, issued);
  assert.throws(() => assertReviewedXrplTransaction({ ...prepared.unsignedTransaction, Amount: { ...prepared.unsignedTransaction.Amount, issuer: source } }, issued));
});

test('XRPL review binds buy/sell amounts, flags and the exact cancellation target', async () => {
  for (const side of ['buy', 'sell']) {
    const review = { ...common, kind: 'order', action: side, side, amount: '2', limitPrice: '3', quoteTotal: '6', base: { kind: 'native' }, quote: { kind: 'issued', code: 'USD', issuer: destination } };
    const { unsignedTransaction: tx } = await prepareXrplOrder(review, review.quoteTotal, 77, client);
    assertReviewedXrplTransaction(tx, review);
    assert.throws(() => assertReviewedXrplTransaction({ ...tx, TakerGets: tx.TakerPays, TakerPays: tx.TakerGets }, review));
    assert.throws(() => assertReviewedXrplTransaction({ ...tx, OfferSequence: 55 }, review));
    const cancel = { ...review, action: 'cancel', offerId: '55' };
    const prepared = await prepareXrplCancel('testnet', source, 55, 77, client);
    assertReviewedXrplTransaction(prepared.unsignedTransaction, cancel);
    assert.throws(() => assertReviewedXrplTransaction({ ...prepared.unsignedTransaction, OfferSequence: 56 }, cancel));
  }
});
