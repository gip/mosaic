import { useMemo, useState } from 'react';
import type { Network } from '@mosaic/zone-keys';
import Banner from '../components/ui/Banner';
import ChainSettingsModal from '../components/ChainSettingsModal';
import { useSettings } from '../contexts/SettingsContext';
import { useSession } from '../contexts/SessionContext';
import { useCatalog } from '../contexts/CatalogContext';
import { useWalletSettings } from '../contexts/WalletSettingsContext';
import { LOCK_REMINDER_OPTIONS } from '../lockReminderOptions';

const NETWORKS: { id: Network; label: string; sub: string }[] = [
  { id: 'mainnet', label: 'Mainnet', sub: 'XRPL · Stellar pubnet · Base' },
  { id: 'testnet', label: 'Testnet', sub: 'XRPL testnet · Stellar testnet · Base Sepolia' },
];

export default function SettingsPage() {
  const { network, setNetwork } = useSettings();
  const { session } = useSession();
  const { chains, error, loading, readOnly, setChainEnabled } = useCatalog();
  const { lockReminderMinutes, setLockReminderMinutes, readOnly: lockReadOnly } = useWalletSettings();
  const [chainsOpen, setChainsOpen] = useState(false);
  const [lockError, setLockError] = useState<string | null>(null);

  // One row per logical chain: the network variants share a chainKey and
  // always carry the same enabled flag; custom chains are single-network.
  const chainGroups = useMemo(() => {
    const byKey = new Map<string, typeof chains>();
    for (const chain of chains) {
      const group = byKey.get(chain.chainKey);
      if (group) group.push(chain);
      else byKey.set(chain.chainKey, [chain]);
    }
    return [...byKey.entries()].map(([chainKey, variants]) => ({
      chainKey,
      name: (variants.find(({ network: tag }) => tag === 'mainnet') ?? variants[0]!).name,
      family: variants[0]!.family,
      source: variants[0]!.source,
      networks: variants.map(({ network: tag }) => tag),
      enabled: variants.every(({ enabled }) => enabled),
    }));
  }, [chains]);

  const chainOptions = chainGroups.map((group) => {
    const enabledFamilyGroups = chainGroups.filter((peer) => peer.family === group.family && peer.enabled);
    // The root wallet's family always keeps one enabled chain (the server also enforces this per network).
    const loginLocked = session?.chain === group.family && group.enabled && enabledFamilyGroups.length <= 1;
    return {
      key: group.chainKey,
      name: group.name,
      note: `${group.family.toUpperCase()}${group.source === 'database' ? ' · custom' : ''}${
        group.networks.length === 1 ? ` · ${group.networks[0]} only` : ''}`,
      enabled: group.enabled,
      lockedReason: loginLocked ? 'The chain you logged in with cannot be disabled.' : undefined,
    };
  });
  const enabledNames = chainGroups.filter(({ enabled }) => enabled).map(({ name }) => name);

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
          Disabled chains are hidden everywhere in Mosaic. A toggle applies to both Mainnet and Testnet;
          new vaults copy these settings at creation, and existing vaults keep their own.
        </p>
        {readOnly && <Banner tone="info">Log in to manage supported chains. Built-in defaults are shown.</Banner>}
        {error && <Banner tone="err">{error}</Banner>}
        {loading && <span className="tile-note">Loading wallet preferences…</span>}
        <div className="chain-summary">
          <span>{enabledNames.length > 0 ? enabledNames.join(' · ') : 'No chains enabled'}</span>
          <button type="button" className="btn-sm" disabled={readOnly} onClick={() => setChainsOpen(true)}>
            Change
          </button>
        </div>
      </div>
      {chainsOpen && (
        <ChainSettingsModal
          title="Supported chains"
          description="A toggle applies to both Mainnet and Testnet. The chain you logged in with cannot be disabled. New vaults copy these settings; existing vaults keep their own."
          options={chainOptions}
          onToggle={setChainEnabled}
          onClose={() => setChainsOpen(false)}
        />
      )}
    </div>
  );
}
