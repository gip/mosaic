import { useState } from 'react';
import type { AssetTrustState } from '@mosaic/catalog';
import Banner from '../components/ui/Banner';
import { useCatalog } from '../contexts/CatalogContext';
import { useActiveChains } from '../hooks/useActiveChains';

const STATES: { id: AssetTrustState; label: string }[] = [
  { id: 'hidden', label: 'Hidden' },
  { id: 'review', label: 'Review' },
  { id: 'allowed', label: 'Allowed' },
];

function shortAddress(address: string): string {
  return address.length > 18 ? `${address.slice(0, 9)}…${address.slice(-7)}` : address;
}

export default function AssetsPage() {
  const { assets, loading, error, readOnly, setAssetState } = useCatalog();
  const { activeChains } = useActiveChains();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const chainNames = new Map(activeChains.map((chain) => [chain.id, chain.name]));
  // Deployments on hidden chains never render; an asset with none left disappears too.
  const visibleAssets = assets
    .map((asset) => ({ ...asset, deployments: asset.deployments.filter((item) => chainNames.has(item.chainId)) }))
    .filter((asset) => asset.deployments.length > 0);

  async function update(assetId: string, state: AssetTrustState) {
    setBusy(assetId);
    setActionError(null);
    try {
      await setAssetState(assetId, state);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="reading catalog-page">
      <h2>Assets</h2>
      <p className="catalog-intro">
        One asset can have native, issuer, or contract-backed deployments across several supported chains.
        Your preference controls where it appears in Mosaic selectors.
      </p>
      {readOnly && <Banner tone="info">Log in to manage asset preferences. Built-in defaults are shown.</Banner>}
      {error && <Banner tone="err">{error}</Banner>}
      {actionError && <Banner tone="err">{actionError}</Banner>}
      {loading && <p className="tile-note">Loading wallet preferences…</p>}
      <div className="catalog-list">
        {visibleAssets.map((asset) => (
          <article className="card catalog-card" key={asset.id}>
            <div className="catalog-card-head">
              <h3>{asset.name}</h3>
              <span className="pill">Built-in</span>
            </div>
            <div className="catalog-deployments">
              {asset.deployments.map((deployment) => (
                <div className="catalog-deployment" key={deployment.chainId}>
                  <strong>{chainNames.get(deployment.chainId) ?? deployment.chainId}</strong>
                  <span>{deployment.kind === 'native' ? `${deployment.symbol} · native` : `${deployment.symbol} · issued`}</span>
                  {deployment.address && (
                    <span className="mono" title={deployment.address}>
                      {shortAddress(deployment.address)}
                    </span>
                  )}
                </div>
              ))}
            </div>
            <div className="catalog-state-row">
              <span className="tile-note">Preference</span>
              <div className="segmented" aria-label={`${asset.name} preference`}>
                {STATES.map(({ id, label }) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={asset.trustState === id}
                    disabled={readOnly || busy === asset.id || asset.trustState === id}
                    onClick={() => void update(asset.id, id)}
                  >
                    {busy === asset.id && asset.trustState !== id ? '…' : label}
                  </button>
                ))}
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
