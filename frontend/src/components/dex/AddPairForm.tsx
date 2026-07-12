import { useMemo, useState } from 'react';
import type { Asset, DexChain } from '@mosaic/chain-core';
import type { AssetDeployment, AssetWithTrust, ChainWithEnabled } from '@mosaic/catalog';
import Button from '../ui/Button';
import Field from '../ui/Field';
import Banner from '../ui/Banner';
import { useSettings } from '../../contexts/SettingsContext';
import { useCatalog } from '../../contexts/CatalogContext';
import { useEnabledChains } from '../../hooks/useEnabledChains';
import type { PairConfig, PairSources } from './types';

interface SelectableAsset {
  asset: AssetWithTrust;
  deployment: AssetDeployment;
}

function toDexAsset(entry: SelectableAsset): Asset {
  if (entry.deployment.kind === 'native') return { kind: 'native' };
  if (!entry.deployment.address) throw new Error(`${entry.asset.name} has no issuer or contract address`);
  return { kind: 'issued', code: entry.deployment.symbol, issuer: entry.deployment.address };
}

function dexCapable(chain: ChainWithEnabled): chain is ChainWithEnabled & { family: DexChain } {
  return chain.family === 'stellar' || chain.family === 'xrpl';
}

export default function AddPairForm({ onAdd }: { onAdd: (pair: PairConfig) => void }) {
  const { network: defaultNetwork } = useSettings();
  const { assets } = useCatalog();
  const { enabledChains } = useEnabledChains();
  const capableChains = useMemo(() => enabledChains.filter(dexCapable), [enabledChains]);
  const preferredId = `stellar-${defaultNetwork}`;
  const [chainId, setChainId] = useState(preferredId);
  const [baseId, setBaseId] = useState('');
  const [quoteId, setQuoteId] = useState('');
  const [baseFundedAccount, setBaseFundedAccount] = useState('');
  const [quoteFundedAccount, setQuoteFundedAccount] = useState('');
  const [sources, setSources] = useState<PairSources>({ clob: true, paths: false });
  const [submitted, setSubmitted] = useState(false);

  const effectiveChainId = capableChains.some((chain) => chain.id === chainId)
    ? chainId
    : (capableChains.find((chain) => chain.id === preferredId) ?? capableChains[0])?.id ?? '';
  const selectedChain = capableChains.find((chain) => chain.id === effectiveChainId);
  const selectableAssets = useMemo<SelectableAsset[]>(
    () =>
      assets.flatMap((asset) => {
        if (asset.trustState === 'hidden') return [];
        const deployment = asset.deployments.find((item) => item.chainId === effectiveChainId);
        return deployment ? [{ asset, deployment }] : [];
      }),
    [assets, effectiveChainId],
  );
  const native = selectableAssets.find(({ deployment }) => deployment.kind === 'native');
  const issued = selectableAssets.find(({ deployment }) => deployment.kind === 'issued');
  const effectiveBaseId = selectableAssets.some(({ asset }) => asset.id === baseId)
    ? baseId
    : (native ?? selectableAssets[0])?.asset.id ?? '';
  const effectiveQuoteId = selectableAssets.some(({ asset }) => asset.id === quoteId)
    ? quoteId
    : (issued ?? selectableAssets[1] ?? selectableAssets[0])?.asset.id ?? '';
  const base = selectableAssets.find(({ asset }) => asset.id === effectiveBaseId);
  const quote = selectableAssets.find(({ asset }) => asset.id === effectiveQuoteId);
  const sameAsset = effectiveBaseId && effectiveQuoteId && effectiveBaseId === effectiveQuoteId ? 'Base and quote must be different assets' : null;
  const noSource = !sources.clob && !sources.paths ? 'Select at least one data source' : null;
  const xrplPathfinding = selectedChain?.family === 'xrpl' && sources.paths;
  const baseFundingError = xrplPathfinding && !baseFundedAccount.trim() ? 'A funded base-asset account is required for XRPL pathfinding' : null;
  const quoteFundingError = xrplPathfinding && !quoteFundedAccount.trim() ? 'A funded quote-asset account is required for XRPL pathfinding' : null;
  const reviewAssets = [base, quote].filter((entry) => entry?.asset.trustState === 'review');

  const presets = useMemo(() => {
    const specs = [
      { chainId: 'stellar-mainnet', baseId: 'xlm', quoteId: 'usdc', label: 'XLM / USDC · Stellar', paths: true },
      { chainId: 'xrpl-mainnet', baseId: 'xrp', quoteId: 'rlusd', label: 'XRP / RLUSD · XRPL', paths: false },
      { chainId: 'xrpl-testnet', baseId: 'xrp', quoteId: 'rlusd', label: 'XRP / RLUSD · XRPL Testnet', paths: false },
    ];
    return specs.flatMap((spec) => {
      const chain = enabledChains.find((item) => item.id === spec.chainId);
      const baseAsset = assets.find((item) => item.id === spec.baseId && item.trustState !== 'hidden');
      const quoteAsset = assets.find((item) => item.id === spec.quoteId && item.trustState !== 'hidden');
      const baseDeployment = baseAsset?.deployments.find((item) => item.chainId === spec.chainId);
      const quoteDeployment = quoteAsset?.deployments.find((item) => item.chainId === spec.chainId);
      if (!chain || !dexCapable(chain) || !baseAsset || !quoteAsset || !baseDeployment || !quoteDeployment) return [];
      return [{
        label: spec.label,
        pair: {
          chain: chain.family,
          network: chain.network,
          base: toDexAsset({ asset: baseAsset, deployment: baseDeployment }),
          quote: toDexAsset({ asset: quoteAsset, deployment: quoteDeployment }),
          fundedAccounts: { base: null, quote: null },
          sources: { clob: true, paths: spec.paths },
        },
      }];
    });
  }, [assets, enabledChains]);

  function submit() {
    setSubmitted(true);
    if (!selectedChain || !base || !quote || sameAsset || noSource || baseFundingError || quoteFundingError) return;
    onAdd({
      id: crypto.randomUUID(),
      chain: selectedChain.family,
      network: selectedChain.network,
      base: toDexAsset(base),
      quote: toDexAsset(quote),
      fundedAccounts:
        selectedChain.family === 'xrpl'
          ? { base: baseFundedAccount.trim() || null, quote: quoteFundedAccount.trim() || null }
          : { base: null, quote: null },
      sources,
    });
    setSubmitted(false);
  }

  return (
    <div className="zone-card dex-add">
      <h3>Add a pair</h3>
      {presets.length > 0 && (
        <div className="dex-presets">
          {presets.map(({ label, pair }) => (
            <Button key={label} size="sm" onClick={() => onAdd({ id: crypto.randomUUID(), ...pair })}>
              {label}
            </Button>
          ))}
        </div>
      )}
      {capableChains.length === 0 ? (
        <Banner tone="warn">Enable an XRPL or Stellar chain in Settings before adding a pair.</Banner>
      ) : (
        <form
          className="dex-add-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Field id="dex-chain" label="Chain">
            <select
              value={effectiveChainId}
              onChange={(event) => {
                setChainId(event.target.value);
                setBaseId('');
                setQuoteId('');
              }}
            >
              {enabledChains.map((chain) => (
                <option key={chain.id} value={chain.id} disabled={!dexCapable(chain)}>
                  {chain.name}{dexCapable(chain) ? '' : ' · DEX support pending'}
                </option>
              ))}
            </select>
          </Field>
          <Field id="dex-base" label="Base asset">
            <select value={effectiveBaseId} onChange={(event) => setBaseId(event.target.value)}>
              {selectableAssets.map(({ asset, deployment }) => (
                <option key={asset.id} value={asset.id}>
                  {deployment.symbol}{asset.trustState === 'review' ? ' · Review' : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field id="dex-quote" label="Quote asset">
            <select value={effectiveQuoteId} onChange={(event) => setQuoteId(event.target.value)}>
              {selectableAssets.map(({ asset, deployment }) => (
                <option key={asset.id} value={asset.id}>
                  {deployment.symbol}{asset.trustState === 'review' ? ' · Review' : ''}
                </option>
              ))}
            </select>
          </Field>
          {reviewAssets.length > 0 && (
            <Banner tone="warn">
              {reviewAssets.map((entry) => entry!.asset.name).join(' and ')} marked for Review. Verify the deployment before use.
            </Banner>
          )}
          {selectedChain?.family === 'xrpl' && (
            <fieldset className="dex-asset">
              <legend>XRPL pathfinding accounts</legend>
              <p className="tile-note">Real, non-issuer funded accounts are required only when pathfinding is enabled.</p>
              <Field id="dex-base-funded-account" label="Funded base-asset account" error={submitted ? baseFundingError ?? undefined : undefined}>
                <input className="mono" placeholder="r…" value={baseFundedAccount} onChange={(event) => setBaseFundedAccount(event.target.value)} />
              </Field>
              <Field id="dex-quote-funded-account" label="Funded quote-asset account" error={submitted ? quoteFundingError ?? undefined : undefined}>
                <input className="mono" placeholder="r…" value={quoteFundedAccount} onChange={(event) => setQuoteFundedAccount(event.target.value)} />
              </Field>
            </fieldset>
          )}
          <fieldset className="dex-asset dex-sources">
            <legend>Data sources</legend>
            <label className="dex-source-check">
              <input type="checkbox" checked={sources.clob} onChange={(event) => setSources((current) => ({ ...current, clob: event.target.checked }))} />
              <span>Order book (CLOB, streamed)</span>
            </label>
            <label className="dex-source-check">
              <input type="checkbox" checked={sources.paths} onChange={(event) => setSources((current) => ({ ...current, paths: event.target.checked }))} />
              <span>Quote surface (pathfinding)</span>
            </label>
          </fieldset>
          <div className="dex-add-actions">
            <Button type="submit" variant="primary" disabled={!base || !quote}>Add pair</Button>
            {submitted && sameAsset && <span className="field-error">{sameAsset}</span>}
            {submitted && noSource && <span className="field-error">{noSource}</span>}
          </div>
        </form>
      )}
    </div>
  );
}
