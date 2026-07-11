import { useState } from 'react';
import type { Network } from '@mosaic/zone-keys';
import Banner from '../components/ui/Banner';
import { useSession } from '../contexts/SessionContext';
import { useSettings } from '../contexts/SettingsContext';
import { useCatalog } from '../contexts/CatalogContext';

const NETWORKS: { id: Network; label: string; sub: string }[] = [
  { id: 'mainnet', label: 'Mainnet', sub: 'Base · XRPL · Stellar pubnet' },
  { id: 'testnet', label: 'Testnet', sub: 'Base Sepolia · XRPL testnet · Stellar testnet' },
];

export default function SettingsPage() {
  const { network, setNetwork } = useSettings();
  const { session } = useSession();
  const { chains, error, loading, readOnly, setChainTrusted } = useCatalog();
  const [actionError, setActionError] = useState<string | null>(null);

  async function updateChain(chainId: string, trusted: boolean) {
    setActionError(null);
    try {
      await setChainTrusted(chainId, trusted);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <section className="reading">
      <h2>Settings</h2>
      <div className="zone-card">
        <h3>Network</h3>
        <p>
          The network is a derivation input: each network has its own zone and its own agent addresses.
          Sessions are network-bound, so switching logs you out.
        </p>
        <div className="network-toggle">
          {NETWORKS.map(({ id, label, sub }) => (
            <label key={id} className={`network-option${network === id ? ' selected' : ''}`}>
              <input
                type="radio"
                name="network"
                value={id}
                checked={network === id}
                onChange={() => setNetwork(id)}
              />
              <span>
                <strong>{label}</strong>
                <span className="tile-note">{sub}</span>
              </span>
            </label>
          ))}
        </div>
        {session && session.network !== network && (
          <Banner tone="info">Network changed — you have been logged out. Log in again to continue.</Banner>
        )}
      </div>
      <div className="zone-card catalog-settings">
        <h3>Supported chains</h3>
        <p>
          Chain trust controls catalog-driven selectors. It does not change the derivation network or existing zones.
        </p>
        {readOnly && <Banner tone="info">Log in to manage chain trust. Built-in defaults are shown.</Banner>}
        {error && <Banner tone="err">{error}</Banner>}
        {actionError && <Banner tone="err">{actionError}</Banner>}
        {loading && <span className="tile-note">Loading wallet preferences…</span>}
        {(['mainnet', 'testnet'] as const).map((tag) => (
          <div className="chain-group" key={tag}>
            <h4>{tag === 'mainnet' ? 'Mainnet' : 'Testnet'}</h4>
            {chains.filter((chain) => chain.network === tag).map((chain) => (
              <label className="chain-trust-row" key={chain.id}>
                <span>
                  <strong>{chain.name}</strong>
                  <span className="tile-note">
                    {chain.family.toUpperCase()}{chain.source === 'database' ? ' · custom' : ''}
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={chain.trusted}
                  disabled={readOnly}
                  onChange={(event) => void updateChain(chain.id, event.target.checked)}
                />
              </label>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
