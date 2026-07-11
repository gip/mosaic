import { useBalances } from '../../contexts/BalancesContext';
import { formatAmount } from './format';

/**
 * Totals of trusted assets across all unlocked vaults, grouped by chain
 * family. Renders nothing while no vault is unlocked (or every family is
 * hidden), so the strip never occupies space for logged-out sessions.
 */
export default function BalancesStrip() {
  const { families } = useBalances();
  if (families.length === 0) return null;

  return (
    <div className="balances-strip" aria-label="Unlocked vault balances">
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
