import { Suspense, lazy, useState } from 'react';
import AddPairForm from '../components/dex/AddPairForm';
import type { PairConfig } from '../components/dex/types';
import { useActiveChains } from '../hooks/useActiveChains';

// The card pulls in @mosaic/dex and lightweight-charts; keep them out of the
// entry chunk (same pattern as LoginModal / ZonePanel).
const PairCard = lazy(() => import('../components/dex/PairCard'));

export default function DexPage() {
  const [pairs, setPairs] = useState<PairConfig[]>([]);
  const { activeChains } = useActiveChains();
  // Pairs stay in state so re-activating the chain brings them back.
  const visiblePairs = pairs.filter((pair) =>
    activeChains.some((chain) => chain.family === pair.chain && chain.network === pair.network),
  );

  return (
    <section className="dex-page">
      <h2>DEX order books</h2>
      <p className="dex-sub">
        Live on-chain order books, streamed straight from Horizon (Stellar) and the XRPL ledger.
        Add a pair to watch its book update as ledgers close.
      </p>
      <AddPairForm onAdd={(pair) => setPairs((ps) => [...ps, pair])} />
      {visiblePairs.length > 0 && (
        <div className="dex-pairs">
          <Suspense fallback={<p className="dex-waiting">Loading charts…</p>}>
            {visiblePairs.map((pair) => (
              <PairCard
                key={pair.id}
                pair={pair}
                onRemove={() => setPairs((ps) => ps.filter((p) => p.id !== pair.id))}
              />
            ))}
          </Suspense>
        </div>
      )}
    </section>
  );
}
