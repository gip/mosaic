import { useState } from 'react';
import type { AgentChain } from '@mosaic/zone-keys';
import type { DerivedVaultAddress } from '../zone/unlock';

const CHAINS: { key: AgentChain; label: string; path: (index: number) => string }[] = [
  { key: 'evm', label: 'EVM', path: (index) => `m/44'/60'/0'/0/${index} · secp256k1` },
  { key: 'xrpl', label: 'XRPL', path: (index) => `m/44'/144'/0'/0/${index} · secp256k1` },
  { key: 'stellar', label: 'Stellar', path: (index) => `m/44'/148'/${index}' · ed25519` },
];

export default function AgentAddressCards({
  addresses,
  onCreate,
}: {
  addresses: DerivedVaultAddress[];
  onCreate?: (chain: AgentChain, name?: string) => Promise<void>;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [names, setNames] = useState<Record<AgentChain, string>>({ evm: '', xrpl: '', stellar: '' });
  const [busy, setBusy] = useState<AgentChain | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function copy(id: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(id);
      setTimeout(() => setCopied((current) => (current === id ? null : current)), 1200);
    } catch { /* clipboard unavailable */ }
  }

  async function create(chain: AgentChain) {
    if (!onCreate) return;
    setBusy(chain);
    setError(null);
    try {
      await onCreate(chain, names[chain].trim() || undefined);
      setNames((current) => ({ ...current, [chain]: '' }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="address-groups">
      {error && <p className="tile-error">{error}</p>}
      {CHAINS.map(({ key, label, path }) => (
        <section className="address-group" key={key}>
          <div className="address-group-head">
            <h3>{label}</h3>
            {onCreate && <div className="address-create">
              <input aria-label={`New ${label} address name`} value={names[key]} maxLength={64} placeholder={`#${addresses.filter((item) => item.chain === key).length}`}
                onChange={(event) => setNames((current) => ({ ...current, [key]: event.target.value }))} />
              <button type="button" className="btn-primary btn-sm" disabled={busy !== null} onClick={() => void create(key)}>
                {busy === key ? 'Creating…' : `Add ${label} address`}
              </button>
            </div>}
          </div>
          <div className="address-cards">
            {addresses.filter((item) => item.chain === key).map((item) => (
              <div className="address-card" key={item.id}>
                <div className="address-card-head">
                  <h4>{item.name}</h4>
                  <span className="tile-note mono">{path(item.index)}</span>
                </div>
                <code className="mono address-value">{item.address}</code>
                <button type="button" className="btn-ghost btn-sm" onClick={() => void copy(item.id, item.address)}>
                  {copied === item.id ? 'copied ✓' : 'copy'}
                </button>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
