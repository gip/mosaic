import { useEffect, useMemo, useState } from 'react';
import type { Asset, OrderBookLevel } from '@mosaic/chain-core';
import { deploymentFor } from '@mosaic/catalog';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import ActivityTable from '../components/activity/ActivityTable';
import BookChart from '../components/dex/charts';
import ExecutionCostTable, { type CostOrderSelection } from '../components/dex/ExecutionCostTable';
import CustomMarketBuilder from '../components/dex/CustomMarketBuilder';
import { parseMarketQuery, validateMarketDraft, type MarketChain, type MarketValidation } from '../components/dex/marketUrl';
import { EXECUTION_QUOTE_AMOUNTS } from '../components/dex/types';
import OrderTicket, { type OrderTicketSelection, type TradingMarket } from '../components/dex/OrderTicket';
import { signAndSubmitOrder } from '../components/dex/signing';
import { useOrderBookFeed } from '../components/dex/useOrderBookFeed';
import { useQuoteSurfaceFeed } from '../components/dex/useQuoteSurfaceFeed';
import XamanPromptModal from '../components/XamanPromptModal';
import Banner from '../components/ui/Banner';
import Modal from '../components/ui/Modal';
import StatusDot, { type StatusTone } from '../components/ui/StatusDot';
import { useActivity } from '../contexts/ActivityContext';
import { useBalances } from '../contexts/BalancesContext';
import { useCatalog } from '../contexts/CatalogContext';
import { useSession } from '../contexts/SessionContext';
import { useSettings } from '../contexts/SettingsContext';
import { useTradingAccounts, type TradingAccount } from '../hooks/useTradingAccounts';
import { api, type DexOrderPrepareResult, type XamanRefs } from '../api';

const STATUS_TONES: Record<string, StatusTone> = { live: 'ok', connecting: 'busy', reconnecting: 'warn', idle: 'idle' };

interface PendingXamanPrompt {
  refs: XamanRefs;
  cancel: () => void;
}

function DexTestnetNotice({ network }: { network: 'mainnet' | 'testnet' }) {
  if (network !== 'testnet') return null;
  return (
    <Banner tone="warn">
      <strong>Testnet market data is not representative of Mainnet.</strong>{' '}
      Prices, liquidity, and order-book activity may be sparse or artificial.
    </Banner>
  );
}

function assetFromDeployment(deployment: ReturnType<typeof deploymentFor>): Asset | null {
  if (!deployment) return null;
  return deployment.kind === 'native'
    ? { kind: 'native' }
    : deployment.address
      ? { kind: 'issued', code: deployment.symbol, issuer: deployment.address, currencyCode: deployment.currencyCode }
      : null;
}

function format(value: number | string | undefined): string {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString(undefined, { maximumSignificantDigits: 8 }) : '—';
}

function assetMatches(left: Asset, right: Asset): boolean {
  return left.kind === 'native'
    ? right.kind === 'native'
    : right.kind === 'issued'
      && left.code === right.code
      && left.issuer === right.issuer
      && (left.currencyCode ?? left.code) === (right.currencyCode ?? right.code);
}

function buildMarkets(network: 'mainnet' | 'testnet', chains: ReturnType<typeof useCatalog>['chains'], assets: ReturnType<typeof useCatalog>['assets']): TradingMarket[] {
  const markets: TradingMarket[] = [];
  for (const chain of chains) {
    if (!chain.enabled || chain.network !== network || (chain.family !== 'xrpl' && chain.family !== 'stellar')) continue;
    const deployed = assets.flatMap((asset) => {
      if (asset.trustState === 'hidden') return [];
      const deployment = deploymentFor(asset, chain.id);
      const value = assetFromDeployment(deployment);
      return value && deployment ? [{ id: asset.id, asset: value, symbol: deployment.symbol, allowed: asset.trustState === 'allowed' }] : [];
    });
    for (let baseIndex = 0; baseIndex < deployed.length; baseIndex += 1) {
      for (let quoteIndex = baseIndex + 1; quoteIndex < deployed.length; quoteIndex += 1) {
        const base = deployed[baseIndex];
        const quote = deployed[quoteIndex];
        markets.push({
          id: `${chain.family}:${base.id}:${quote.id}`,
          chain: chain.family,
          network,
          base: base.asset,
          quote: quote.asset,
          baseSymbol: base.symbol,
          quoteSymbol: quote.symbol,
          baseAllowed: base.allowed,
          quoteAllowed: quote.allowed,
        });
      }
    }
  }
  return markets;
}

