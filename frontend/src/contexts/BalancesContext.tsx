import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AgentChain } from '@mosaic/zone-keys';
import { deploymentFor } from '@mosaic/catalog';
import { addDecimals } from '@mosaic/chain-core';
import type {
  AccountBalances,
  BalancesRequest,
  BalancesSnapshot,
  FeedStatus,
  KnownAsset,
} from '@mosaic/chain-core';
import { loadChainModule } from '../chains/load';
import { useCatalog } from './CatalogContext';
import { useSettings } from './SettingsContext';
import { useVaults } from './VaultContext';

const FAMILIES: readonly AgentChain[] = ['xrpl', 'stellar', 'evm'];

export interface AssetTotal {
  asset: KnownAsset;
  /** Decimal string: sum across all unlocked-vault addresses of the family. */
  amount: string;
}

export interface FamilyBalances {
  chain: AgentChain;
  /** Catalog display name of the active chain (e.g. "XRPL Testnet"). */
  label: string;
  /** null until the first snapshot arrives; last-good totals survive errors. */
  totals: AssetTotal[] | null;
  status: FeedStatus;
  error: string | null;
}

interface FamilyConfig {
  chain: AgentChain;
  label: string;
  request: BalancesRequest;
}

interface FamilyState {
  snapshot: BalancesSnapshot | null;
  status: FeedStatus;
  error: string | null;
}

interface BalancesValue {
  /** Per-family aggregates for the strip, ordered xrpl / stellar / evm. */
  families: FamilyBalances[];
  /** Per-account balances for an unlocked-vault address, null until fetched. */
  accountBalances: (chain: AgentChain, address: string) => AccountBalances | null;
}

const BalancesContext = createContext<BalancesValue | null>(null);

/**
 * One polling balances feed per chain family, covering the trusted assets and
 * every unlocked-vault address whose vault enables the family. Feeds restart
 * when the derived request changes — vault unlock/lock, network switch, asset
 * trust edits, vault chain toggles — via the same stringified-request effect
 * key the dex hooks use. Hosted as a context so the header strip and the
 * per-address views share one set of feeds instead of polling the chains twice.
 */
export function BalancesProvider({ children }: { children: ReactNode }) {
  const { vaults } = useVaults();
  const { assets, chains } = useCatalog();
  const { network } = useSettings();
  const [state, setState] = useState<Partial<Record<AgentChain, FamilyState>>>({});

  const configs = useMemo((): FamilyConfig[] => {
    const unlocked = vaults.filter((vault) => vault.status === 'unlocked');
    const out: FamilyConfig[] = [];
    for (const family of FAMILIES) {
      // Balances are vault-scoped: a family runs when any unlocked vault
      // enables it, regardless of the account-level chain settings.
      const chain = chains.find((c) => c.family === family && c.network === network);
      if (!chain) continue;
      const enabledVaults = unlocked.filter((vault) =>
        vault.chains.some((setting) => setting.family === family && setting.enabled),
      );
      const addresses = [
        ...new Set(
          enabledVaults.flatMap((vault) =>
            (vault.derivedAddresses ?? [])
              .filter((entry) => entry.chain === family)
              .map((entry) => entry.address),
          ),
        ),
      ];
      if (addresses.length === 0) continue;
      const known: KnownAsset[] = [];
      for (const asset of assets) {
        if (asset.trustState !== 'allowed') continue;
        const deployment = deploymentFor(asset, chain.id);
        if (!deployment) continue;
        if (deployment.kind === 'native') {
          known.push({ symbol: deployment.symbol, kind: 'native' });
        } else if (deployment.address) {
          known.push({
            symbol: deployment.symbol,
            kind: 'issued',
            code: deployment.symbol,
            issuer: deployment.address,
          });
        }
      }
      if (known.length === 0) continue;
      out.push({ chain: family, label: chain.name, request: { network, addresses, assets: known } });
    }
    return out;
  }, [chains, assets, network, vaults]);

  // Plain data built with deterministic property order above, so equal
  // configurations produce identical keys and do not churn the feeds.
  const configsKey = JSON.stringify(configs);

  // Reset stale balances as soon as the configuration changes
  // (state-during-render pattern, same as useOrderBookFeed).
  const [prevKey, setPrevKey] = useState(configsKey);
  if (prevKey !== configsKey) {
    setPrevKey(configsKey);
    setState({});
  }

  useEffect(() => {
    const parsed = JSON.parse(configsKey) as FamilyConfig[];
    if (parsed.length === 0) return;
    let cancelled = false;
    const cleanups: (() => void)[] = [];

    const update = (chain: AgentChain, patch: Partial<FamilyState>) => {
      setState((current) => ({
        ...current,
        [chain]: { snapshot: null, status: 'idle', error: null, ...current[chain], ...patch },
      }));
    };

    for (const { chain, request } of parsed) {
      void (async () => {
        try {
          const { createBalancesFeed } = await loadChainModule(chain);
          const feed = createBalancesFeed(request);
          const unsubscribe = feed.subscribe((event) => {
            if (event.type === 'balances') {
              update(chain, { snapshot: event.balances, error: null });
            } else if (event.type === 'status') {
              update(chain, { status: event.status });
            } else {
              update(chain, { error: event.error.message });
            }
          });
          if (cancelled) {
            unsubscribe();
            feed.stop();
            return;
          }
          cleanups.push(() => {
            unsubscribe();
            feed.stop();
          });
          feed.start();
        } catch (err) {
          if (!cancelled) {
            update(chain, { error: err instanceof Error ? err.message : String(err) });
          }
        }
      })();
    }

    return () => {
      cancelled = true;
      for (const cleanup of cleanups) cleanup();
    };
  }, [configsKey]);

  const families = useMemo(
    () =>
      configs.map(({ chain, label, request }): FamilyBalances => {
        const familyState = state[chain];
        return {
          chain,
          label,
          totals: familyState?.snapshot ? sumTotals(request.assets, familyState.snapshot) : null,
          status: familyState?.status ?? 'connecting',
          error: familyState?.error ?? null,
        };
      }),
    [configs, state],
  );

  const accounts = useMemo(() => {
    const map = new Map<string, AccountBalances>();
    for (const family of FAMILIES) {
      const snapshot = state[family]?.snapshot;
      if (!snapshot) continue;
      for (const account of snapshot.accounts) map.set(`${family}|${account.address}`, account);
    }
    return map;
  }, [state]);

  const accountBalances = useCallback(
    (chain: AgentChain, address: string) => accounts.get(`${chain}|${address}`) ?? null,
    [accounts],
  );

  const value = useMemo(() => ({ families, accountBalances }), [families, accountBalances]);
  return <BalancesContext.Provider value={value}>{children}</BalancesContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useBalances(): BalancesValue {
  const value = useContext(BalancesContext);
  if (!value) throw new Error('useBalances outside BalancesProvider');
  return value;
}

function sumTotals(assets: KnownAsset[], snapshot: BalancesSnapshot): AssetTotal[] {
  return assets.map((asset, index) => ({
    asset,
    amount: snapshot.accounts.reduce(
      (sum, account) => addDecimals(sum, account.balances[index]?.amount ?? '0'),
      '0',
    ),
  }));
}
