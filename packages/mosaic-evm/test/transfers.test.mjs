import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { assertReviewedEvmTransfer, evmTransactionHash, signEvmTransfer, verifyEvmTransfer } from '../dist/index.js';
import { encodeFunctionData } from 'viem';

const privateKey = new Uint8Array(32).fill(0x42);
const account = privateKeyToAccount(`0x${'42'.repeat(32)}`);
const destination = '0x0000000000000000000000000000000000000001';
const request = {
  from: account.address, to: destination, value: '0x1', chainId: '0x14a34', gas: '0x5208',
  maxFeePerGas: '0x3b9aca00', maxPriorityFeePerGas: '0x1', nonce: '0x0', type: '0x2',
};

test('EVM review rejects substituted transfers, network, calldata and excessive fees', () => {
  const review = { kind: 'transfer', chain: 'evm', network: 'testnet', sourceAddress: account.address, destinationAddress: destination, asset: { kind: 'native' }, amount: '0.000000000000000001', fee: '0.000021', feeSymbol: 'ETH', expiresAt: new Date(Date.now() + 180000).toISOString() };
  assertReviewedEvmTransfer(request, review, 18);
  for (const patch of [
    { to: account.address }, { value: '0x2' }, { chainId: '0x2105' }, { data: '0x095ea7b3' },
    { gas: '0x100000' }, { maxFeePerGas: '0x1000000000' }, { accessList: [] }, { type: '0x4' },
  ]) assert.throws(() => assertReviewedEvmTransfer({ ...request, ...patch }, review, 18));
  const token = { ...review, asset: { kind: 'issued', code: 'USDC', issuer: account.address }, amount: '2' };
  const data = encodeFunctionData({ abi: [{ type: 'function', name: 'transfer', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] }], functionName: 'transfer', args: [destination, 2000000n] });
  const tx = { ...request, to: account.address, value: '0x0', data };
  assertReviewedEvmTransfer(tx, token, 6);
  assert.throws(() => assertReviewedEvmTransfer({ ...tx, data: `0x095ea7b3${data.slice(10)}` }, token, 6));
  assert.throws(() => assertReviewedEvmTransfer({ ...tx, value: '0x1' }, token, 6));
});

test('EVM transfer signs locally and verifies the exact semantic transaction', async () => {
  const serialized = await signEvmTransfer(request, privateKey);
  await verifyEvmTransfer(serialized, request);
  assert.match(evmTransactionHash(serialized), /^0x[0-9a-f]{64}$/);
  await assert.rejects(() => verifyEvmTransfer(serialized, { ...request, to: '0x0000000000000000000000000000000000000002' }), /does not match/);
});
