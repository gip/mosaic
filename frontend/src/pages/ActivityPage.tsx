import ActivityList from '../components/activity/ActivityList';
import { useActivity } from '../contexts/ActivityContext';

export default function ActivityPage() {
  const { activities, loading, error } = useActivity();
  return <section className="activity-page">
    <div className="page-heading"><div><span className="eyebrow">MOSAIC TRANSACTIONS</span><h2>Activity</h2><p>Orders, transfers, and the on-chain transactions that carry them out.</p></div></div>
    {loading && activities.length === 0 ? <p>Loading activity…</p> : error && activities.length === 0 ? <p className="activity-summary-error">{error}</p> : <ActivityList activities={activities} />}
  </section>;
}
