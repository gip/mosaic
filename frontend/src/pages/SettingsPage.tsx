import { useState } from 'react';
import type { Network } from '@mosaic/zone-keys';
import Banner from '../components/ui/Banner';
import { useSettings } from '../contexts/SettingsContext';
import { useSession } from '../contexts/SessionContext';
import { useCatalog } from '../contexts/CatalogContext';
import { useWalletSettings } from '../contexts/WalletSettingsContext';
import { LOCK_REMINDER_OPTIONS } from '../lockReminderOptions';

const NETWORKS: { id: Network; label: string; sub: string }[] = [
  { id: 'mainnet', label: 'Mainnet', sub: 'Base · XRPL · Stellar pubnet' },
  { id: 'testnet', label: 'Testnet', sub: 'Base Sepolia · XRPL testnet · Stellar testnet' },
];

export default function SettingsPage() {
  const { network, setNetwork } = useSettings();
  const { session } = useSession();
  const { chains, error, loading, readOnly, setChainTrusted } = useCatalog();
  const {
    lockReminderMinutes, setLockReminderMinutes, hiddenChains, setChainHidden, readOnly: lockReadOnly,
  } = useWalletSettings();
  const [actionError, setActionError] = useState<string | null>(null);
  const [lockError, setLockError] = useState<string | null>(null);

  async function updateChain(chainId: string, trusted: boolean) {
    setActionError(null);
    try {
      await setChainTrusted(chainId, trusted);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function updateChainActive(chainId: string, active: boolean) {
    setActionError(null);
    try {
      await setChainHidden(chainId, !active);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function updateLockReminder(minutes: number) {
    setLockError(null);
    try {
      await setLockReminderMinutes(minutes);
    } catch (cause) {
      setLockError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div className="settings-general">
      <div className="zone-card">
        <h3>Network</h3>
        <p>
          The network is a derivation input: each network has its own vaults and agent addresses.
          Your authenticated wallet session follows the selected network without another login.
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
      </div>
      <div className="zone-card">
        <h3>Mainnet auto-lock reminder</h3>
        <p>
          After this long on Testnet — or of inactivity on Mainnet — Mosaic offers to lock the Mainnet vaults
          that are unlocked on this device. If the reminder gets no response within 60 seconds, they lock automatically.
        </p>
        <label className="lock-reminder-field">
          Remind after
          <select
            aria-label="Lock reminder interval"
            value={lockReminderMinutes}
            disabled={lockReadOnly}
            onChange={(event) => void updateLockReminder(Number(event.target.value))}
          >
            {LOCK_REMINDER_OPTIONS.map(({ minutes, label }) => (
              <option value={minutes} key={minutes}>{label}</option>
            ))}
          </select>
        </label>
        {lockReadOnly && <Banner tone="info">Log in to change this setting. It is stored with your wallet.</Banner>}
        {lockError && <Banner tone="err">{lockError}</Banner>}
      </div>
      <div className="zone-card catalog-settings">
        <h3>Supported chains</h3>
        <p>
          Inactive chains are hidden everywhere in Mosaic except here. Chain trust controls catalog-driven
          selectors. Neither changes the derivation network or existing vaults.
        </p>
        {readOnly && <Banner tone="info">Log in to manage chain visibility and trust. Built-in defaults are shown.</Banner>}
        {error && <Banner tone="err">{error}</Banner>}
        {actionError && <Banner tone="err">{actionError}</Banner>}
        {loading && <span className="tile-note">Loading wallet preferences…</span>}
        {(['mainnet', 'testnet'] as const).map((tag) => (
          <div className="chain-group" key={tag}>
            <h4>{tag === 'mainnet' ? 'Mainnet' : 'Testnet'}</h4>
            {chains.filter((chain) => chain.network === tag).map((chain) => {
              const hidden = hiddenChains.includes(chain.id);
              const activeFamilyPeers = chains.filter(
                (peer) => peer.network === tag && peer.family === chain.family && !hiddenChains.includes(peer.id),
              );
              // The root wallet's family always keeps one active chain per network.
              const loginLocked = session?.chain === chain.family && !hidden && activeFamilyPeers.length <= 1;
              return (
                <div className="chain-trust-row" key={chain.id}>
                  <span>
                    <strong>{chain.name}</strong>
                    <span className="tile-note">
                      {chain.family.toUpperCase()}{chain.source === 'database' ? ' · custom' : ''}{hidden ? ' · hidden' : ''}
                    </span>
                  </span>
                  <div className="chain-row-toggles">
                    <label title={loginLocked ? 'The chain you logged in with stays active.' : undefined}>
                      Active
                      <input
                        type="checkbox"
                        checked={!hidden}
                        disabled={lockReadOnly || loginLocked}
                        onChange={(event) => void updateChainActive(chain.id, event.target.checked)}
                      />
                    </label>
                    <label>
                      Trusted
                      <input
                        type="checkbox"
                        checked={chain.trusted}
                        disabled={readOnly}
                        onChange={(event) => void updateChain(chain.id, event.target.checked)}
                      />
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
