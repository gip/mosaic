import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ZoneMessage } from '@mosaic/zone-keys';
import type { SignedZoneMessage } from '@mosaic/web-connector/types';
import type { Eip1193Provider } from '@mosaic/web-connector/evm';
import type { StellarWalletConnectSession } from '@mosaic/web-connector/stellar';
import { api, type AuthVerifyResult } from '../api';
import { useSettings } from './SettingsContext';
import { clearZoneCache } from '../zone/cache';

/**
 * The authenticated root-wallet session. The signer handle is memory-only —
 * after a reload, EVM extensions and Freighter reconnect lazily on the next
 * signature; a WalletConnect signer needs a fresh pairing (user re-login).
 */

export type RootSigner =
  | { kind: 'evm'; provider: Eip1193Provider }
  | { kind: 'stellar-freighter' }
  | { kind: 'stellar-wc'; wcSession: StellarWalletConnectSession }
  | { kind: 'xrpl' };

const SESSION_KEY = 'mosaic.session';

interface SessionValue {
  session: AuthVerifyResult | null;
  login: (session: AuthVerifyResult, signer: RootSigner) => void;
  logout: () => Promise<void>;
  networkSwitching: boolean;
  networkSwitchError: string | null;
  /**
   * Sign a canonical zone message with the root wallet (EVM/Stellar only —
   * XRPL signs via server-created Xaman payloads).
   */
  signZoneMessage: (message: ZoneMessage) => Promise<SignedZoneMessage>;
}

const SessionContext = createContext<SessionValue | null>(null);

function loadStoredSession(): AuthVerifyResult | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthVerifyResult;
    if (!parsed.token || !parsed.address || parsed.expiresAt < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const { network } = useSettings();
  const [session, setSession] = useState<AuthVerifyResult | null>(loadStoredSession);
  const signerRef = useRef<RootSigner | null>(null);
  const switchingRef = useRef(false);
  const [networkSwitching, setNetworkSwitching] = useState(false);
  const [networkSwitchError, setNetworkSwitchError] = useState<string | null>(null);

  // Canonical session signatures remain network-bound. A valid live session
  // can be exchanged server-side for the same wallet on another network.
  useEffect(() => {
    if (!session || session.network === network || switchingRef.current) return;
    switchingRef.current = true;
    queueMicrotask(() => {
      setNetworkSwitching(true);
      setNetworkSwitchError(null);
      void api.authNetworkSwitch(session.token, network).then((next) => {
        try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(next)); } catch { /* memory-only */ }
        setSession(next);
      }).catch((cause: unknown) => {
        setNetworkSwitchError(cause instanceof Error ? cause.message : String(cause));
      }).finally(() => {
        switchingRef.current = false;
        setNetworkSwitching(false);
      });
    });
  }, [network, session]);

  const login = useCallback((next: AuthVerifyResult, signer: RootSigner) => {
    signerRef.current = signer;
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable — session stays memory-only */
    }
    setSession(next);
  }, []);

  const logout = useCallback(async () => {
    const current = session;
    signerRef.current = null;
    sessionStorage.removeItem(SESSION_KEY);
    setSession(null);
    await clearZoneCache();
    if (current) await api.authLogout(current.token).catch(() => {});
  }, [session]);

  const signZoneMessage = useCallback(
    async (message: ZoneMessage): Promise<SignedZoneMessage> => {
      if (!session) throw new Error('not logged in');
      let signer = signerRef.current;

      if (!signer) {
        // Reconnect after a reload for extension wallets.
        if (session.chain === 'evm') {
          const { discoverEvmExtensions, requestEvmAccount } = await import('@mosaic/web-connector/evm');
          const details = await discoverEvmExtensions();
          for (const detail of details) {
            try {
              const address = await requestEvmAccount(detail.provider);
              if (address.toLowerCase() === session.address.toLowerCase()) {
                signer = { kind: 'evm', provider: detail.provider };
                break;
              }
            } catch {
              /* user rejected or wallet locked — try the next one */
            }
          }
          if (!signer) throw new Error(`Reconnect your EVM wallet with account ${session.address} and retry.`);
        } else if (session.chain === 'stellar') {
          signer = { kind: 'stellar-freighter' };
        } else {
          signer = { kind: 'xrpl' };
        }
        signerRef.current = signer;
      }

      switch (signer.kind) {
        case 'evm': {
          const { signEvmZoneMessage } = await import('@mosaic/web-connector/evm');
          return signEvmZoneMessage(signer.provider, session.address, message, session.network);
        }
        case 'stellar-freighter': {
          const { signStellarZoneMessageWithFreighter } = await import('@mosaic/web-connector/stellar');
          return signStellarZoneMessageWithFreighter(session.address, message, session.network);
        }
        case 'stellar-wc':
          return signer.wcSession.signZoneMessage(message);
        case 'xrpl':
          throw new Error('XRPL signatures go through Xaman payloads, not signZoneMessage');
      }
    },
    [session],
  );

  const value = useMemo(
    () => ({ session, login, logout, networkSwitching, networkSwitchError, signZoneMessage }),
    [session, login, logout, networkSwitching, networkSwitchError, signZoneMessage],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession outside SessionProvider');
  return value;
}