function marketPath(market: TradingMarket): string {
  return `/dex/${market.chain}/${market.baseSymbol.toLowerCase()}-${market.quoteSymbol.toLowerCase()}`;
}

function MarketPreview({ market }: { market: TradingMarket }) {
  const { accountBalances } = useBalances();
  const accounts = useTradingAccounts(market.chain);
  const fundedFor = (asset: Asset) => accounts.find((account) => {
    const balances = accountBalances(market.chain, account.address);
    return balances?.funded && balances.balances.some((balance) => assetMatches(balance.asset, asset) && Number(balance.amount) > 0);
  });
  const baseFunded = fundedFor(market.base);
  const quoteFunded = fundedFor(market.quote);
  const request = {
    chain: market.chain,
    network: market.network,
    base: market.base,
    quote: market.quote,
    fundedAccounts: market.chain === 'xrpl'
      ? { base: baseFunded?.address ?? null, quote: quoteFunded?.address ?? null }
      : { base: null, quote: null },
  };
  const book = useOrderBookFeed({
    ...request,
  });
  const pathAvailable = market.chain === 'stellar' || Boolean(baseFunded && quoteFunded);
  const paths = useQuoteSurfaceFeed(request, pathAvailable, EXECUTION_QUOTE_AMOUNTS);
  const bid = book.snapshot?.bids[0]?.price;
  const ask = book.snapshot?.asks[0]?.price;
  const midpoint = bid && ask ? (Number(bid) + Number(ask)) / 2 : undefined;
  return <article className="dex-market-card">
    <header>
      <div><span>{market.chain.toUpperCase()} · {market.network}</span><h3><Link to={marketPath(market)}>{market.baseSymbol} / {market.quoteSymbol}</Link></h3></div>
      <StatusDot tone={STATUS_TONES[book.status] ?? 'idle'}>{book.status}</StatusDot>
    </header>
    <BookChart kind="depth" snapshot={book.snapshot} surface={null} history={[]} />
    <section className="dex-market-card-cost"><h4>Cost</h4><ExecutionCostTable snapshot={book.snapshot} surface={paths.surface} quoteSymbol={market.quoteSymbol} pathAvailable={pathAvailable} pathError={paths.error?.message} /></section>
    <dl><div><dt>Best bid</dt><dd>{format(bid)}</dd></div><div><dt>Mid</dt><dd>{format(midpoint)}</dd></div><div><dt>Best ask</dt><dd>{format(ask)}</dd></div></dl>
    {book.error && <p className="activity-summary-error">{book.error.message}</p>}
    <Link className="dex-market-card-link" to={marketPath(market)}>Explore market →</Link>
  </article>;
}

export function DexOverviewPage() {
  const { network } = useSettings();
  const catalog = useCatalog();
  const markets = useMemo(() => buildMarkets(network, catalog.chains, catalog.assets), [catalog.assets, catalog.chains, network]);
  return <section className="dex-page dex-overview">
    <header className="dex-overview-heading"><div><h2>DEX markets</h2><p>Live central-limit-order books on Stellar and XRPL. Select a market to inspect depth, compare execution cost, or place a limit order.</p></div><span>{network}</span></header>
    <DexTestnetNotice network={network} />
    {markets.length > 0 ? <div className="dex-market-grid">{markets.map((market) => <MarketPreview market={market} key={market.id} />)}</div> : <p>No XRPL or Stellar markets are enabled for {network}.</p>}
  </section>;
}

function BookRows({ levels, side, onPrice }: { levels: OrderBookLevel[]; side: 'bid' | 'ask'; onPrice: (price: string) => void }) {
  const rows = levels.slice(0, 10);
  return <>{rows.map((level, index) => {
    const total = rows.slice(0, index + 1).reduce((sum, entry) => sum + Number(entry.amount), 0);
    return <tr key={`${side}-${level.price}-${index}`} className={side} onClick={() => onPrice(level.price)} title="Use this limit price">
      <td className="dex-price mono">{format(level.price)}</td><td className="num mono">{format(level.amount)}</td><td className="num mono">{format(total)}</td>
    </tr>;
  })}</>;
}

