import { useState } from 'react';
import type { Asset, OrderBookSnapshot, OrderSide } from '@mosaic/chain-core';
import { multiplyDecimals } from '@mosaic/chain-core';
import { api, type DexOrderPrepareResult, type XamanRefs } from '../../api';
import { useActivity } from '../../contexts/ActivityContext';
import { useBalances } from '../../contexts/BalancesContext';
import { useSession } from '../../contexts/SessionContext';
import { useTradingAccounts, type TradingAccount } from '../../hooks/useTradingAccounts';
import XamanPromptModal from '../XamanPromptModal';
import Modal from '../ui/Modal';
import { signAndSubmitOrder } from './signing';

export interface TradingMarket {
  id: string;
  chain: 'xrpl' | 'stellar';
  network: 'mainnet' | 'testnet';
  base: Asset;
  quote: Asset;
  baseSymbol: string;
  quoteSymbol: string;
  baseAllowed: boolean;
  quoteAllowed: boolean;
}

function matches(left: Asset, right: Asset): boolean {
  return left.kind === 'native' ? right.kind === 'native' : right.kind === 'issued' && left.code === right.code && left.issuer === right.issuer;
}

export interface OrderTicketSelection {
  side?: OrderSide;
  amount?: string;
  price: string;
  nonce: number;
}

