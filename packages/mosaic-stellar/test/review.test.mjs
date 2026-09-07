import test from 'node:test';
import assert from 'node:assert/strict';
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { assertReviewedStellarTransaction, buildStellarOfferOperation } from '../dist/index.js';

const source = Keypair.random(), destination = Keypair.random().publicKey();
const common = { chain: 'stellar', network: 'testnet', sourceAddress: source.publicKey(), sourceKind: 'vault', fee: '0.00001', feeSymbol: 'XLM', expiresAt: new Date(Date.now() + 180000).toISOString() };
const review = { ...common, kind: 'transfer', destinationAddress: destination, asset: { kind: 'native' }, amount: '2' };
function transaction(operations, opts = {}) {
  const builder = new TransactionBuilder(new Account(source.publicKey(), '1'), { fee: '100', networkPassphrase: Networks.TESTNET, ...opts });
  for (const op of operations) builder.addOperation(op);
  return builder.setTimeout(180).build();
}
const payment = (opts = {}) => Operation.payment({ destination, asset: Asset.native(), amount: '2', ...opts });

test('Stellar review accepts payment/createAccount and rejects altered envelopes and operations', () => {
  assertReviewedStellarTransaction(transaction([payment()]).toXDR(), review);
  assertReviewedStellarTransaction(transaction([Operation.createAccount({ destination, startingBalance: '2' })]).toXDR(), review);
  for (const operations of [
    [payment({ amount: '3' })], [payment({ destination: source.publicKey() })],
    [payment({ source: destination })], [payment({ asset: new Asset('USD', destination) })],
    [payment(), Operation.setOptions({ signer: { ed25519PublicKey: destination, weight: 1 } })],
    [Operation.accountMerge({ destination })],
  ]) assert.throws(() => assertReviewedStellarTransaction(transaction(operations).toXDR(), review), /review/);
  assert.throws(() => assertReviewedStellarTransaction(transaction([payment()], { fee: '10000' }).toXDR(), review), /fee/);
  const signed = transaction([payment()]); signed.sign(source);
  assert.throws(() => assertReviewedStellarTransaction(signed.toXDR(), review), /signatures/);
});

test('Stellar review binds buy/sell operations and cancellation offer ID', () => {
  for (const side of ['buy', 'sell']) {
    const order = { ...common, kind: 'order', action: side, side, amount: '2', limitPrice: '3', base: { kind: 'native' }, quote: { kind: 'issued', code: 'USD', issuer: destination } };
    assertReviewedStellarTransaction(transaction([buildStellarOfferOperation(order)]).toXDR(), order);
    assert.throws(() => assertReviewedStellarTransaction(transaction([buildStellarOfferOperation({ ...order, limitPrice: '4' })]).toXDR(), order));
  }
  const cancel = { ...common, kind: 'order', action: 'cancel', side: 'sell', base: { kind: 'native' }, quote: { kind: 'issued', code: 'USD', issuer: destination }, offerId: '42' };
  const op = (offerId) => Operation.manageSellOffer({ selling: Asset.native(), buying: new Asset('USD', destination), amount: '0', price: '1', offerId });
  assertReviewedStellarTransaction(transaction([op('42')]).toXDR(), cancel);
  assert.throws(() => assertReviewedStellarTransaction(transaction([op('43')]).toXDR(), cancel));
});