function MarketWorkspace({ market, markets }: { market: TradingMarket; markets: TradingMarket[] }) {
  const { network } = useSettings();
  const navigate = useNavigate();
  const { session, signRootStellarTransaction } = useSession();
  const { activities, refresh } = useActivity();
  const { accountBalances } = useBalances();
  const accounts = useTradingAccounts(market.chain);
  const fundedFor = (asset: Asset) => accounts.find((account) => {
    const balances = accountBalances(market.chain, account.address);
    return balances?.funded && balances.balances.some((balance) => assetMatches(balance.asset, asset) && Number(balance.amount) > 0);
  });
  const baseFunded = fundedFor(market.base);
  const quoteFunded = fundedFor(market.quote);
  const request = {
    chain: market.chain, network: market.network, base: market.base, quote: market.quote,
    fundedAccounts: market.chain === 'xrpl' ? { base: baseFunded?.address ?? null, quote: quoteFunded?.address ?? null } : { base: null, quote: null },
  };
  const book = useOrderBookFeed(request);
  const pathAvailable = Boolean(market.chain === 'stellar' || (baseFunded && quoteFunded));
  const paths = useQuoteSurfaceFeed(request, pathAvailable, EXECUTION_QUOTE_AMOUNTS);
  const [sidePanel, setSidePanel] = useState<'cost' | 'book'>('cost');
  const [ticketSelection, setTicketSelection] = useState<OrderTicketSelection | null>(null);
  const [cancelReview, setCancelReview] = useState<{ prepared: DexOrderPrepareResult; account: TradingAccount } | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [xaman, setXaman] = useState<PendingXamanPrompt | null>(null);

  const bestBid = book.snapshot?.bids[0]?.price;
  const bestAsk = book.snapshot?.asks[0]?.price;
  const midpoint = bestBid && bestAsk ? (Number(bestBid) + Number(bestAsk)) / 2 : undefined;
  const spread = bestBid && bestAsk ? Number(bestAsk) - Number(bestBid) : undefined;
  const marketActivity = activities.filter((activity) => activity.chain === market.chain && activity.network === market.network && assetMatches(activity.base, market.base) && assetMatches(activity.quote, market.quote));

  function chooseMarket(id: string) {
    if (id === market.id) return;
    const next = markets.find((item) => item.id === id);
    if (next) navigate(marketPath(next));
  }
  function fillPrice(value: string) { setTicketSelection((current) => ({ price: value, nonce: (current?.nonce ?? 0) + 1 })); }
  function fillOrder(selection: CostOrderSelection) {
    setTicketSelection((current) => ({ ...selection, nonce: (current?.nonce ?? 0) + 1 }));
    requestAnimationFrame(() => document.getElementById('dex-order-ticket')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  }

  async function prepareCancel(activity: (typeof activities)[number]) {
    if (!session) return;
    const account = accounts.find(({ address }) => address === activity.sourceAddress);
    if (!account) { setCancelError('Unlock the source vault, or reconnect the matching root wallet, before cancelling.'); return; }
    setCancelBusy(true); setCancelError(null);
    try { setCancelReview({ prepared: await api.dexOrderCancelPrepare(session.token, activity.id), account }); }
    catch (cause) { setCancelError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setCancelBusy(false); }
  }

  async function submitCancel() {
    if (!session || !cancelReview) return;
    setCancelBusy(true); setCancelError(null);
    try {
      await signAndSubmitOrder(cancelReview.prepared, cancelReview.account, session, { signRootStellarTransaction, showXaman: (refs, cancel) => setXaman({ refs, cancel }), hideXaman: () => setXaman(null) });
      setCancelReview(null);
      await refresh();
    } catch (cause) { setCancelError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setCancelBusy(false); }
  }

  return <section className="dex-page dex-workspace">
    <header className="dex-market-header">
      <div><div className="dex-market-title"><select aria-label="Market" value={market.id} onChange={(event) => chooseMarket(event.target.value)}>{!markets.some((item) => item.id === market.id) && <option value={market.id}>{market.baseSymbol} / {market.quoteSymbol} · {market.chain.toUpperCase()} · Custom</option>}{markets.map((item) => <option value={item.id} key={item.id}>{item.baseSymbol} / {item.quoteSymbol} · {item.chain.toUpperCase()}</option>)}</select><span>{network}</span></div><Link className="dex-market-back" to="/dex">All markets</Link></div>
      <dl className="dex-market-stats"><div><dt>Best bid</dt><dd>{format(bestBid)}</dd></div><div><dt>Best ask</dt><dd>{format(bestAsk)}</dd></div><div><dt>Midpoint</dt><dd>{format(midpoint)}</dd></div><div><dt>Spread</dt><dd>{format(spread)}</dd></div><div><dt>Feed</dt><dd><StatusDot tone={STATUS_TONES[book.status] ?? 'idle'}>{book.status}</StatusDot></dd></div></dl>
    </header>
    <DexTestnetNotice network={network} />
    {(!market.baseAllowed || !market.quoteAllowed) && <Banner tone="info">This market is available for inspection only. Both assets must exactly match Allowed catalog deployments before Mosaic can prepare an order.</Banner>}
    {book.error && <p className="activity-summary-error">Market feed: {book.error.message}</p>}
    <div className="dex-trading-grid">
      <div className="dex-market-panel">
        <BookChart kind="depth" snapshot={book.snapshot} surface={paths.surface} history={[]} />
        <div className="dex-order-book">
          <div className="dex-order-book-head">
            <div className="dex-side-tabs" role="tablist" aria-label="Market detail">
              <button type="button" role="tab" aria-selected={sidePanel === 'cost'} className={sidePanel === 'cost' ? 'active' : ''} onClick={() => setSidePanel('cost')}>Cost</button>
              <button type="button" role="tab" aria-selected={sidePanel === 'book'} className={sidePanel === 'book' ? 'active' : ''} onClick={() => setSidePanel('book')}>Order Book</button>
            </div>
            <span>{sidePanel === 'book' ? `Price (${market.quoteSymbol}) · Amount (${market.baseSymbol})` : pathAvailable ? 'Book and path view' : 'Book view'}</span>
          </div>
          {sidePanel === 'book' ? <table className="dex-book"><thead><tr><th>Price</th><th className="num">Amount</th><th className="num">Total</th></tr></thead><tbody><BookRows levels={(book.snapshot?.asks ?? []).slice(0, 10).reverse()} side="ask" onPrice={fillPrice} /><tr className="dex-spread"><td colSpan={3}>Spread {format(spread)} · Mid {format(midpoint)}</td></tr><BookRows levels={book.snapshot?.bids ?? []} side="bid" onPrice={fillPrice} /></tbody></table> : <ExecutionCostTable snapshot={book.snapshot} surface={paths.surface} quoteSymbol={market.quoteSymbol} pathAvailable={pathAvailable} pathError={paths.error?.message} onSelectOrder={fillOrder} />}
        </div>
      </div>
      <OrderTicket market={market} book={book.snapshot} selection={ticketSelection} />
    </div>
    <section className="dex-activity"><div className="dex-section-heading"><div><span className="eyebrow">THIS MARKET</span><h3>Open orders and activity</h3></div>{cancelBusy && <span>Preparing cancellation…</span>}</div>{cancelError && <p className="activity-summary-error">{cancelError}</p>}<ActivityTable activities={marketActivity} onCancel={(activity) => void prepareCancel(activity)} /></section>
    {cancelReview && <Modal title="Review order cancellation" onClose={() => !cancelBusy && setCancelReview(null)}><dl className="order-review"><div><dt>Offer</dt><dd>{cancelReview.prepared.order.offerId}</dd></div><div><dt>Pair</dt><dd>{cancelReview.prepared.order.baseSymbol}/{cancelReview.prepared.order.quoteSymbol}</dd></div><div><dt>Source</dt><dd>{cancelReview.account.label}<small className="mono">{cancelReview.account.address}</small></dd></div><div><dt>Fee</dt><dd>{cancelReview.prepared.order.fee} {cancelReview.prepared.order.feeSymbol}</dd></div></dl>{cancelError && <p className="activity-summary-error">{cancelError}</p>}<button type="button" className="btn-primary" disabled={cancelBusy} onClick={() => void submitCancel()}>{cancelBusy ? 'Waiting for signature…' : 'Sign and cancel'}</button></Modal>}
    {xaman && <XamanPromptModal prompt={{ refs: xaman.refs, label: 'Sign the cancellation in Xaman' }} onClose={() => { xaman.cancel(); setXaman(null); }} />}
  </section>;
}

function allowedCatalogAsset(
  catalog: ReturnType<typeof useCatalog>,
  chain: MarketChain,
  network: 'mainnet' | 'testnet',
  asset: Asset,
  symbol: string,
): boolean {
  const chainId = `${chain}-${network}`;
  return catalog.assets.some((candidate) => {
    if (candidate.trustState !== 'allowed') return false;
    const deployment = deploymentFor(candidate, chainId);
    if (!deployment || deployment.symbol !== symbol || deployment.kind !== asset.kind) return false;
    if (asset.kind === 'native') return true;
    if (deployment.address !== asset.issuer) return false;
    return chain !== 'xrpl' || (deployment.currencyCode ?? deployment.symbol) === (asset.currencyCode ?? asset.code);
  });
}

export default function DexPage() {
  const { network } = useSettings();
  const catalog = useCatalog();
  const { chain: routeChain, pair: routePair } = useParams();
  const markets = useMemo(() => buildMarkets(network, catalog.chains, catalog.assets), [catalog.assets, catalog.chains, network]);
  const market = markets.find((item) => item.chain === routeChain && `${item.baseSymbol}-${item.quoteSymbol}`.toLowerCase() === routePair?.toLowerCase());
  if (!market) return <section className="dex-page"><h2>DEX</h2><DexTestnetNotice network={network} /><p>No matching XRPL or Stellar market is enabled for {network}.</p></section>;
  return <MarketWorkspace market={market} markets={markets} />;
}

export function DexCustomMarketPage() {
  const { network } = useSettings();
  const catalog = useCatalog();
  const navigate = useNavigate();
  const { chain: routeChain } = useParams();
  const [searchParams] = useSearchParams();
  const search = searchParams.toString();
  const chain: MarketChain | null = routeChain === 'xrpl' || routeChain === 'stellar' ? routeChain : null;
  const parsed = useMemo(() => chain ? parseMarketQuery(chain, search) : null, [chain, search]);
  const validationKey = `${chain ?? 'unsupported'}?${search}`;
  const [validation, setValidation] = useState<{ key: string; result: MarketValidation } | null>(null);

  useEffect(() => {
    if (!chain || !parsed) return;
    let cancelled = false;
    void validateMarketDraft(chain, parsed.draft).then((result) => {
      if (!cancelled) setValidation({ key: validationKey, result });
    });
    return () => { cancelled = true; };
  }, [chain, parsed, validationKey]);

  if (!chain || !parsed) return <section className="dex-page"><h2>Unsupported market</h2><p>Custom markets are available for XRPL and Stellar.</p><Link to="/dex">View DEX markets</Link></section>;
  const current = validation?.key === validationKey ? validation.result : null;
  if (!current) return <section className="dex-page custom-market-loading"><h2>Checking market details…</h2></section>;

  if (current.value && parsed.queryErrors.length === 0) {
    const value = current.value;
    const market: TradingMarket = {
      id: `custom:${chain}:${search}`,
      chain,
      network,
      base: value.base,
      quote: value.quote,
      baseSymbol: value.baseSymbol,
      quoteSymbol: value.quoteSymbol,
      baseAllowed: allowedCatalogAsset(catalog, chain, network, value.base, value.baseSymbol),
      quoteAllowed: allowedCatalogAsset(catalog, chain, network, value.quote, value.quoteSymbol),
    };
    const markets = buildMarkets(network, catalog.chains, catalog.assets);
    return <MarketWorkspace market={market} markets={markets} />;
  }

  const initialErrors = {
    ...current.errors,
    query: parsed.queryErrors.length > 0 ? parsed.queryErrors : undefined,
  };
  return <CustomMarketBuilder
    key={validationKey}
    chain={chain}
    network={network}
    initialDraft={parsed.draft}
    initialErrors={initialErrors}
    onOpen={(nextSearch) => navigate(`/dex/${chain}/market?${nextSearch}`)}
  />;
}
