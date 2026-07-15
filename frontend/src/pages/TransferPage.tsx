import { lazy, Suspense, useMemo, useState } from 'react';
import { cmpDecimals } from '@mosaic/chain-core';
import { ArrowRight, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import Banner from '../components/ui/Banner';
import Field from '../components/ui/Field';
import Modal from '../components/ui/Modal';
import XamanPromptModal, { type XamanPrompt } from '../components/XamanPromptModal';
import { api, type TransferPrepareResult } from '../api';
import { useActivity } from '../contexts/ActivityContext';
import { useBalances } from '../contexts/BalancesContext';
import { useCatalog } from '../contexts/CatalogContext';
import { useSession } from '../contexts/SessionContext';
import { useSettings } from '../contexts/SettingsContext';
import { errorMessage } from '../errors';
import { useVaultAddressOptions, useWalletAccounts } from '../hooks/useWalletAccounts';
import { signAndSubmitTransfer } from '../components/transfer/signing';
import AccountAddress from '../components/address/AccountAddress';

const LoginModal = lazy(() => import('../components/LoginModal'));

interface PendingXamanTransfer extends XamanPrompt {
  cancel: () => void;
}

function shortAddress(address: string): string {
  return address.length > 24 ? `${address.slice(0, 12)}…${address.slice(-10)}` : address;
}

function transferNetworkLabel(chain: string, network: string): string {
  if (chain === 'evm') return network === 'mainnet' ? 'Base' : 'Base Sepolia';
  if (chain === 'stellar') return network === 'mainnet' ? 'Stellar Public' : 'Stellar Testnet';
  return network === 'mainnet' ? 'XRPL Mainnet' : 'XRPL Testnet';
}

export default function TransferPage() {
  const { session, signRootStellarTransaction, sendRootEvmTransaction } = useSession();
  const { network } = useSettings();
  const { assets } = useCatalog();
  const accounts = useWalletAccounts();
  const vaultAddresses = useVaultAddressOptions();
  const { accountBalances, refresh: refreshBalances } = useBalances();
  const { refresh: refreshActivity } = useActivity();
  const [params, setParams] = useSearchParams();
  const [loginOpen, setLoginOpen] = useState(false);
  const [prepared, setPrepared] = useState<TransferPrepareResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TransferPrepareResult['transfer'] | null>(null);
  const [xaman, setXaman] = useState<PendingXamanTransfer | null>(null);
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const assetId = params.get('asset') ?? '';
  const amount = params.get('amount') ?? '';
  const requestedChain = params.get('chain');
  const rootAccounts = accounts.filter((account) => account.kind === 'root');
  const destinationAddressOptions = [...rootAccounts, ...vaultAddresses];
  const sourceAccounts = requestedChain === 'evm' || requestedChain === 'xrpl' || requestedChain === 'stellar'
    ? accounts.filter((account) => account.chain === requestedChain) : accounts;
  const selected = accounts.find((account) => account.address.toLowerCase() === from.toLowerCase()
    && (!params.get('chain') || account.chain === params.get('chain'))) ?? null;
  const destinationAccounts = destinationAddressOptions.filter((account) => (
    account.chain === (selected?.chain ?? requestedChain)
    && account.address.toLowerCase() !== selected?.address.toLowerCase()
  ));
  const selectedDestination = destinationAccounts.find((account) => account.address.toLowerCase() === to.toLowerCase()) ?? null;
  const chainId = selected?.chain === 'evm' ? (network === 'mainnet' ? 'base-mainnet' : 'base-sepolia')
    : selected ? `${selected.chain}-${network}` : null;
  const availableAssets = useMemo(() => assets.filter((asset) => asset.trustState === 'allowed'
    && asset.deployments.some((deployment) => deployment.chainId === chainId)), [assets, chainId]);
  const selectedAsset = availableAssets.find((asset) => asset.id === assetId) ?? null;
  const deployment = selectedAsset?.deployments.find((item) => item.chainId === chainId);
  const balance = selected && deployment ? accountBalances(selected.chain, selected.address)?.balances.find(({ asset }) => (
    asset.symbol === deployment.symbol && (asset.kind === 'native' || asset.issuer === deployment.address)
  ))?.amount : undefined;
  const destinationError = to && !selectedDestination ? 'Choose an eligible root or vault destination on the same chain.' : null;
  const amountError = amount && (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(amount) || !/[1-9]/.test(amount)) ? 'Enter a positive decimal amount.'
    : amount && deployment && (amount.split('.')[1]?.length ?? 0) > deployment.decimals ? `${deployment.symbol} supports at most ${deployment.decimals} decimal places.`
    : amount && balance && cmpDecimals(amount, balance) > 0 ? `Amount exceeds the available ${balance} ${deployment?.symbol ?? ''}.` : null;
  const ready = Boolean(session && selected && selectedDestination && selectedAsset && amount && !destinationError && !amountError);

  function setField(key: string, value: string) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value) next.set(key, value); else next.delete(key);
      if (key === 'from') {
        const account = accounts.find((candidate) => candidate.address === value);
        if (account) next.set('chain', account.chain);
        next.delete('asset');
        const currentDestination = next.get('to');
        if (currentDestination && (!account || !destinationAddressOptions.some((candidate) => (
          candidate.chain === account.chain && candidate.address.toLowerCase() === currentDestination.toLowerCase()
          && candidate.address.toLowerCase() !== account.address.toLowerCase()
        )))) next.delete('to');
      }
      return next;
    }, { replace: true });
    setError(null); setResult(null);
  }

  async function prepare() {
    if (!session || !selected || !ready) return;
    setBusy(true); setError(null);
    try {
      setPrepared(await api.transferPrepare({
        token: session.token, chain: selected.chain,
        source: selected.kind === 'root' ? { kind: 'root', address: selected.address } : {
          kind: 'vault', address: selected.address, zone: selected.zone,
          addressId: selected.addressId, name: selected.addressName,
        },
        destination: to, assetId, amount,
      }));
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function submit() {
    if (!session || !selected || !prepared) return;
    setBusy(true); setError(null);
    try {
      const response = await signAndSubmitTransfer(prepared, selected, session, {
        signRootStellarTransaction, sendRootEvmTransaction,
        showXaman: (refs, cancel) => setXaman({ refs, label: 'Sign transfer in Xaman', cancel }),
        hideXaman: () => setXaman(null),
      });
      setResult(response.transfer); setPrepared(null);
      await Promise.allSettled([refreshBalances(), refreshActivity()]);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  return <section className="reading transfer-page">
    <div className="page-heading"><div><span className="eyebrow">ACCOUNT TRANSFER</span><h2>Transfer</h2><p>Move an allowed asset between your root and vault addresses on the current network.</p></div></div>
    {!session && <Banner tone="info">Log in to select root or vault transfer accounts. <button type="button" className="btn-sm" onClick={() => setLoginOpen(true)}>Log in</button></Banner>}
    {error && <Banner tone="err">{error}</Banner>}
    {result && <Banner tone={result.status === 'failed' ? 'err' : 'info'}>Transfer {result.status.replaceAll('_', ' ')}{result.transactionHash ? ` · ${result.transactionHash}` : ''}</Banner>}
    <div className="card transfer-card">
      <Field id="transfer-from" label="From" required help={selected ? `${selected.chain.toUpperCase()} · ${network}` : 'Choose the root or an unlocked vault address.'}>
        <select value={selected?.address ?? ''} disabled={!session || busy} onChange={(event) => setField('from', event.target.value)}>
          <option value="">Select source address</option>
          {sourceAccounts.map((account) => <option key={`${account.chain}|${account.address}`} value={account.address}>{account.label} · {account.chain.toUpperCase()} · {account.address}</option>)}
        </select>
      </Field>
      <Field id="transfer-to" label="To" required error={destinationError} help="Choose a different root or vault address on the source chain.">
        <select value={selectedDestination?.address ?? ''} disabled={!selected || busy} onChange={(event) => setField('to', event.target.value)}>
          <option value="">Select destination address</option>
          {destinationAccounts.map((account) => <option key={`${account.chain}|${account.address}`} value={account.address}>{account.label} · {account.chain.toUpperCase()} · {account.address}</option>)}
        </select>
      </Field>
      <Field id="transfer-asset" label="Asset" required>
        <select value={selectedAsset?.id ?? ''} disabled={!selected || busy} onChange={(event) => setField('asset', event.target.value)}>
          <option value="">Select asset</option>
          {availableAssets.map((asset) => {
            const item = asset.deployments.find((candidate) => candidate.chainId === chainId)!;
            return <option key={asset.id} value={asset.id}>{item.symbol} · {asset.name}</option>;
          })}
        </select>
      </Field>
      <Field id="transfer-amount" label="Amount" required error={amountError} help={balance === undefined ? undefined : `Available: ${balance} ${deployment?.symbol ?? ''}`}>
        <input className="mono" inputMode="decimal" value={amount} disabled={!selectedAsset || busy} placeholder="0.00" onChange={(event) => setField('amount', event.target.value)} />
      </Field>
      {selected && destinationAccounts.length === 0 && <Banner tone="info">Create another {selected.chain.toUpperCase()} address in a vault to use as the destination.</Banner>}
      <div className="transfer-actions"><button type="button" className="btn-primary" disabled={!ready || busy} onClick={() => void prepare()}>{busy ? 'Preparing…' : 'Review transfer'}</button></div>
    </div>
    {prepared && <Modal title="Review transfer" onClose={() => !busy && setPrepared(null)} dismissible={!busy}>
      <div className="transfer-review offer-review">
        <section className="offer-review-hero" aria-label="Transfer summary">
          <div className="offer-review-kicker">
            <span className="pill transfer-review-pill">Transfer</span>
            <span className="mono">{transferNetworkLabel(prepared.transfer.chain, prepared.transfer.network)}</span>
          </div>
          <div className="transfer-review-amount">
            <span>You send</span>
            <strong className="num">{prepared.transfer.amount}<small>{prepared.transfer.assetSymbol}</small></strong>
          </div>
        </section>

        <dl className="offer-review-details transfer-review-details">
          <div className="offer-review-source transfer-review-account">
            <dt>From</dt>
            <dd><strong>{selected?.label}</strong><AccountAddress chain={prepared.transfer.chain} network={prepared.transfer.network} address={prepared.transfer.sourceAddress} className="mono" title={prepared.transfer.sourceAddress}>{shortAddress(prepared.transfer.sourceAddress)}</AccountAddress><small>{selected?.kind === 'root' ? 'Root wallet' : 'Vault address'}</small></dd>
          </div>
          <div className="offer-review-source transfer-review-account">
            <dt>To</dt>
            <dd><strong>{selectedDestination?.label}</strong><AccountAddress chain={prepared.transfer.chain} network={prepared.transfer.network} address={prepared.transfer.destinationAddress} className="mono" title={prepared.transfer.destinationAddress}>{shortAddress(prepared.transfer.destinationAddress)}</AccountAddress><small>{selectedDestination && 'kind' in selectedDestination ? 'Root wallet' : 'Vault address'}</small></dd>
          </div>
          <div>
            <dt>Network fee</dt>
            <dd className="num">{prepared.transfer.fee} {prepared.transfer.feeSymbol}</dd>
          </div>
          <div>
            <dt>Account impact</dt>
            <dd>{prepared.transfer.reserveImpact ?? 'No additional reserve required'}</dd>
          </div>
        </dl>

        <p className="transfer-review-notice offer-review-notice"><TriangleAlert size={17} aria-hidden="true" /><span><strong>Check the destination</strong>Blockchain transfers cannot be reversed.</span></p>

        <footer className="offer-review-actions transfer-review-footer">
          <p><ShieldCheck size={15} aria-hidden="true" />Only this exact transfer will be signed.</p>
          <div>
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => setPrepared(null)}>Back</button>
            <button type="button" className="btn-primary offer-review-submit" disabled={busy} onClick={() => void submit()}>{busy ? 'Waiting for signature…' : <>Sign &amp; transfer <ArrowRight size={15} aria-hidden="true" /></>}</button>
          </div>
        </footer>
      </div>
    </Modal>}
    {xaman && <XamanPromptModal prompt={xaman} onClose={xaman.cancel} />}
    {loginOpen && <Suspense fallback={null}><LoginModal onClose={() => setLoginOpen(false)} /></Suspense>}
  </section>;
}
