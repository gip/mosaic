import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  defaultCatalogSnapshot,
  type AssetTrustState,
  type CatalogSnapshot,
} from '@mosaic/catalog';
import { api } from '../api';
import { useSession } from './SessionContext';

interface CatalogValue extends CatalogSnapshot {
  loading: boolean;
  error: string | null;
  readOnly: boolean;
  refresh: () => Promise<void>;
  setChainTrusted: (chainId: string, trusted: boolean) => Promise<void>;
  setAssetState: (assetId: string, state: AssetTrustState) => Promise<void>;
}

const CatalogContext = createContext<CatalogValue | null>(null);

export function CatalogProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const [catalog, setCatalog] = useState<CatalogSnapshot>(defaultCatalogSnapshot);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!session) {
      setCatalog(defaultCatalogSnapshot());
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setCatalog(await api.catalogList(session.token));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    let active = true;
    if (!session) {
      queueMicrotask(() => {
        if (active) {
          setCatalog(defaultCatalogSnapshot());
          setError(null);
          setLoading(false);
        }
      });
      return () => {
        active = false;
      };
    }
    queueMicrotask(() => {
      if (active) {
        // A signed-in catalog is policy-bearing. Do not briefly reuse anonymous
        // defaults or a previous wallet's preferences while it loads.
        setCatalog({ chains: [], assets: [] });
        setError(null);
        setLoading(true);
      }
    });
    api
      .catalogList(session.token)
      .then((next) => {
        if (active) {
          setCatalog(next);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [session]);

  const setChainTrusted = useCallback(
    async (chainId: string, trusted: boolean) => {
      if (!session) throw new Error('Log in to change chain trust.');
      const updated = await api.chainTrustSet(session.token, chainId, trusted);
      setCatalog((current) => ({
        ...current,
        chains: current.chains.map((chain) => (chain.id === updated.id ? updated : chain)),
      }));
    },
    [session],
  );

  const setAssetState = useCallback(
    async (assetId: string, state: AssetTrustState) => {
      if (!session) throw new Error('Log in to change asset trust.');
      const updated = await api.assetTrustSet(session.token, assetId, state);
      setCatalog((current) => ({
        ...current,
        assets: current.assets.map((asset) => (asset.id === updated.id ? updated : asset)),
      }));
    },
    [session],
  );

  const value = useMemo(
    () => ({
      ...catalog,
      loading,
      error,
      readOnly: !session,
      refresh,
      setChainTrusted,
      setAssetState,
    }),
    [catalog, loading, error, session, refresh, setChainTrusted, setAssetState],
  );

  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useCatalog(): CatalogValue {
  const value = useContext(CatalogContext);
  if (!value) throw new Error('useCatalog outside CatalogProvider');
  return value;
}
