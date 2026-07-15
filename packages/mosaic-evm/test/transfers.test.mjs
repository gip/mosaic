import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { evmTransactionHash, signEvmTransfer, verifyEvmTransfer } from '../dist/index.js';

const privateKey = new Uint8Array(32).fill(0x42);
const account = privateKeyToAccount(`0x${'42'.repeat(32)}`);
const destination = '0x0000000000000000000000000000000000000001';
const request = {
  from: account.address, to: destination, value: '0x1', chainId: '0x14a34', gas: '0x5208',
  maxFeePerGas: '0x3b9aca00', maxPriorityFeePerGas: '0x1', nonce: '0x0', type: '0x2',
};

test('EVM transfer signs locally and verifies the exact semantic transaction', async () => {
  const serialized = await signEvmTransfer(request, privateKey);
  await verifyEvmTransfer(serialized, request);
  assert.match(evmTransactionHash(serialized), /^0x[0-9a-f]{64}$/);
  await assert.rejects(() => verifyEvmTransfer(serialized, { ...request, to: '0x0000000000000000000000000000000000000002' }), /does not match/);
});
