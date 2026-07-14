import { useState } from 'react';
import Button from '../ui/Button';
import Banner from '../ui/Banner';
import Field from '../ui/Field';
import {
  decodePrintableCurrency,
  nativeSymbol,
  serializeMarketQuery,
  validateMarketDraft,
  type MarketAssetDraft,
  type MarketChain,
  type MarketDraft,
  type MarketDraftErrors,
} from './marketUrl';

function AssetFields({
  chain,
  side,
  asset,
  errors,
  onChange,
}: {
  chain: MarketChain;
  side: 'base' | 'quote';
  asset: MarketAssetDraft;
  errors: MarketDraftErrors['base'];
  onChange: (asset: MarketAssetDraft) => void;
}) {
  const label = side === 'base' ? 'Base' : 'Quote';
  const native = nativeSymbol(chain);
  const decoded = chain === 'xrpl' && asset.currency ? decodePrintableCurrency(asset.currency) : null;
  return <fieldset className="custom-market-asset">
    <legend>{label} asset</legend>
    <Field id={`custom-market-${side}-kind`} label="Asset type">
      <select
        value={asset.kind}
        onChange={(event) => {
          const kind = event.target.value as MarketAssetDraft['kind'];
          onChange(kind === 'native'
            ? { kind, symbol: native, issuer: '', currency: '' }
            : { kind, symbol: asset.symbol.toUpperCase() === native ? '' : asset.symbol, issuer: asset.issuer, currency: asset.currency });
        }}
      >
        <option value="native">Native {native}</option>
        <option value="issued">Issued asset</option>
      </select>
    </Field>
    {asset.kind === 'issued' && <>
      <Field id={`custom-market-${side}-symbol`} label="Display symbol" required error={errors.symbol ?? errors.kind}>
        <input value={asset.symbol} onChange={(event) => onChange({ ...asset, symbol: event.target.value })} placeholder={chain === 'xrpl' ? 'RLUSD' : 'USDC'} />
      </Field>
      <Field id={`custom-market-${side}-issuer`} label="Issuer address" required error={errors.issuer}>
        <input className="mono" value={asset.issuer} onChange={(event) => onChange({ ...asset, issuer: event.target.value })} placeholder={chain === 'xrpl' ? 'r…' : 'G…'} />
      </Field>
      {chain === 'xrpl' && <Field
        id={`custom-market-${side}-currency`}
        label="XRPL currency"
        help={decoded ? `Decodes to ${decoded}` : 'Optional; enter a 3-character code or 40-character ledger value.'}
        error={errors.currency}
      >
        <input className="mono" value={asset.currency} onChange={(event) => onChange({ ...asset, currency: event.target.value })} placeholder="524C555344…" />
      </Field>}
    </>}
  </fieldset>;
}

export default function CustomMarketBuilder({
  chain,
  network,
  initialDraft,
  initialErrors,
  onOpen,
}: {
  chain: MarketChain;
  network: 'mainnet' | 'testnet';
  initialDraft: MarketDraft;
  initialErrors: MarketDraftErrors;
  onOpen: (search: string) => void;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const [errors, setErrors] = useState(initialErrors);
  const [busy, setBusy] = useState(false);

  function update(side: 'base' | 'quote', asset: MarketAssetDraft) {
    setDraft((current) => ({ ...current, [side]: asset }));
    setErrors((current) => ({ ...current, [side]: {}, pair: undefined, query: undefined }));
  }

  async function submit() {
    setBusy(true);
    try {
      const result = await validateMarketDraft(chain, draft);
      setErrors(result.errors);
      if (result.value) onOpen(serializeMarketQuery(chain, result.value));
    } finally {
      setBusy(false);
    }
  }

  return <section className="dex-page custom-market-page">
    <header className="custom-market-heading">
      <div><span className="eyebrow">{chain.toUpperCase()} · {network}</span><h2>Open a market</h2><p>Describe both assets to inspect their live order book. Issued assets are identified by their symbol and issuer.</p></div>
    </header>
    {errors.query && errors.query.length > 0 && <Banner tone="warn">Complete or correct the market URL below: {errors.query.join('; ')}.</Banner>}
    <form className="custom-market-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <AssetFields chain={chain} side="base" asset={draft.base} errors={errors.base} onChange={(asset) => update('base', asset)} />
      <AssetFields chain={chain} side="quote" asset={draft.quote} errors={errors.quote} onChange={(asset) => update('quote', asset)} />
      {errors.pair && <Banner tone="err">{errors.pair}</Banner>}
      <div className="custom-market-actions">
        <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Checking market…' : 'See market'}</Button>
      </div>
    </form>
  </section>;
}
