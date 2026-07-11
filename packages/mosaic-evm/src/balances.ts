import { formatScaled } from '@mosaic/chain-core';
import type {
  BalancesFetchOptions,
  BalancesRequest,
  BalancesSnapshot,
  Network,
} from '@mosaic/chain-core';

export const EVM_RPC_ENDPOINTS: Record<Network, string> = {
  mainnet: 'https://mainnet.base.org',
  testnet: 'https://sepolia.base.org',
};

const NATIVE_DECIMALS = 18;
const BALANCE_OF_SELECTOR = '0x70a08231';
const DECIMALS_SELECTOR = '0x313ce567';

/** decimals() per `${endpoint}|${contract}` — immutable on-chain, cached for the process. */
const decimalsCache = new Map<string, number>();

interface JsonRpcEntry {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/**
 * Balances for known assets across EVM (Base) accounts via one batched
 * JSON-RPC POST: `eth_getBalance` for the native asset and ERC-20
 * `balanceOf(address)` via `eth_call` for issued assets (`issuer` = token
 * contract). Token decimals come from `decimals()` on first sight and are
 * cached per endpoint+contract. EVM accounts always exist → `funded: true`.
 */
export async function fetchBalances(
  req: BalancesRequest,
  opts: BalancesFetchOptions,
): Promise<BalancesSnapshot> {
  const endpoint = opts.httpEndpoint ?? EVM_RPC_ENDPOINTS[req.network];
  if (req.addresses.length === 0) {
    return { network: req.network, accounts: [], timestamp: Date.now() };
  }

  const tokens = [
    ...new Set(req.assets.flatMap((asset) => (asset.kind === 'issued' ? [asset.issuer] : []))),
  ];

  const calls: { jsonrpc: '2.0'; id: number; method: string; params: unknown[] }[] = [];
  const addCall = (method: string, params: unknown[]): number => {
    const id = calls.length + 1;
    calls.push({ jsonrpc: '2.0', id, method, params });
    return id;
  };

  const decimalsIds = new Map<string, number>();
  for (const token of tokens) {
    if (!decimalsCache.has(`${endpoint}|${token}`)) {
      decimalsIds.set(token, addCall('eth_call', [{ to: token, data: DECIMALS_SELECTOR }, 'latest']));
    }
  }
  const nativeIds = new Map<string, number>();
  const tokenIds = new Map<string, number>();
  for (const address of req.addresses) {
    nativeIds.set(address, addCall('eth_getBalance', [address, 'latest']));
    for (const token of tokens) {
      tokenIds.set(
        `${token}|${address}`,
        addCall('eth_call', [{ to: token, data: BALANCE_OF_SELECTOR + encodeAddressWord(address) }, 'latest']),
      );
    }
  }

  const res = await opts.fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(calls),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`EVM JSON-RPC responded ${res.status}`);
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error('EVM JSON-RPC: unexpected batch response shape');
  // Batch responses may arrive in any order: match by id, never by position.
  const byId = new Map<number, JsonRpcEntry>();
  for (const entry of body as JsonRpcEntry[]) {
    if (typeof entry?.id === 'number') byId.set(entry.id, entry);
  }
  const hexResult = (id: number, what: string): string => {
    const entry = byId.get(id);
    if (!entry || entry.error || typeof entry.result !== 'string') {
      throw new Error(`EVM ${what} failed: ${entry?.error?.message ?? 'missing batch result'}`);
    }
    return entry.result;
  };

  for (const [token, id] of decimalsIds) {
    const hex = hexResult(id, `decimals() for ${token}`);
    // '0x' means no contract code at the address — a misconfigured asset;
    // surface it rather than guessing a precision.
    if (hex === '0x') throw new Error(`EVM token ${token} did not report decimals()`);
    const decimals = Number(BigInt(hex));
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
      throw new Error(`EVM token ${token} reported invalid decimals: ${hex}`);
    }
    decimalsCache.set(`${endpoint}|${token}`, decimals);
  }

  const accounts = req.addresses.map((address) => ({
    address,
    funded: true,
    balances: req.assets.map((asset) => {
      if (asset.kind === 'native') {
        const hex = hexResult(nativeIds.get(address)!, `eth_getBalance for ${address}`);
        return { asset, amount: formatScaled(BigInt(hex), NATIVE_DECIMALS) };
      }
      const hex = hexResult(tokenIds.get(`${asset.issuer}|${address}`)!, `balanceOf for ${asset.symbol}`);
      if (hex === '0x') return { asset, amount: '0' };
      const decimals = decimalsCache.get(`${endpoint}|${asset.issuer}`)!;
      return { asset, amount: formatScaled(BigInt(hex), decimals) };
    }),
  }));

  return { network: req.network, accounts, timestamp: Date.now() };
}

/** ABI-encode an address as a 32-byte word (lowercased, 0x-stripped). */
function encodeAddressWord(address: string): string {
  const clean = address.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(clean)) {
    throw new Error(`invalid EVM address: ${JSON.stringify(address)}`);
  }
  return clean.padStart(64, '0');
}
