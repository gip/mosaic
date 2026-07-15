import { formatScaled, type Network, type TransferIntent } from '@mosaic/chain-core';
import {
  createPublicClient,
  decodeFunctionData,
  encodeFunctionData,
  formatEther,
  http,
  isAddress,
  keccak256,
  parseTransaction,
  parseUnits,
  recoverTransactionAddress,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { EVM_RPC_ENDPOINTS } from './balances.js';

const ERC20_TRANSFER_ABI = [{
  type: 'function', name: 'transfer', stateMutability: 'nonpayable',
  inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }],
  outputs: [{ name: '', type: 'bool' }],
}] as const;

export interface EvmTransactionRequest {
  from: Address;
  to: Address;
  data?: Hex;
  value: Hex;
  chainId: Hex;
  gas: Hex;
  maxFeePerGas: Hex;
  maxPriorityFeePerGas: Hex;
  nonce: Hex;
  type: '0x2';
}

export interface PreparedEvmTransfer {
  kind: 'evm';
  transaction: EvmTransactionRequest;
  fee: string;
  feeSymbol: 'ETH';
  reserveImpact: null;
  expiresAt: string;
}

const hex = (value: bigint | number) => `0x${BigInt(value).toString(16)}` as Hex;

export async function prepareEvmTransfer(intent: TransferIntent, decimals: number): Promise<PreparedEvmTransfer> {
  if (intent.chain !== 'evm') throw new Error('EVM transfer requires the evm chain');
  if (!isAddress(intent.sourceAddress) || !isAddress(intent.destinationAddress)) throw new Error('invalid EVM account address');
  if (intent.sourceAddress.toLowerCase() === intent.destinationAddress.toLowerCase()) throw new Error('source and destination must differ');
  const chain = intent.network === 'mainnet' ? base : baseSepolia;
  const client = createPublicClient({ chain, transport: http(EVM_RPC_ENDPOINTS[intent.network]) });
  const quantity = parseUnits(intent.amount, decimals);
  const token = intent.asset.kind === 'issued' ? intent.asset.issuer as Address : null;
  if (token && !isAddress(token)) throw new Error('invalid EVM token contract address');
  const data = token ? encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: 'transfer', args: [intent.destinationAddress as Address, quantity] }) : undefined;
  const to = token ?? intent.destinationAddress as Address;
  const value = token ? 0n : quantity;
  const [nonce, gas, fees] = await Promise.all([
    client.getTransactionCount({ address: intent.sourceAddress as Address, blockTag: 'pending' }),
    client.estimateGas({ account: intent.sourceAddress as Address, to, data, value }),
    client.estimateFeesPerGas(),
  ]);
  const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 0n;
  return {
    kind: 'evm',
    transaction: {
      from: intent.sourceAddress as Address, to, ...(data ? { data } : {}), value: hex(value),
      chainId: hex(chain.id), gas: hex(gas), maxFeePerGas: hex(maxFeePerGas),
      maxPriorityFeePerGas: hex(maxPriorityFeePerGas), nonce: hex(nonce), type: '0x2',
    },
    fee: formatEther(gas * maxFeePerGas), feeSymbol: 'ETH', reserveImpact: null,
    expiresAt: new Date(Date.now() + 3 * 60_000).toISOString(),
  };
}

function privateKeyHex(privateKey: Uint8Array): Hex {
  return `0x${Array.from(privateKey, (value) => value.toString(16).padStart(2, '0')).join('')}`;
}

export async function signEvmTransfer(transaction: EvmTransactionRequest, privateKey: Uint8Array): Promise<Hex> {
  const account = privateKeyToAccount(privateKeyHex(privateKey));
  if (account.address.toLowerCase() !== transaction.from.toLowerCase()) throw new Error('derived EVM key does not match transfer source');
  return account.signTransaction({
    chainId: Number(BigInt(transaction.chainId)), to: transaction.to, data: transaction.data,
    value: BigInt(transaction.value), gas: BigInt(transaction.gas), nonce: Number(BigInt(transaction.nonce)),
    maxFeePerGas: BigInt(transaction.maxFeePerGas), maxPriorityFeePerGas: BigInt(transaction.maxPriorityFeePerGas),
    type: 'eip1559',
  });
}

export async function verifyEvmTransfer(serialized: Hex, expected: EvmTransactionRequest): Promise<void> {
  const parsed = parseTransaction(serialized);
  const from = await recoverTransactionAddress({ serializedTransaction: serialized as `0x02${string}` });
  if (from.toLowerCase() !== expected.from.toLowerCase()
    || parsed.chainId !== Number(BigInt(expected.chainId))
    || parsed.to?.toLowerCase() !== expected.to.toLowerCase()
    || (parsed.data ?? '0x').toLowerCase() !== (expected.data ?? '0x').toLowerCase()
    || (parsed.value ?? 0n) !== BigInt(expected.value)) {
    throw new Error('signed EVM transaction does not match the prepared transfer');
  }
  if (expected.data) {
    const decoded = decodeFunctionData({ abi: ERC20_TRANSFER_ABI, data: expected.data });
    if (decoded.functionName !== 'transfer') throw new Error('only ERC-20 transfer calldata is allowed');
  }
}

export function evmTransactionHash(serialized: Hex): Hex {
  return keccak256(serialized);
}

async function rpc(network: Network, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(EVM_RPC_ENDPOINTS[network], {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`EVM JSON-RPC responded ${response.status}`);
  const body = await response.json() as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? `${method} failed`);
  return body.result;
}

export async function submitEvmTransfer(network: Network, serialized: Hex): Promise<{ hash: string; resultCode: string }> {
  const result = await rpc(network, 'eth_sendRawTransaction', [serialized]);
  if (typeof result !== 'string') throw new Error('EVM submission returned no transaction hash');
  return { hash: result, resultCode: 'submitted' };
}

export async function lookupEvmTransfer(network: Network, hash: string): Promise<{ hash: string; ledger?: string; resultCode: string } | null> {
  const result = await rpc(network, 'eth_getTransactionReceipt', [hash]) as { blockNumber?: string; status?: string } | null;
  if (!result) return null;
  return { hash, ledger: result.blockNumber ? BigInt(result.blockNumber).toString() : undefined, resultCode: result.status === '0x1' ? 'success' : 'failed' };
}

export async function verifyWalletEvmTransfer(network: Network, hash: string, expected: EvmTransactionRequest): Promise<boolean> {
  const tx = await rpc(network, 'eth_getTransactionByHash', [hash]) as { from?: string; to?: string; input?: string; value?: string; chainId?: string } | null;
  if (!tx) return false;
  if (tx.from?.toLowerCase() !== expected.from.toLowerCase() || tx.to?.toLowerCase() !== expected.to.toLowerCase()
    || (tx.input ?? '0x').toLowerCase() !== (expected.data ?? '0x').toLowerCase()
    || BigInt(tx.value ?? '0x0') !== BigInt(expected.value)) throw new Error('wallet EVM transaction does not match the prepared transfer');
  return true;
}

export function formatEvmTokenAmount(value: bigint, decimals: number): string {
  return formatScaled(value, decimals);
}