export default function OrderTicket({ market, book, selection }: { market: TradingMarket; book: OrderBookSnapshot | null; selection: OrderTicketSelection | null }) {
  const { session, signRootStellarTransaction } = useSession();
  const { accountBalances } = useBalances();
  const { refresh } = useActivity();
  const accounts = useTradingAccounts(market.chain);
  const [side, setSide] = useState<OrderSide>('buy');
  const [accountAddress, setAccountAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [price, setPrice] = useState('');
  const [prepared, setPrepared] = useState<DexOrderPrepareResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [xaman, setXaman] = useState<XamanRefs | null>(null);
  const [selectionNonce, setSelectionNonce] = useState(0);
  const selected = accounts.find(({ address }) => address === accountAddress) ?? accounts[0];
  if (selection && selection.nonce !== selectionNonce) {
    setSelectionNonce(selection.nonce);
    setPrice(selection.price);
    if (selection.amount) setAmount(selection.amount);
    if (selection.side) setSide(selection.side);
  }
  if (selected && !accountAddress) setAccountAddress(selected.address);

  const balanceAsset = side === 'buy' ? market.quote : market.base;
  const balanceSymbol = side === 'buy' ? market.quoteSymbol : market.baseSymbol;
  const available = selected ? accountBalances(market.chain, selected.address)?.balances.find(({ asset }) => matches(asset, balanceAsset))?.amount : undefined;
  let total = '';
  try { if (amount && price) total = multiplyDecimals(amount, price); } catch { /* incomplete input */ }
  const bestAsk = Number(book?.asks[0]?.price);
  const bestBid = Number(book?.bids[0]?.price);
  const crosses = side === 'buy'
    ? Number.isFinite(bestAsk) && Number(price) >= bestAsk
    : Number.isFinite(bestBid) && Number(price) <= bestBid;
  const allowed = market.baseAllowed && market.quoteAllowed;

  async function review() {
    if (!session || !selected) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.dexOrderPrepare({
        token: session.token,
        chain: market.chain,
        side,
        source: selected.kind === 'root'
          ? { kind: 'root', address: selected.address }
          : { kind: 'vault', address: selected.address, zone: selected.zone, addressId: selected.addressId, name: selected.addressName },
        base: market.base,
        quote: market.quote,
        baseSymbol: market.baseSymbol,
        quoteSymbol: market.quoteSymbol,
        amount,
        limitPrice: price,
      });
      setPrepared(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }

  async function submit(account: TradingAccount) {
    if (!session || !prepared) return;
    setBusy(true);
    setError(null);
    try {
      const result = await signAndSubmitOrder(prepared, account, session, {
        signRootStellarTransaction,
        showXaman: setXaman,
        hideXaman: () => setXaman(null),
      });
      if (result.order.status === 'failed' || result.order.status === 'unknown') throw new Error(result.order.error ?? `Order status: ${result.order.status}`);
      setPrepared(null);
      setAmount('');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }

  return <aside className="order-ticket" id="dex-order-ticket">
    <div className="order-side-tabs" role="tablist" aria-label="Order side">
      <button type="button" role="tab" aria-selected={side === 'buy'} className={side === 'buy' ? 'active buy' : ''} onClick={() => setSide('buy')}>Buy</button>
      <button type="button" role="tab" aria-selected={side === 'sell'} className={side === 'sell' ? 'active sell' : ''} onClick={() => setSide('sell')}>Sell</button>
    </div>
    {!session ? <div className="order-ticket-empty"><h3>Trade this market</h3><p>Log in to select a root or unlocked-vault account and place a limit order.</p></div> : <>
      <label>Account<select value={selected?.address ?? ''} onChange={(event) => setAccountAddress(event.target.value)}>{accounts.length === 0 && <option value="">No eligible account</option>}{accounts.map((account) => <option value={account.address} key={account.address}>{account.label} · {account.address.slice(0, 7)}…{account.address.slice(-5)}</option>)}</select></label>
      <div className="order-available"><span>Available</span><strong className="mono">{available ?? '—'} {balanceSymbol}</strong></div>
      <label>Amount ({market.baseSymbol})<input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" /></label>
      <label>Limit price ({market.quoteSymbol})<input inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} placeholder="0.00" /></label>
      <div className="order-total"><span>Quote total</span><strong className="mono">{total || '—'} {market.quoteSymbol}</strong></div>
      <div className="order-meta"><span>Fee / reserve</span><span>Calculated at review</span><span>Time in force</span><strong>Good ’til cancelled</strong></div>
      {crosses && <p className="order-crossing">This limit crosses the current book and may execute immediately, up to your limit.</p>}
      {!allowed && <p className="order-policy">Review assets are available for market inspection only. Mark both assets Allowed before trading.</p>}
      {accounts.length === 0 && <p className="order-policy">No matching root account or unlocked vault address is available for {market.chain.toUpperCase()}.</p>}
      {error && <p className="activity-summary-error">{error}</p>}
      <button type="button" className={`btn-primary order-submit order-submit--${side}`} disabled={busy || !allowed || !selected || !total} onClick={() => void review()}>{busy ? 'Preparing…' : `Review ${side} order`}</button>
    </>}
    {prepared && selected && <Modal title="Review exact limit order" onClose={() => !busy && setPrepared(null)}>
      <dl className="order-review">
        <div><dt>Action</dt><dd>{prepared.order.side.toUpperCase()} {prepared.order.amount} {prepared.order.baseSymbol}</dd></div>
        <div><dt>Limit</dt><dd>{prepared.order.limitPrice} {prepared.order.quoteSymbol}</dd></div>
        <div><dt>Maximum total</dt><dd>{prepared.order.quoteTotal} {prepared.order.quoteSymbol}</dd></div>
        <div><dt>Source</dt><dd>{selected.label}<small className="mono">{selected.address}</small></dd></div>
        <div><dt>Fee</dt><dd>{prepared.order.fee} {prepared.order.feeSymbol}</dd></div>
        <div><dt>Reserve impact</dt><dd>{prepared.order.reserveImpact ?? 'None'}</dd></div>
        <div><dt>Time in force</dt><dd>Good ’til cancelled</dd></div>
      </dl>
      {crosses && <p className="order-crossing">This order can fill immediately; any remainder will rest on the book.</p>}
      {error && <p className="activity-summary-error">{error}</p>}
      <button type="button" className="btn-primary" disabled={busy} onClick={() => void submit(selected)}>{busy ? 'Waiting for signature…' : 'Sign and submit'}</button>
    </Modal>}
    {xaman && <XamanPromptModal prompt={{ refs: xaman, label: 'Sign the limit order in Xaman' }} onClose={() => setXaman(null)} />}
  </aside>;
}
