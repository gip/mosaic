import { useState } from 'react';
import type { AgentAddresses } from '@mosaic/zone-keys';

const CHAINS = [
  { key: 'evm', label: 'EVM', sub: "m/44'/60'/0'/0/0 · secp256k1" },
  { key: 'xrpl', label: 'XRPL', sub: "m/44'/144'/0'/0/0 · secp256k1" },
  { key: 'stellar', label: 'Stellar', sub: "m/44'/148'/0' · ed25519" },
] as const;

/** The three derived agent addresses for index 0, with copy-to-clipboard. */
export default function AgentAddressCards({ addresses }: { addresses: AgentAddresses }) {
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied((current) => (current === key ? null : current)), 1200);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className="address-cards">
      {CHAINS.map(({ key, label, sub }) => (
        <div className="address-card" key={key}>
          <div className="address-card-head">
            <h3>{label}</h3>
            <span className="tile-note mono">{sub}</span>
          </div>
          <code className="mono address-value">{addresses[key]}</code>
          <button type="button" className="btn-ghost btn-sm" onClick={() => void copy(key, addresses[key])}>
            {copied === key ? 'copied ✓' : 'copy'}
          </button>
        </div>
      ))}
    </div>
  );
}
