import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareXrplTransfer } from '../dist/index.js';

const source = 'rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn';
const destination = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';

function client(lines = []) {
  return {
    async connect() {}, async disconnect() {},
    async request(request) {
      assert.equal(request.command, 'account_lines');
      return { result: { lines } };
    },
    async autofill(transaction) { return { ...transaction, Fee: '12', Sequence: 1, LastLedgerSequence: 20 }; },
  };
}

test('XRPL transfer prepares native Payment with the mandatory SourceTag', async () => {
  const prepared = await prepareXrplTransfer({
    kind: 'transfer', chain: 'xrpl', network: 'testnet', sourceAddress: source, sourceKind: 'vault',
    destinationAddress: destination, assetId: 'xrp', asset: { kind: 'native' }, assetSymbol: 'XRP', amount: '1.25',
  }, 77, () => client());
  assert.equal(prepared.unsignedTransaction.TransactionType, 'Payment');
  assert.equal(prepared.unsignedTransaction.SourceTag, 77);
  assert.equal(prepared.unsignedTransaction.Amount, '1250000');
  assert.equal(prepared.fee, '0.000012');
});

test('XRPL issued transfer requires and encodes the destination trustline', async () => {
  const asset = { kind: 'issued', code: 'RLUSD', currencyCode: `524C555344${'0'.repeat(30)}`, issuer: destination };
  await assert.rejects(() => prepareXrplTransfer({
    kind: 'transfer', chain: 'xrpl', network: 'testnet', sourceAddress: source, sourceKind: 'vault',
    destinationAddress: 'rHuGNhqTG32mfmAvWA8hUyWRLV3tCSwKQt', assetId: 'rlusd', asset, assetSymbol: 'RLUSD', amount: '5',
  }, 77, () => client()), /does not trust/);
  const prepared = await prepareXrplTransfer({
    kind: 'transfer', chain: 'xrpl', network: 'testnet', sourceAddress: source, sourceKind: 'vault',
    destinationAddress: 'rHuGNhqTG32mfmAvWA8hUyWRLV3tCSwKQt', assetId: 'rlusd', asset, assetSymbol: 'RLUSD', amount: '5',
  }, 77, () => client([{ account: destination, currency: asset.currencyCode, balance: '0', limit: '100' }]));
  assert.deepEqual(prepared.unsignedTransaction.Amount, { currency: asset.currencyCode, issuer: destination, value: '5' });
});
