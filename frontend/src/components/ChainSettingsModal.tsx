import { useState } from 'react';
import Banner from './ui/Banner';
import Modal from './ui/Modal';

export interface ChainToggleOption {
  /** chainKey of the logical chain (custom chains use their own id). */
  key: string;
  name: string;
  /** Secondary line, e.g. "EVM · custom · mainnet only". */
  note?: string;
  enabled: boolean;
  /** When set, the toggle is disabled and this text explains why. */
  lockedReason?: string;
}

/**
 * Shared one-click chain toggles for global settings and per-vault settings.
 * Each toggle persists immediately through `onToggle`; the caller keeps the
 * options current so the modal reflects the change as soon as state updates.
 */
export default function ChainSettingsModal({
  title,
  description,
  options,
  onToggle,
  onClose,
}: {
  title: string;
  description: string;
  options: ChainToggleOption[];
  onToggle: (key: string, enabled: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(key: string, enabled: boolean) {
    setBusy(key);
    setError(null);
    try {
      await onToggle(key, enabled);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <p className="tile-note">{description}</p>
      {error && <Banner tone="err">{error}</Banner>}
      <div className="chain-group">
        {options.map((option) => (
          <div className="chain-trust-row" key={option.key}>
            <span>
              <strong>{option.name}</strong>
              {option.note && <span className="tile-note">{option.note}</span>}
            </span>
            <div className="chain-row-toggles">
              <label title={option.lockedReason}>
                Enabled
                <input
                  type="checkbox"
                  checked={option.enabled}
                  disabled={busy !== null || Boolean(option.lockedReason)}
                  onChange={(event) => void toggle(option.key, event.target.checked)}
                />
              </label>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
