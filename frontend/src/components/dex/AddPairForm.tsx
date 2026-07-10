import { useState } from 'react';
import type { Asset, DexChain, Network } from '@mosaic/dex';
import Button from '../ui/Button';
import Field from '../ui/Field';
import { useSettings } from '../../contexts/SettingsContext';
import { NATIVE_SYMBOLS, type PairConfig, type PairSources } from './types';

const CHAINS: { id: DexChain; label: string }[] = [
  { id: 'stellar', label: 'Stellar' },
  { id: 'xrpl', label: 'XRPL' },
  { id: 'evm', label: 'EVM' },
];

const RLUSD_ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';

const PRESETS: { label: string; pair: Omit<PairConfig, 'id'> }[] = [
  {
    label: 'XLM / USDC · Stellar',
    pair: {
      chain: 'stellar',
      network: 'mainnet',
      base: { kind: 'native' },
      quote: {
        kind: 'issued',
        code: 'USDC',
        issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      },
      sources: { clob: true, paths: true },
    },
  },
  {
    // Mainnet public XRPL servers refuse pathfinding, so book only.
    label: 'XRP / RLUSD · XRPL',
    pair: {
      chain: 'xrpl',
      network: 'mainnet',
      base: { kind: 'native' },
      quote: { kind: 'issued', code: 'RLUSD', issuer: RLUSD_ISSUER },
      sources: { clob: true, paths: false },
    },
  },
  {
    label: 'XRP / RLUSD · XRPL testnet + paths',
    pair: {
      chain: 'xrpl',
      network: 'testnet',
      base: { kind: 'native' },
      quote: { kind: 'issued', code: 'RLUSD', issuer: RLUSD_ISSUER },
      sources: { clob: true, paths: true },
    },
  },
];

interface AssetDraft {
  kind: Asset['kind'];
  code: string;
  issuer: string;
}

const NATIVE_DRAFT: AssetDraft = { kind: 'native', code: '', issuer: '' };

function draftToAsset(draft: AssetDraft): Asset {
  return draft.kind === 'native'
    ? { kind: 'native' }
    : { kind: 'issued', code: draft.code.trim(), issuer: draft.issuer.trim() };
}

function draftError(draft: AssetDraft): string | null {
  if (draft.kind === 'native') return null;
  if (!draft.code.trim()) return 'Asset code is required';
  if (!draft.issuer.trim()) return 'Issuer address is required';
  return null;
}

function AssetEditor({
  idPrefix,
  legend,
  chain,
  draft,
  error,
  onChange,
}: {
  idPrefix: string;
  legend: string;
  chain: DexChain;
  draft: AssetDraft;
  error: string | null;
  onChange: (draft: AssetDraft) => void;
}) {
  return (
    <fieldset className="dex-asset">
      <legend>{legend}</legend>
      <Field id={`${idPrefix}-kind`} label="Asset">
        <select
          value={draft.kind}
          onChange={(e) => onChange({ ...draft, kind: e.target.value as Asset['kind'] })}
        >
          <option value="native">Native ({NATIVE_SYMBOLS[chain]})</option>
          <option value="issued">Issued token</option>
        </select>
      </Field>
      {draft.kind === 'issued' && (
        <>
          <Field id={`${idPrefix}-code`} label="Code" error={error?.includes('code') ? error : undefined}>
            <input
              type="text"
              placeholder={chain === 'stellar' ? 'USDC' : 'RLUSD'}
              value={draft.code}
              onChange={(e) => onChange({ ...draft, code: e.target.value })}
            />
          </Field>
          <Field id={`${idPrefix}-issuer`} label="Issuer" error={error?.includes('Issuer') ? error : undefined}>
            <input
              type="text"
              className="mono"
              placeholder={chain === 'stellar' ? 'GA5Z…' : 'rMxC…'}
              value={draft.issuer}
              onChange={(e) => onChange({ ...draft, issuer: e.target.value })}
            />
          </Field>
        </>
      )}
    </fieldset>
  );
}

export default function AddPairForm({ onAdd }: { onAdd: (pair: PairConfig) => void }) {
  const { network: defaultNetwork } = useSettings();
  const [chain, setChain] = useState<DexChain>('stellar');
  const [network, setNetwork] = useState<Network>(defaultNetwork);
  const [base, setBase] = useState<AssetDraft>(NATIVE_DRAFT);
  const [quote, setQuote] = useState<AssetDraft>({ kind: 'issued', code: '', issuer: '' });
  const [sources, setSources] = useState<PairSources>({ clob: true, paths: false });
  const [submitted, setSubmitted] = useState(false);

  const baseError = draftError(base);
  const quoteError = draftError(quote);
  const sameAsset =
    base.kind === 'native' && quote.kind === 'native'
      ? 'Base and quote cannot both be the native asset'
      : null;
  const noSource = !sources.clob && !sources.paths ? 'Select at least one data source' : null;

  function submit() {
    setSubmitted(true);
    if (baseError || quoteError || sameAsset || noSource) return;
    onAdd({
      id: crypto.randomUUID(),
      chain,
      network,
      base: draftToAsset(base),
      quote: draftToAsset(quote),
      sources,
    });
    setSubmitted(false);
  }

  return (
    <div className="zone-card dex-add">
      <h3>Add a pair</h3>
      <div className="dex-presets">
        {PRESETS.map(({ label, pair }) => (
          <Button key={label} size="sm" onClick={() => onAdd({ id: crypto.randomUUID(), ...pair })}>
            {label}
          </Button>
        ))}
      </div>
      <form
        className="dex-add-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field id="dex-chain" label="Chain">
          <select value={chain} onChange={(e) => setChain(e.target.value as DexChain)}>
            {CHAINS.map(({ id, label }) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field id="dex-network" label="Network">
          <select value={network} onChange={(e) => setNetwork(e.target.value as Network)}>
            <option value="mainnet">Mainnet</option>
            <option value="testnet">Testnet</option>
          </select>
        </Field>
        <AssetEditor
          idPrefix="dex-base"
          legend="Base"
          chain={chain}
          draft={base}
          error={submitted ? baseError : null}
          onChange={setBase}
        />
        <AssetEditor
          idPrefix="dex-quote"
          legend="Quote"
          chain={chain}
          draft={quote}
          error={submitted ? quoteError : null}
          onChange={setQuote}
        />
        <fieldset className="dex-asset dex-sources">
          <legend>Data sources</legend>
          <label className="dex-source-check">
            <input
              type="checkbox"
              checked={sources.clob}
              onChange={(e) => setSources((s) => ({ ...s, clob: e.target.checked }))}
            />
            <span>Order book (CLOB, streamed)</span>
          </label>
          <label className="dex-source-check">
            <input
              type="checkbox"
              checked={sources.paths}
              onChange={(e) => setSources((s) => ({ ...s, paths: e.target.checked }))}
            />
            <span>Quote surface (pathfinding)</span>
          </label>
        </fieldset>
        <div className="dex-add-actions">
          <Button type="submit" variant="primary">
            Add pair
          </Button>
          {submitted && sameAsset && <span className="field-error">{sameAsset}</span>}
          {submitted && noSource && <span className="field-error">{noSource}</span>}
        </div>
      </form>
    </div>
  );
}
