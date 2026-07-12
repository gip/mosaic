import { formatScaled, parseScaled } from '@mosaic/chain-core';
import type {
  AccountBalances,
  BalancesFetchOptions,
  BalancesRequest,
  BalancesSnapshot,
  KnownAsset,
} from '@mosaic/chain-core';
import { HORIZON_ENDPOINTS } from './adapter.js';

/** Stellar asset amounts carry 7 decimal places. */
const STELLAR_DECIMALS = 7;

interface HorizonBalance {
  balance: string;
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
}

/**
 * Balances for known assets across Stellar accounts via Horizon
 * `GET /accounts/{id}` (CORS-enabled, so this works from browsers too).
 * 404 means the account is not on-ledger → `funded: false`, all zeros.
 * XLM amounts are totals, not reserve-adjusted spendable balances.
 */
export async function fetchBalances(
  req: BalancesRequest,
  opts: BalancesFetchOptions,
): Promise<BalancesSnapshot> {
  const endpoint = (opts.httpEndpoint ?? HORIZON_ENDPOINTS[req.network]).replace(/\/$/, '');

  const accounts = await Promise.all(
    req.addresses.map(async (address): Promise<AccountBalances> => {
      const res = await opts.fetch(`${endpoint}/accounts/${encodeURIComponent(address)}`, {
        headers: { accept: 'application/json' },
        signal: opts.signal,
      });
      if (res.status === 404) {
        return {
          address,
          funded: false,
          balances: req.assets.map((asset) => ({ asset, amount: '0' })),
        };
      }
      if (!res.ok) throw new Error(`Horizon responded ${res.status}`);
      const body = (await res.json()) as { balances?: unknown };
      if (!Array.isArray(body.balances)) {
        throw new Error('Horizon account: unexpected response shape');
      }
      const entries = body.balances as HorizonBalance[];
      return {
        address,
        funded: true,
        balances: req.assets.map((asset) => ({ asset, amount: balanceFor(asset, entries) })),
      };
    }),
  );

  return { network: req.network, accounts, timestamp: Date.now() };
}

function balanceFor(asset: KnownAsset, entries: HorizonBalance[]): string {
  const entry = entries.find((e) =>
    asset.kind === 'native'
      ? e.asset_type === 'native'
      : (e.asset_type === 'credit_alphanum4' || e.asset_type === 'credit_alphanum12') &&
        e.asset_code === asset.code &&
        e.asset_issuer === asset.issuer,
  );
  if (!entry || typeof entry.balance !== 'string') return '0';
  // Normalize Horizon's fixed 7-dp strings ("12.0000000" → "12").
  return formatScaled(parseScaled(entry.balance, STELLAR_DECIMALS), STELLAR_DECIMALS);
}
