import { useMemo } from 'react';
import type { ChainWithEnabled } from '@mosaic/catalog';
import type { AgentChain } from '@mosaic/zone-keys';
import { useCatalog } from '../contexts/CatalogContext';
import { useSettings } from '../contexts/SettingsContext';

interface EnabledChainsValue {
  /** Catalog chains the wallet has enabled, both networks. */
  enabledChains: ChainWithEnabled[];
  /** True when the family has at least one enabled chain on the current network. */
  isFamilyEnabled: (family: AgentChain) => boolean;
}

/**
 * Account-level chain support for everything outside the settings page: a
 * disabled chain renders nowhere else. Vault-scoped views (agent addresses,
 * balances) use the vault's own chain settings instead of this hook.
 */
export function useEnabledChains(): EnabledChainsValue {
  const { chains } = useCatalog();
  const { network } = useSettings();
  return useMemo(() => {
    const enabledChains = chains.filter((chain) => chain.enabled);
    const isFamilyEnabled = (family: AgentChain) =>
      enabledChains.some((chain) => chain.family === family && chain.network === network);
    return { enabledChains, isFamilyEnabled };
  }, [chains, network]);
}
