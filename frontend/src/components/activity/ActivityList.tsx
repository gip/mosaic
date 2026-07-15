import type { ActivityRecord } from '@mosaic/chain-core';
import { ActivityStatus } from './ActivityTable';
import { activityExplorerUrl, activityIntent, activityStatusLabel, shortTransactionId } from './activityPresentation';

export default function ActivityList({ activities }: { activities: ActivityRecord[] }) {
  if (activities.length === 0) return <p className="activity-empty">No Mosaic trading activity yet.</p>;

  return <div className="activity-groups">
    {activities.map((activity) => {
      const intent = activityIntent(activity);
      const explorerUrl = activityExplorerUrl(activity);
      const explorerName = activity.chain === 'xrpl' ? 'XRPL Explorer' : 'Stellar Expert';
      const status = `${activityStatusLabel(activity.status)} · ${networkLabel(activity)}`;
      return <article className="activity-group" key={activity.id}>
        <div className="activity-row">
          <div className="activity-summary-main">
            <span className="activity-field-label">Intent</span>
            <div className="activity-summary-heading">
              <h4>{intent.title}</h4>
              <time dateTime={activity.createdAt} title={new Date(activity.createdAt).toLocaleString()}>{timeAgo(activity.createdAt)}</time>
              <ActivityStatus activity={activity} />
            </div>
            <span className="activity-summary-text">{intent.detail}</span>
            {activity.error && <span className="activity-summary-error">{activity.error}</span>}
          </div>
          <div className="activity-tx-list">
            <span className="activity-field-label">Transaction ID / Status</span>
            {activity.transactionHash && explorerUrl
              ? <div className="activity-tx-line">
                  <a
                    className="mono activity-tx-link"
                    href={explorerUrl}
                    target="_blank"
                    rel="noreferrer"
                    title={`View ${activity.transactionHash} on ${explorerName}`}
                  >
                    {shortTransactionId(activity.transactionHash)}
                  </a>
                  <span className="activity-tx-desc" title={`${status} · View on ${explorerName}`}>{status}</span>
                </div>
              : <div className="activity-tx-line">
                  <span className="activity-tx-pending">Pending</span>
                  <span className="activity-tx-desc" title={status}>{status}</span>
                </div>}
          </div>
        </div>
      </article>;
    })}
  </div>;
}

function networkLabel(activity: ActivityRecord): string {
  return `${activity.chain === 'xrpl' ? 'XRPL' : 'Stellar'} ${activity.network === 'mainnet' ? 'Mainnet' : 'Testnet'}`;
}

function timeAgo(value: string): string {
  const timestamp = new Date(value).getTime();
  const delta = Math.max(0, Date.now() - timestamp);
  if (delta < 30_000) return 'just now';
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}
