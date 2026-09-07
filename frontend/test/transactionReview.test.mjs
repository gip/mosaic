import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTransactionReview } from '../src/components/transactionReview.ts';

const account = { kind: 'vault', chain: 'evm', address: '0x0000000000000000000000000000000000000001', zone: 'agent', addressId: 'address-1' };
const session = { chain: 'evm', address: '0x0000000000000000000000000000000000000002', network: 'testnet' };
const review = { kind: 'transfer', chain: 'evm', network: 'testnet', sourceKind: 'vault', sourceAddress: account.address, zone: account.zone, addressId: account.addressId,
  destinationAddress: session.address, assetId: 'eth', asset: { kind: 'native' }, assetSymbol: 'ETH', amount: '0.000000000000000001', fee: '0.000021', feeSymbol: 'ETH', expiresAt: new Date(Date.now() + 180000).toISOString() };
const request = { kind: 'evm', transaction: { from: account.address, to: session.address, value: '0x1', chainId: '0x14a34', gas: '0x5208', maxFeePerGas: '0x3b9aca00', maxPriorityFeePerGas: '0x1', nonce: '0x0', type: '0x2' } };

test('local signing review binds account, network, asset catalog and transaction bytes', async () => {
  await validateTransactionReview(review, request, account, session);
  for (const patch of [
    { network: 'mainnet' }, { sourceAddress: session.address }, { zone: 'other' }, { addressId: 'other' },
    { sourceKind: 'root' }, { assetId: 'usdc' }, { assetSymbol: 'USDC' },
    { asset: { kind: 'issued', code: 'ETH', issuer: session.address } },
  ]) await assert.rejects(() => validateTransactionReview({ ...review, ...patch }, request, account, session));
  await assert.rejects(() => validateTransactionReview(review, { ...request, transaction: { ...request.transaction, to: account.address } }, account, session));
  await assert.rejects(() => validateTransactionReview(review, { kind: 'xaman' }, account, session), /Vault transactions/);
});
