import { useMemo, useState } from 'react';
import type { OrderStatus, TradingChain } from '@mosaic/chain-core';
import ActivityTable from '../components/activity/ActivityTable';
import { useActivity } from '../contexts/ActivityContext';

export default function ActivityPage() {
  const { activities, loading, error } = useActivity();
  const [status, setStatus] = useState<OrderStatus | ''>('');
  const [chain, setChain] = useState<TradingChain | ''>('');
  const [account, setAccount] = useState('');
  const [action, setAction] = useState('');
  const accounts = useMemo(() => [...new Set(activities.map(({ sourceAddress }) => sourceAddress))], [activities]);
  const filtered = activities.filter((item) => (!status || item.status === status) && (!chain || item.chain === chain) && (!account || item.sourceAddress === account) && (!action || item.action === action));
  return <section className="activity-page">
    <div className="page-heading"><div><span className="eyebrow">MOSAIC TRANSACTIONS</span><h2>Activity</h2><p>Orders and cancellations initiated through Mosaic, with their on-chain lifecycle.</p></div></div>
    <div className="activity-filters" aria-label="Activity filters">
      <label>Status<select value={status} onChange={(event) => setStatus(event.target.value as OrderStatus | '')}><option value="">All statuses</option>{['awaiting_signature','submitted','open','partially_filled','filled','cancelled','failed','expired','unknown'].map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>Chain<select value={chain} onChange={(event) => setChain(event.target.value as TradingChain | '')}><option value="">All chains</option><option value="xrpl">XRPL</option><option value="stellar">Stellar</option></select></label>
      <label>Account<select value={account} onChange={(event) => setAccount(event.target.value)}><option value="">All accounts</option>{accounts.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      <label>Action<select value={action} onChange={(event) => setAction(event.target.value)}><option value="">All actions</option><option value="buy">Buy</option><option value="sell">Sell</option><option value="cancel">Cancel</option></select></label>
    </div>
    {loading && activities.length === 0 ? <p>Loading activity…</p> : error && activities.length === 0 ? <p className="activity-summary-error">{error}</p> : <ActivityTable activities={filtered} />}
  </section>;
}
