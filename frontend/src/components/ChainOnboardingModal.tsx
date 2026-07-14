import { useMemo, useState } from 'react';
import type { RootChain } from '@mosaic/zone-keys';
import Banner from './ui/Banner';
import Modal from './ui/Modal';
import { useCatalog } from '../contexts/CatalogContext';
import { useSession } from '../contexts/SessionContext';
import { useWalletSettings } from '../contexts/WalletSettingsContext';

const OPTIONS = [
  { key: 'xrpl', family: 'xrpl', name: 'XRPL', note: 'XRP Ledger · Mainnet and Testnet' },
  { key: 'stellar', family: 'stellar', name: 'Stellar', note: 'Stellar · Pubnet and Testnet' },
  { key: 'base', family: 'evm', name: 'EVM (Base)', note: 'Base and Base Sepolia' },
] as const;

function requiredKey(chain: RootChain): string {
  return OPTIONS.find((option) => option.family === chain)!.key;
}

export default function ChainOnboardingModal() {
  const { session, logout } = useSession();
  const { refresh } = useCatalog();
  const { completeChainSetup, error: loadError } = useWalletSettings();
  const required = requiredKey(session!.chain);
  const [selected, setSelected] = useState(() => new Set([required]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabled = useMemo(() => OPTIONS.filter(({ key }) => selected.has(key)).map(({ key }) => key), [selected]);

  function toggle(key: string, checked: boolean) {
    if (key === required) return;
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await completeChainSetup(enabled);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Choose chains for your agents" onClose={() => {}} dismissible={false}>
      <p>
        Start with the networks your agents will use. Your root-wallet chain stays enabled, and you can add
        others later in Settings or from an individual vault.
      </p>
      <p className="tile-note">
        Mosaic uses mobile wallets for approvals that enable and recover agents, so your root wallet remains
        reachable beyond a browser-extension-only session.
      </p>
      {loadError && <Banner tone="warn">Could not load saved chain setup: {loadError}. Saving below will retry.</Banner>}
      {error && <Banner tone="err">Could not save chain setup: {error}</Banner>}
      <div className="chain-group">
        {OPTIONS.map((option) => {
          const locked = option.key === required;
          return (
            <div className="chain-trust-row" key={option.key}>
              <span>
                <strong>{option.name}</strong>
                <span className="tile-note">{option.note}</span>
              </span>
              <div className="chain-row-toggles">
                <label title={locked ? 'The chain used by your root wallet must stay enabled.' : undefined}>
                  Enabled
                  <input
                    type="checkbox"
                    checked={selected.has(option.key)}
                    disabled={busy || locked}
                    onChange={(event) => toggle(option.key, event.target.checked)}
                  />
                </label>
              </div>
            </div>
          );
        })}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn-ghost" disabled={busy} onClick={() => void logout()}>Log out</button>
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </Modal>
  );
}
