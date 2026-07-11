import { dropsToXrp } from '@mosaic/chain-core';
import type {
  AccountBalances,
  AssetBalance,
  BalancesFetchOptions,
  BalancesRequest,
  BalancesSnapshot,
} from '@mosaic/chain-core';
import {
  XRPL_WS_ENDPOINTS,
  normalizeCurrency,
  wsRequestBatchSettled,
  type XrplBatchOutcome,
} from './adapter.js';

interface XrplAccountData {
  Balance?: string;
}

interface XrplTrustLine {
  account: string;
  currency: string;
  balance: string;
}

/**
 * Balances for known assets across XRPL accounts, over one ephemeral
 * WebSocket per call (browsers cannot reach XRPL JSON-RPC — no CORS).
 * Per address: `account_info` for the XRP balance plus one `account_lines`
 * per unique issuer (the `peer` filter keeps results under the page limit).
 * `actNotFound` means the account is not on-ledger → `funded: false`, all
 * zeros. XRP amounts are totals, not reserve-adjusted spendable balances.
 */
export async function fetchBalances(
  req: BalancesRequest,
  opts: BalancesFetchOptions,
): Promise<BalancesSnapshot> {
  const timestamp = () => Date.now();
  if (req.addresses.length === 0) {
    return { network: req.network, accounts: [], timestamp: timestamp() };
  }

  const issuers = [
    ...new Set(req.assets.flatMap((asset) => (asset.kind === 'issued' ? [asset.issuer] : []))),
  ];
  const requests: Record<string, unknown>[] = [];
  const plan = req.addresses.map((address) => {
    const infoIndex = requests.length;
    requests.push({ command: 'account_info', account: address, ledger_index: 'validated' });
    const linesIndex = new Map<string, number>();
    for (const issuer of issuers) {
      linesIndex.set(issuer, requests.length);
      requests.push({
        command: 'account_lines',
        account: address,
        peer: issuer,
        ledger_index: 'validated',
        limit: 400,
      });
    }
    return { address, infoIndex, linesIndex };
  });

  const url = opts.streamEndpoint ?? XRPL_WS_ENDPOINTS[req.network];
  const webSocket = opts.webSocket ?? globalThis.WebSocket;
  const outcomes = await wsRequestBatchSettled(webSocket, url, requests, opts.signal);

  const accounts: AccountBalances[] = plan.map(({ address, infoIndex, linesIndex }) => {
    const info = outcomes[infoIndex];
    if (info.error === 'actNotFound') {
      return {
        address,
        funded: false,
        balances: req.assets.map((asset) => ({ asset, amount: '0' })),
      };
    }
    if (!info.result) throw new Error(`XRPL account_info failed: ${info.error ?? 'unknown error'}`);
    const accountData = info.result.account_data as XrplAccountData | undefined;
    const xrpBalance =
      typeof accountData?.Balance === 'string' ? dropsToXrp(accountData.Balance) : '0';

    const balances: AssetBalance[] = req.assets.map((asset) => {
      if (asset.kind === 'native') return { asset, amount: xrpBalance };
      const lines = linesFor(outcomes[linesIndex.get(asset.issuer)!]);
      const currency = normalizeCurrency(asset.code);
      const line = lines.find((l) => l.account === asset.issuer && l.currency === currency);
      return { asset, amount: line?.balance ?? '0' };
    });
    return { address, funded: true, balances };
  });

  return { network: req.network, accounts, timestamp: timestamp() };
}

function linesFor(outcome: XrplBatchOutcome): XrplTrustLine[] {
  // A missing issuer account also reports actNotFound → no trustlines.
  if (outcome.error === 'actNotFound') return [];
  if (!outcome.result) {
    throw new Error(`XRPL account_lines failed: ${outcome.error ?? 'unknown error'}`);
  }
  const lines = outcome.result.lines;
  return Array.isArray(lines) ? (lines as XrplTrustLine[]) : [];
}
