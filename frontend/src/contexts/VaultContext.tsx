import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AgentChain, ZoneRef } from '@mosaic/zone-keys';
import { api, type ZoneListItem } from '../api';
import { dropCachedZoneSecret } from '../zone/cache';
import { unlockFromCache, type DerivedVaultAddress } from '../zone/unlock';
import { useSession } from './SessionContext';

export interface VaultState extends ZoneListItem {
  status: 'locked' | 'unlocked';
  derivedAddresses?: DerivedVaultAddress[];
}

interface VaultValue {
  vaults: VaultState[];
  activeVault: VaultState | null;
  loading: boolean;
  error: string | null;
  metadataWarning: string | null;
  selectVault: (zone: string) => void;
  refreshVaults: () => Promise<void>;
  registerCreated: (zone: string) => Promise<void>;
  markUnlocked: (zone: string, addresses: DerivedVaultAddress[]) => Promise<void>;
  createAddress: (zone: string, chain: AgentChain, name?: string) => Promise<void>;
  lockVault: (zone: string) => Promise<void>;
}

const VaultContext = createContext<VaultValue | null>(null);
const ACTIVE_PREFIX = 'mosaic.active-vault';

function activeKey(chain: string, address: string, network: string): string {
  return `${ACTIVE_PREFIX}|${chain}|${address}|${network}`;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const [vaults, setVaults] = useState<VaultState[]>([]);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [metadataWarning, setMetadataWarning] = useState<string | null>(null);
  const loadSequence = useRef(0);

  const reportUnlocked = useCallback(async (zone: string) => {
    if (!session) return;
    try {
      const result = await api.zoneUnlocked(session.token, zone);
      setVaults((current) => current.map((vault) => (
        vault.zone === zone ? { ...vault, lastUnlockedAt: result.lastUnlockedAt } : vault
      )));
      setMetadataWarning(null);
    } catch (cause) {
      setMetadataWarning(`Vault unlocked, but its activity time could not be synced: ${message(cause)}`);
    }
  }, [session]);

  const refreshVaults = useCallback(async () => {
    const sequence = ++loadSequence.current;
    if (!session) {
      setVaults([]);
      setActiveName(null);
      setLoading(false);
      setError(null);
      setMetadataWarning(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const items = await api.zoneList(session.token);
      const states = await Promise.all(items.map(async (item): Promise<VaultState> => {
        const ref: ZoneRef = {
          rootChain: session.chain,
          rootAddress: session.address,
          zone: item.zone,
          network: session.network,
        };
        const cached = await unlockFromCache(ref, item.commitment, item.addresses);
        if (cached) {
          void reportUnlocked(item.zone);
          return { ...item, status: 'unlocked', derivedAddresses: cached.addresses };
        }
        return { ...item, status: 'locked' };
      }));
      if (sequence !== loadSequence.current) return;
      setVaults(states);
      const key = activeKey(session.chain, session.address, session.network);
      let saved: string | null = null;
      try { saved = localStorage.getItem(key); } catch { /* local state remains memory-only */ }
      const selected = states.some(({ zone }) => zone === saved) ? saved : (states[0]?.zone ?? null);
      setActiveName(selected);
      if (selected) {
        try { localStorage.setItem(key, selected); } catch { /* best effort */ }
      }
    } catch (cause) {
      if (sequence !== loadSequence.current) return;
      setError(message(cause));
      setVaults([]);
      setActiveName(null);
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [reportUnlocked, session]);

  useEffect(() => { queueMicrotask(() => void refreshVaults()); }, [refreshVaults]);

  const selectVault = useCallback((zone: string) => {
    if (!session) return;
    setActiveName(zone);
    try { localStorage.setItem(activeKey(session.chain, session.address, session.network), zone); } catch { /* best effort */ }
  }, [session]);

  const markUnlocked = useCallback(async (zone: string, addresses: DerivedVaultAddress[]) => {
    setVaults((current) => current.map((vault) => (
      vault.zone === zone ? { ...vault, status: 'unlocked', derivedAddresses: addresses } : vault
    )));
    await reportUnlocked(zone);
  }, [reportUnlocked]);

  const registerCreated = useCallback(async (zone: string) => {
    await refreshVaults();
    selectVault(zone);
    await reportUnlocked(zone);
  }, [refreshVaults, reportUnlocked, selectVault]);

  const createAddress = useCallback(async (zone: string, chain: AgentChain, name?: string) => {
    if (!session) return;
    await api.zoneAddressCreate(session.token, zone, chain, name);
    await refreshVaults();
  }, [refreshVaults, session]);

  const lockVault = useCallback(async (zone: string) => {
    if (!session) return;
    const ref: ZoneRef = { rootChain: session.chain, rootAddress: session.address, zone, network: session.network };
    await dropCachedZoneSecret(ref);
    setVaults((current) => current.map((vault) => (
      vault.zone === zone ? { ...vault, status: 'locked', derivedAddresses: undefined } : vault
    )));
  }, [session]);

  const activeVault = vaults.find(({ zone }) => zone === activeName) ?? null;
  const value = useMemo(() => ({
    vaults, activeVault, loading, error, metadataWarning, selectVault, refreshVaults,
    registerCreated, markUnlocked, createAddress, lockVault,
  }), [vaults, activeVault, loading, error, metadataWarning, selectVault, refreshVaults, registerCreated, markUnlocked, createAddress, lockVault]);
  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useVaults(): VaultValue {
  const value = useContext(VaultContext);
  if (!value) throw new Error('useVaults outside VaultProvider');
  return value;
}
