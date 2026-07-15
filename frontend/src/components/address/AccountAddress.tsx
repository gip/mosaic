import { useState, type ReactNode } from 'react';
import type { AgentChain, Network } from '@mosaic/zone-keys';
import { useNavigate } from 'react-router-dom';
import Modal from '../ui/Modal';
import { useVaultAddressOptions, useWalletAccounts } from '../../hooks/useWalletAccounts';
import { accountExplorerUrl, explorerName } from './explorers';

export default function AccountAddress({
  chain, network, address, children, className = 'mono', title,
}: {
  chain: AgentChain;
  network: Network;
  address: string;
  children?: ReactNode;
  className?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const navigate = useNavigate();
  const accounts = useWalletAccounts();
  const vaultAddresses = useVaultAddressOptions();
  const destination = [...accounts.filter((account) => account.kind === 'root'), ...vaultAddresses]
    .some((account) => account.chain === chain && account.address.toLowerCase() === address.toLowerCase());
  const source = accounts.some((account) => account.chain === chain && account.address.toLowerCase() === address.toLowerCase());
  const go = (direction: 'from' | 'to') => {
    const params = new URLSearchParams({ chain, [direction]: address });
    setOpen(false); navigate(`/transfer?${params.toString()}`);
  };
  async function copy() {
    try { await navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* unavailable */ }
  }
  return <>
    <button type="button" className={`account-address-trigger ${className}`} title={title ?? 'Account actions'} onClick={() => setOpen(true)}>{children ?? address}</button>
    {open && <Modal title="Account actions" onClose={() => setOpen(false)}>
      <p className="mono address-action-value">{address}</p>
      <div className="address-action-list">
        <button type="button" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy address'}</button>
        <a className="button-link" href={accountExplorerUrl(chain, network, address)} target="_blank" rel="noreferrer">View on {explorerName(chain)}</a>
        {destination && <button type="button" onClick={() => go('to')}>Transfer to this account</button>}
        {source && <button type="button" onClick={() => go('from')}>Transfer from this account</button>}
      </div>
    </Modal>}
  </>;
}
