import { Fragment, useState } from 'react';
import type { ActivityRecord, WalletActivityRecord } from '@mosaic/chain-core';
import { activityExplorerUrl } from './activityPresentation';
import AccountAddress from '../address/AccountAddress';

const ACTIVE = new Set(['awaiting_signature', 'submitted', 'confirmed', 'open', 'partially_filled', 'unknown']);

function time(value?: string): string {
  return value ? new Date(value).toLocaleString() : '—';
}

function source(activity: ActivityRecord): string {
  return activity.sourceKind === 'root' ? 'Root' : `${activity.zone ?? 'Vault'} / ${activity.addressName ?? activity.sourceAddress}`;
}

export function ActivityStatus({ activity }: { activity: WalletActivityRecord }) {
  const tone = ['failed', 'expired'].includes(activity.status) ? 'err' : ACTIVE.has(activity.status) ? 'busy' : 'ok';
  return <span className={`activity-status activity-status--${tone}`}>{activity.status.replaceAll('_', ' ')}</span>;
}

export default function ActivityTable({ activities, compact = false, onCancel }: { activities: ActivityRecord[]; compact?: boolean; onCancel?: (activity: ActivityRecord) => void }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (activities.length === 0) return <p className="activity-empty">No Mosaic trading activity yet.</p>;
  return (
    <div className="activity-table-scroll">
      <table className={`activity-table${compact ? ' activity-table--compact' : ''}`}>
        <thead><tr><th>Time</th><th>Status</th><th>Action</th><th>Pair</th><th className="num">Requested</th><th className="num">Filled</th><th className="num">Remaining</th><th className="num">Limit</th><th>Account</th>{onCancel && <th />}</tr></thead>
        <tbody>
          {activities.map((activity) => {
            const open = expanded === activity.id;
            const explorerUrl = activityExplorerUrl(activity);
            return (
              <Fragment key={activity.id}>
                <tr className="activity-table-row" onClick={() => setExpanded(open ? null : activity.id)} aria-expanded={open} tabIndex={0} onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setExpanded(open ? null : activity.id); }
                }}>
                  <td><time dateTime={activity.createdAt}>{new Date(activity.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></td>
                  <td><ActivityStatus activity={activity} /></td>
                  <td className={`activity-action activity-action--${activity.side}`}>{activity.action}</td>
                  <td>{activity.baseSymbol}/{activity.quoteSymbol}</td>
                  <td className="num mono">{activity.amount}</td>
                  <td className="num mono">{activity.filledAmount}</td>
                  <td className="num mono">{activity.remainingAmount}</td>
                  <td className="num mono">{activity.limitPrice}</td>
                  <td>{source(activity)}</td>
                  {onCancel && <td>{['open', 'partially_filled', 'unknown'].includes(activity.status) && <button type="button" className="btn-sm" onClick={(event) => { event.stopPropagation(); onCancel(activity); }}>Cancel</button>}</td>}
                </tr>
                {open && <tr className="activity-detail-row"><td colSpan={onCancel ? 10 : 9}>
                  <dl className="activity-details">
                    <div><dt>Quote total</dt><dd>{activity.quoteTotal} {activity.quoteSymbol}</dd></div>
                    <div><dt>Average price</dt><dd>{activity.averagePrice ?? '—'}</dd></div>
                    <div><dt>Chain / network</dt><dd>{activity.chain} / {activity.network}</dd></div>
                    <div><dt>Source address</dt><dd><AccountAddress chain={activity.chain} network={activity.network} address={activity.sourceAddress} className="mono">{activity.sourceAddress}</AccountAddress></dd></div>
                    <div><dt>Fee</dt><dd>{activity.fee} {activity.feeSymbol}</dd></div>
                    <div><dt>Reserve</dt><dd>{activity.reserveImpact ?? 'None'}</dd></div>
                    <div><dt>Offer ID</dt><dd className="mono">{activity.offerId ?? '—'}</dd></div>
                    <div><dt>Ledger</dt><dd>{activity.ledger ?? '—'}</dd></div>
                    <div><dt>Submitted</dt><dd>{time(activity.submittedAt)}</dd></div>
                    <div><dt>Confirmed</dt><dd>{time(activity.confirmedAt)}</dd></div>
                    <div><dt>Result</dt><dd>{activity.resultCode ?? '—'}</dd></div>
                    <div><dt>Transaction</dt><dd>{explorerUrl ? <a href={explorerUrl} target="_blank" rel="noreferrer">View on explorer</a> : '—'}</dd></div>
                    {activity.error && <div className="activity-details-error"><dt>Error</dt><dd>{activity.error}</dd></div>}
                  </dl>
                </td></tr>}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
