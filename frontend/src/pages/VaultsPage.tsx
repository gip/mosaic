import { lazy, Suspense, useState } from 'react';
import AgentAddressCards from '../components/AgentAddresses';
import Banner from '../components/ui/Banner';
import StatusDot from '../components/ui/StatusDot';
import { useSession } from '../contexts/SessionContext';
import { useVaults, type VaultState } from '../contexts/VaultContext';

const CreateVaultModal = lazy(() => import('../components/ZonePanel').then((module) => ({ default: module.CreateVaultModal })));
const PairTestnetVaultModal = lazy(() => import('../components/ZonePanel').then((module) => ({ default: module.PairTestnetVaultModal })));

function date(value?: string): string {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Never';
}

export default function VaultsPage() {
  const { session } = useSession();
  const { vaults, activeVault, loading, error, metadataWarning, createAddress, lockVault, refreshVaults } = useVaults();
  const [createOpen, setCreateOpen] = useState(false);
  const [pairVault, setPairVault] = useState<VaultState | null>(null);

  if (!session) return <div className="zone-card"><h3>Vaults</h3><p>Log in with your root wallet to view and manage vaults.</p></div>;
  return (
    <>
      <div className="vault-page-head">
        <div><h3>Vaults</h3><p className="tile-note">Vault names are immutable because they participate in key derivation.</p></div>
        <div className="vault-page-actions">
          <button type="button" className="btn-ghost btn-sm" onClick={() => void refreshVaults()}>Refresh</button>
          <button type="button" className="btn-primary" onClick={() => setCreateOpen(true)}>Create vault</button>
        </div>
      </div>
      {error && <Banner tone="err">{error}</Banner>}
      {metadataWarning && <Banner tone="warn">{metadataWarning}</Banner>}
      {loading && <p className="tile-note">Loading vaults…</p>}
      {!loading && vaults.length === 0 && <div className="zone-card"><h3>No vaults yet</h3><p>Create a vault to derive agent addresses for this wallet and network.</p><button type="button" className="btn-primary" onClick={() => setCreateOpen(true)}>Create vault</button></div>}
      <div className="vault-list">
        {vaults.map((vault) => (
          <article className="zone-card vault-card" key={vault.zone}>
            <div className="vault-card-head">
              <div><h3 className="mono">{vault.zone === 'default' ? 'Default' : vault.zone}</h3><span className="tile-note">Created {date(vault.createdAt)}</span></div>
              <div className="vault-badges">
                {activeVault?.zone === vault.zone && <span className="active-vault-badge">Active</span>}
                <StatusDot tone={vault.status === 'unlocked' ? 'ok' : 'idle'}>{vault.status}</StatusDot>
              </div>
            </div>
            <dl className="vault-meta"><div><dt>Last unlocked</dt><dd>{date(vault.lastUnlockedAt)}</dd></div></dl>
            {vault.status === 'unlocked' && vault.derivedAddresses && <AgentAddressCards addresses={vault.derivedAddresses} onCreate={(chain, name) => createAddress(vault.zone, chain, name)} />}
            {vault.status === 'unlocked' && <button type="button" className="btn-ghost btn-sm vault-lock" onClick={() => void lockVault(vault.zone)}>Lock vault on this device</button>}
            {vault.mode === 'testnet-device' && vault.status === 'unlocked' && <button type="button" className="btn-ghost btn-sm vault-lock" onClick={() => setPairVault(vault)}>Pair another device</button>}
          </article>
        ))}
      </div>
      {createOpen && <Suspense fallback={null}><CreateVaultModal onClose={() => setCreateOpen(false)} /></Suspense>}
      {pairVault && <Suspense fallback={null}><PairTestnetVaultModal vault={pairVault} onClose={() => setPairVault(null)} /></Suspense>}
    </>
  );
}
