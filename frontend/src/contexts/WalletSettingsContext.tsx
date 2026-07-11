import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type WalletSettingsResult } from '../api';
import { DEFAULT_LOCK_REMINDER_MINUTES } from '../lockReminderOptions';
import { useSession } from './SessionContext';

/** Backend-stored per-wallet settings. Defaults apply until a session loads them. */

interface WalletSettingsValue {
  /** 0 disables the Mainnet lock reminder. */
  lockReminderMinutes: number;
  setLockReminderMinutes: (minutes: number) => Promise<void>;
  /** Catalog chain ids hidden everywhere in the UI except settings. */
  hiddenChains: string[];
  setChainHidden: (chainId: string, hidden: boolean) => Promise<void>;
  readOnly: boolean;
}

const DEFAULT_SETTINGS: WalletSettingsResult = {
  lockReminderMinutes: DEFAULT_LOCK_REMINDER_MINUTES,
  hiddenChains: [],
};

const WalletSettingsContext = createContext<WalletSettingsValue | null>(null);

export function WalletSettingsProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const token = session?.token;

  useEffect(() => {
    let stale = false;
    if (!token) {
      // Wallet settings are per-wallet; never carry them past logout.
      queueMicrotask(() => {
        if (!stale) setSettings(DEFAULT_SETTINGS);
      });
      return () => {
        stale = true;
      };
    }
    api.settingsGet(token)
      .then((loaded) => {
        if (!stale) setSettings(loaded);
      })
      .catch(() => {
        /* defaults stay in effect; the next successful load corrects them */
      });
    return () => {
      stale = true;
    };
  }, [token]);

  const setLockReminderMinutes = useCallback(async (minutes: number) => {
    if (!token) throw new Error('Log in to change wallet settings.');
    setSettings(await api.settingsSet(token, { lockReminderMinutes: minutes }));
  }, [token]);

  const hiddenChains = settings.hiddenChains;

  const setChainHidden = useCallback(async (chainId: string, hidden: boolean) => {
    if (!token) throw new Error('Log in to change wallet settings.');
    const next = hidden
      ? [...hiddenChains, chainId]
      : hiddenChains.filter((id) => id !== chainId);
    setSettings(await api.settingsSet(token, { hiddenChains: next }));
  }, [token, hiddenChains]);

  const value = useMemo(
    () => ({
      lockReminderMinutes: settings.lockReminderMinutes,
      setLockReminderMinutes,
      hiddenChains,
      setChainHidden,
      readOnly: !session,
    }),
    [settings.lockReminderMinutes, setLockReminderMinutes, hiddenChains, setChainHidden, session],
  );
  return <WalletSettingsContext.Provider value={value}>{children}</WalletSettingsContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useWalletSettings(): WalletSettingsValue {
  const value = useContext(WalletSettingsContext);
  if (!value) throw new Error('useWalletSettings outside WalletSettingsProvider');
  return value;
}
