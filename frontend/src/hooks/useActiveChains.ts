import { useMemo } from 'react';
import type { ChainWithTrust } from '@mosaic/catalog';
import type { AgentChain } from '@mosaic/zone-keys';
import { useCatalog } from '../contexts/CatalogContext';
import { useSettings } from '../contexts/SettingsContext';
import { useWalletSettings } from '../contexts/WalletSettingsContext';

interface ActiveChainsValue {
  /** Catalog chains minus the wallet's hidden chains, both networks. */
  activeChains: ChainWithTrust[];
  /** True when the family has at least one active chain on the current network. */
  isFamilyActive: (family: AgentChain) => boolean;
}

/**
 * Chain visibility for everything outside the settings page: a chain hidden
 * in wallet settings renders nowhere else, including the agent address group
 * of a family whose chains are all hidden on the current network.
 */
export function useActiveChains(): ActiveChainsValue {
  const { chains } = useCatalog();
  const { hiddenChains } = useWalletSettings();
  const { network } = useSettings();
  return useMemo(() => {
    const activeChains = chains.filter((chain) => !hiddenChains.includes(chain.id));
    const isFamilyActive = (family: AgentChain) =>
      activeChains.some((chain) => chain.family === family && chain.network === network);
    return { activeChains, isFamilyActive };
  }, [chains, hiddenChains, network]);
}
