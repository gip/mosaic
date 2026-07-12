import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { AgentChain } from '@mosaic/zone-keys';
import type { ZoneChainSetting } from '../api';
import { useBalances } from '../contexts/BalancesContext';
import { formatAmount } from './balances/format';
import type { DerivedVaultAddress } from '../zone/unlock';

export default function AgentAddressCards({
  addresses,
  chains,
  onCreate,
}: {
  addresses: DerivedVaultAddress[];
  /** The owning vault's chains; disabled ones render no address group. */
  chains: ZoneChainSetting[];
  onCreate?: (chain: AgentChain, name?: string) => Promise<void>;
}) {
  const { accountBalances } = useBalances();
  // One group per enabled family, in the vault's (catalog) order: XRPL, Stellar, EVM.
  const groups: ZoneChainSetting[] = [];
  for (const chain of chains) {
    if (chain.enabled && !groups.some(({ family }) => family === chain.family)) groups.push(chain);
  }
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
      {groups.map((group) => {
        const key = group.family;
        const label = group.name;
        return (
        <section className="address-group" key={key}>
          <div className="address-group-head">
            <h3>
              {label}
              {group.evmChainId !== undefined && <span className="address-group-note"> · EVM {group.evmChainId}</span>}
            </h3>
            {onCreate && <div className="address-create">
              <input aria-label={`New ${label} address name`} value={names[key]} maxLength={64} placeholder={`#${addresses.filter((item) => item.chain === key).length}`}
                onChange={(event) => setNames((current) => ({ ...current, [key]: event.target.value }))} />
              <button type="button" className="btn-sm" disabled={busy !== null} onClick={() => void create(key)}>
                {busy === key ? 'Creating…' : 'Add address'}
              </button>
            </div>}
          </div>
          {addresses.filter((item) => item.chain === key).map((item) => {
            const account = accountBalances(key, item.address);
            return (
              <div className="address-item" key={item.id}>
                <div className="address-item-head">
                  <span className="address-name">{item.name}</span>
                  <code className="mono address-value">{item.address}</code>
                  <button type="button" className="address-copy" title="Copy address" aria-label={`Copy ${item.name} address`} onClick={() => void copy(item.id, item.address)}>
                    {copied === item.id ? <Check size={15} strokeWidth={2} className="copy-done" aria-hidden="true" /> : <Copy size={15} strokeWidth={1.75} aria-hidden="true" />}
                  </button>
                </div>
                {account && (
                  <p className="address-balances">
                    {account.balances.map(({ asset, amount }) => (
                      <span key={asset.symbol} className="address-balance" title={`${amount} ${asset.symbol}`}>
                        <span className="mono">{formatAmount(amount)}</span>
                        <span className="address-balance-symbol">{asset.symbol}</span>
                      </span>
                    ))}
                    {!account.funded && <span className="address-balance-note">Not activated yet</span>}
                  </p>
                )}
                <p className="address-txs-empty">No transactions recorded yet.</p>
              </div>
            );
          })}
        </section>
        );
      })}
    </div>
  );
}
