import { useBalances } from '../../contexts/BalancesContext';
import { formatAmount } from './format';

/**
 * Totals of trusted assets across the authenticated root account and every
 * unlocked vault, grouped by chain family.
 */
export default function BalancesStrip() {
  const { families } = useBalances();
  if (families.length === 0) return null;

  return (
    <div className="balances-strip" aria-label="Portfolio balances">
      {families.map(({ chain, label, totals, status, error }) => (
        <span key={chain} className="balances-strip-group" data-status={status}>
          <span className="balances-strip-chain">{label}</span>
          {totals ? (
            totals.map(({ asset, amount }) => (
              <span key={asset.symbol} className="balances-strip-item" title={`${amount} ${asset.symbol}`}>
                <span className="mono">{formatAmount(amount)}</span>
                <span className="balances-strip-symbol">{asset.symbol}</span>
              </span>
            ))
          ) : (
            <span className="balances-strip-pending">{error ? 'unavailable' : '…'}</span>
          )}
        </span>
      ))}
    </div>
  );
}
