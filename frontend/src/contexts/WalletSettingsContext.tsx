import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type WalletSettingsResult } from '../api';
import { DEFAULT_LOCK_REMINDER_MINUTES } from '../lockReminderOptions';
import { useSession } from './SessionContext';

/** Backend-stored per-wallet settings. Defaults apply until a session loads them. */

interface WalletSettingsValue {
  /** 0 disables the Mainnet lock reminder. */
  lockReminderMinutes: number;
  chainSetupCompleted: boolean;
  loading: boolean;
  error: string | null;
  setLockReminderMinutes: (minutes: number) => Promise<void>;
  completeChainSetup: (enabledChainKeys: string[]) => Promise<void>;
  readOnly: boolean;
}

const DEFAULT_SETTINGS: WalletSettingsResult = {
  lockReminderMinutes: DEFAULT_LOCK_REMINDER_MINUTES,
  chainSetupCompleted: false,
};

const WalletSettingsContext = createContext<WalletSettingsValue | null>(null);

export function WalletSettingsProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedToken, setLoadedToken] = useState<string | null>(null);
  const token = session?.token;

  useEffect(() => {
    let stale = false;
    if (!token) {
      // Wallet settings are per-wallet; never carry them past logout.
      queueMicrotask(() => {
        if (!stale) {
          setSettings(DEFAULT_SETTINGS);
          setLoading(false);
          setError(null);
          setLoadedToken(null);
        }
      });
      return () => {
        stale = true;
      };
    }
    queueMicrotask(() => {
      if (!stale) {
        setLoading(true);
        setError(null);
      }
    });
    api.settingsGet(token)
      .then((loaded) => {
        if (!stale) setSettings(loaded);
      })
      .catch((cause: unknown) => {
        if (!stale) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!stale) {
          setLoading(false);
          setLoadedToken(token);
        }
      });
    return () => {
      stale = true;
    };
  }, [token]);

  const setLockReminderMinutes = useCallback(async (minutes: number) => {
    if (!token) throw new Error('Log in to change wallet settings.');
    setSettings(await api.settingsSet(token, { lockReminderMinutes: minutes }));
  }, [token]);

  const completeChainSetup = useCallback(async (enabledChainKeys: string[]) => {
    if (!token) throw new Error('Log in to choose supported chains.');
    const result = await api.chainSetupComplete(token, enabledChainKeys);
    setSettings(result.settings);
    setLoadedToken(token);
    setError(null);
  }, [token]);

  const value = useMemo(
    () => ({
      lockReminderMinutes: settings.lockReminderMinutes,
      chainSetupCompleted: settings.chainSetupCompleted,
      loading: loading || Boolean(token && loadedToken !== token),
      error,
      setLockReminderMinutes,
      completeChainSetup,
      readOnly: !session,
    }),
    [settings, loading, error, token, loadedToken, setLockReminderMinutes, completeChainSetup, session],
  );
  return <WalletSettingsContext.Provider value={value}>{children}</WalletSettingsContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useWalletSettings(): WalletSettingsValue {
  const value = useContext(WalletSettingsContext);
  if (!value) throw new Error('useWalletSettings outside WalletSettingsProvider');
  return value;
}
