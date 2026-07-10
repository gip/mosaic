import { Suspense, lazy, useState } from 'react';
import AddPairForm from '../components/dex/AddPairForm';
import type { PairConfig } from '../components/dex/types';

// The card pulls in @mosaic/dex and lightweight-charts; keep them out of the
// entry chunk (same pattern as LoginModal / ZonePanel).
const PairCard = lazy(() => import('../components/dex/PairCard'));

export default function DexPage() {
  const [pairs, setPairs] = useState<PairConfig[]>([]);

  return (
    <section className="dex-page">
      <h2>DEX order books</h2>
      <p className="dex-sub">
        Live on-chain order books, streamed straight from Horizon (Stellar) and the XRPL ledger.
        Add a pair to watch its book update as ledgers close.
      </p>
      <AddPairForm onAdd={(pair) => setPairs((ps) => [...ps, pair])} />
      {pairs.length > 0 && (
        <div className="dex-pairs">
          <Suspense fallback={<p className="dex-waiting">Loading charts…</p>}>
            {pairs.map((pair) => (
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
