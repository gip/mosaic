import { lazy, Suspense, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import AgentAddressCards from '../components/AgentAddresses';
import ChainSettingsModal from '../components/ChainSettingsModal';
import VaultDataModal from '../components/VaultDataModal';
import Banner from '../components/ui/Banner';
import StatusDot from '../components/ui/StatusDot';
import { useSession } from '../contexts/SessionContext';
import { useVaults, type VaultState } from '../contexts/VaultContext';
import { exportLatestVaultBackup } from '../zone/export';

const CreateVaultModal = lazy(() => import('../components/ZonePanel').then((module) => ({ default: module.CreateVaultModal })));

function date(value?: string): string {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Never';
}

export default function VaultsPage() {
  const { session } = useSession();
  const {
    vaults, activeVault, loading, error, metadataWarning, createAddress, setVaultChainEnabled, lockVault, refreshVaults,
  } = useVaults();
  const [createOpen, setCreateOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [chainModalZone, setChainModalZone] = useState<string | null>(null);
  const [dataModalZone, setDataModalZone] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const isOpen = (vault: VaultState) => expanded[vault.zone] ?? (activeVault?.zone === vault.zone);
  const toggle = (vault: VaultState) => setExpanded((current) => ({ ...current, [vault.zone]: !isOpen(vault) }));

  // Resolved from the list so the modal reflects toggles as soon as state updates.
  const chainModalVault = vaults.find(({ zone }) => zone === chainModalZone) ?? null;
  const dataModalVault = vaults.find(({ zone }) => zone === dataModalZone) ?? null;

  async function exportBackup(vault: VaultState) {
    if (!session) return;
    setExportError(null);
    try {
      await exportLatestVaultBackup({
        token: session.token,
        ref: { rootChain: session.chain, rootAddress: session.address, zone: vault.zone, network: session.network },
        commitment: vault.commitment,
        createdAt: vault.createdAt,
      });
    } catch (cause) { setExportError(cause instanceof Error ? cause.message : String(cause)); }
  }

  return (
    <section className="reading vaults-page">
      {!session ? (
        <div className="zone-card"><h3>Vaults</h3><p>Log in with your root wallet to view and manage vaults.</p></div>
      ) : (
        <>
          <div className="vault-page-head">
            <div><h2>Vaults</h2><p className="tile-note">Vault names are immutable because they participate in key derivation.</p></div>
            <div className="vault-page-actions">
              <button type="button" onClick={() => void refreshVaults()}>Refresh</button>
              <button type="button" onClick={() => setCreateOpen(true)}>Create vault</button>
            </div>
          </div>
          {error && <Banner tone="err">{error}</Banner>}
          {metadataWarning && <Banner tone="warn">{metadataWarning}</Banner>}
          {exportError && <Banner tone="err">{exportError}</Banner>}
          {loading && <p className="tile-note">Loading vaults…</p>}
          {!loading && vaults.length === 0 && <div className="zone-card"><h3>No vaults yet</h3><p>Create a vault to derive agent addresses for this wallet and network.</p><button type="button" onClick={() => setCreateOpen(true)}>Create vault</button></div>}
          <div className="vault-list">
            {vaults.map((vault) => {
              const open = isOpen(vault);
              return (
                <article className="zone-card vault-card" key={vault.zone}>
                  <button type="button" className="vault-toggle" aria-expanded={open} onClick={() => toggle(vault)}>
                    <ChevronRight size={16} strokeWidth={2} className={`chevron${open ? ' open' : ''}`} aria-hidden="true" />
                    <span className="vault-name mono">{vault.zone === 'default' ? 'Default' : vault.zone}</span>
                    <span className="vault-badges">
                      {activeVault?.zone === vault.zone && <span className="active-vault-badge">Active</span>}
                      <StatusDot tone={vault.status === 'unlocked' ? 'ok' : 'idle'}>{vault.status}</StatusDot>
                    </span>
                  </button>
                  {open && (
                    <div className="vault-body">
                      <dl className="vault-meta">
                        <div><dt>Created</dt><dd>{date(vault.createdAt)}</dd></div>
                        <div><dt>Last unlocked</dt><dd>{date(vault.lastUnlockedAt)}</dd></div>
                      </dl>
                      <div className="chain-summary">
                        <span>
                          <span className="tile-note">Chains </span>
                          {vault.chains.filter(({ enabled }) => enabled).map(({ name }) => name).join(' · ') || 'None enabled'}
                        </span>
                        <button type="button" className="btn-sm" onClick={() => setChainModalZone(vault.zone)}>
                          Change
                        </button>
                      </div>
                      <div className="vault-actions">
                        <button
                          type="button"
                          className="btn-sm"
                          disabled={vault.status === 'locked'}
                          title={vault.status === 'locked' ? 'Unlock this vault to view its stored data.' : undefined}
                          onClick={() => setDataModalZone(vault.zone)}
                        >
                          View stored data
                        </button>
                        <button type="button" className="btn-sm" onClick={() => void exportBackup(vault)}>Export latest encrypted backup</button>
                      </div>
                      {vault.status === 'locked' && <p className="tile-note">This vault is locked on this device. Unlock it from the vault switcher in the top bar.</p>}
                      {vault.status === 'unlocked' && vault.derivedAddresses && (
                        <AgentAddressCards
                          addresses={vault.derivedAddresses}
                          chains={vault.chains}
                          onCreate={(chain, name) => createAddress(vault.zone, chain, name)}
                        />
                      )}
                      {vault.status === 'unlocked' && (
                        <div className="vault-actions">
                          <button type="button" className="btn-sm" onClick={() => void lockVault(vault.zone)}>Lock vault on this device</button>
                        </div>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </>
      )}
      {createOpen && <Suspense fallback={null}><CreateVaultModal onClose={() => setCreateOpen(false)} /></Suspense>}
      {chainModalVault && (
        <ChainSettingsModal
          title={`Chains · ${chainModalVault.zone === 'default' ? 'Default' : chainModalVault.zone}`}
          description="Copied from your global settings when the vault was created; changes here affect only this vault."
          options={chainModalVault.chains.map((chain) => ({
            key: chain.chainKey,
            name: chain.name,
            note: chain.family.toUpperCase(),
            enabled: chain.enabled,
          }))}
          onToggle={(key, enabled) => setVaultChainEnabled(chainModalVault.zone, key, enabled)}
          onClose={() => setChainModalZone(null)}
        />
      )}
      {session && dataModalVault && (
        <VaultDataModal
          token={session.token}
          vaultRef={{
            rootChain: session.chain,
            rootAddress: session.address,
            zone: dataModalVault.zone,
            network: session.network,
          }}
          commitment={dataModalVault.commitment}
          registeredAddresses={dataModalVault.derivedAddresses ?? dataModalVault.addresses}
          onClose={() => setDataModalZone(null)}
        />
      )}
    </section>
  );
}
