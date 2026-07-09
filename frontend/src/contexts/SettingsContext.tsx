import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Network } from '@mosaic/zone-keys';

const NETWORK_KEY = 'mosaic.network';

function loadNetwork(): Network {
  try {
    const saved = localStorage.getItem(NETWORK_KEY);
    if (saved === 'mainnet' || saved === 'testnet') return saved;
  } catch {
    /* storage unavailable */
  }
  return 'testnet';
}

interface SettingsValue {
  network: Network;
  setNetwork: (network: Network) => void;
}

const SettingsContext = createContext<SettingsValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [network, setNetworkState] = useState<Network>(loadNetwork);

  const setNetwork = useCallback((next: Network) => {
    setNetworkState(next);
    try {
      localStorage.setItem(NETWORK_KEY, next);
    } catch {
      /* storage unavailable */
    }
  }, []);

  const value = useMemo(() => ({ network, setNetwork }), [network, setNetwork]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSettings(): SettingsValue {
  const value = useContext(SettingsContext);
  if (!value) throw new Error('useSettings outside SettingsProvider');
  return value;
}
