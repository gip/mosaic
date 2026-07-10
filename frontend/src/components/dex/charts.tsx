import { useEffect, useRef, useSyncExternalStore } from 'react';
import {
  AreaSeries,
  ColorType,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  createOptionsChart,
  type DeepPartial,
  type IChartApiBase,
  type ISeriesApi,
  type PriceChartOptions,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { OrderBookSnapshot, QuoteSurface } from '@mosaic/dex';
import type { ChartKind } from './types';

/**
 * Track the theme via the data-theme attribute rather than ThemeContext:
 * chart effects re-run before ThemeProvider's effect stamps the attribute,
 * so reacting to context would re-read CSS variables one theme too early.
 * The MutationObserver fires only after the attribute (and the CSS custom
 * properties) actually changed.
 */
function subscribeToThemeAttribute(callback: () => void): () => void {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

function useThemeAttribute(): string {
  return useSyncExternalStore(
    subscribeToThemeAttribute,
    () => document.documentElement.getAttribute('data-theme') ?? 'dark',
  );
}

export interface PricePoint {
  time: UTCTimestamp;
  mid: number;
  spread: number;
}

interface ChartColors {
  text: string;
  line: string;
  buy: string;
  buyDim: string;
  sell: string;
  sellDim: string;
  accent: string;
  warn: string;
}

function readColors(el: HTMLElement): ChartColors {
  const style = getComputedStyle(el);
  const token = (name: string) => style.getPropertyValue(name).trim();
  return {
    text: token('--fg-muted'),
    line: token('--line'),
    buy: token('--buy'),
    buyDim: token('--buy-dim'),
    sell: token('--sell'),
    sellDim: token('--sell-dim'),
    accent: token('--accent'),
    warn: token('--warn'),
  };
}

/** Compact axis labels: order books span 1e-6 XRP prices to 1e6 sizes. */
function formatAxisNumber(value: number): string {
  if (!Number.isFinite(value)) return '';
  if (value === 0) return '0';
  if (Math.abs(value) >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return String(Number(value.toPrecision(5)));
}

const CUSTOM_PRICE_FORMAT = {
  type: 'custom' as const,
  formatter: formatAxisNumber,
  minMove: 0.00000001,
};

/** Decimal places for the depth chart's horizontal (price) tick marks. */
function pricePrecision(price: number): number {
  if (price >= 1000) return 0;
  if (price >= 10) return 2;
  if (price >= 0.1) return 4;
  if (price >= 0.001) return 6;
  return 8;
}

function baseOptions(colors: ChartColors) {
  return {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: 'transparent' },
      textColor: colors.text,
      fontSize: 11,
    },
    grid: {
      vertLines: { color: colors.line },
      horzLines: { color: colors.line },
    },
    rightPriceScale: { borderColor: colors.line },
    timeScale: { borderColor: colors.line },
    localization: { priceFormatter: formatAxisNumber },
  };
}

/** Cumulative depth per side; equal prices merge into one point. */
function depthData(snapshot: OrderBookSnapshot) {
  const bids: { time: number; value: number }[] = [];
  let cumulative = 0;
  for (const level of snapshot.bids) {
    cumulative += Number(level.amount);
    const price = Number(level.price);
    const last = bids[bids.length - 1];
    if (last && last.time === price) last.value = cumulative;
    else bids.push({ time: price, value: cumulative });
  }
  bids.reverse(); // series data must be ascending along the price axis

  const asks: { time: number; value: number }[] = [];
  cumulative = 0;
  for (const level of snapshot.asks) {
    cumulative += Number(level.amount);
    const price = Number(level.price);
    const last = asks[asks.length - 1];
    if (last && last.time === price) last.value = cumulative;
    else asks.push({ time: price, value: cumulative });
  }
  return { bids, asks };
}

/**
 * Quote-surface samples on depth-chart axes: each sample plots at
 * (avg execution price, trade size), ascending by price. Samples priced
 * outside the book's own range are dropped so the overlay never stretches
 * the price axis beyond the depth curves.
 */
function surfaceDepthData(
  samples: { amount: string; avgPrice: string }[],
  range: { min: number; max: number } | null,
) {
  const points: { time: number; value: number }[] = [];
  for (const sample of samples) {
    const price = Number(sample.avgPrice);
    const size = Number(sample.amount);
    if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
    if (range && (price < range.min || price > range.max)) continue;
    points.push({ time: price, value: size });
  }
  points.sort((a, b) => a.time - b.time);
  return points.filter((p, i) => i === 0 || p.time !== points[i - 1].time);
}

/** Price extent of the plotted depth curves (both series are ascending). */
function priceRange(
  bids: { time: number }[],
  asks: { time: number }[],
): { min: number; max: number } | null {
  const first = bids[0] ?? asks[0];
  const last = asks[asks.length - 1] ?? bids[bids.length - 1];
  return first && last ? { min: first.time, max: last.time } : null;
}

/**
 * Order-book depth: price on the horizontal axis, cumulative size vertical.
 * When a pathfinding surface is supplied, its sell/buy samples overlay as
 * dashed marker lines on the same axes for direct comparison with the book.
 */
function DepthChart({
  snapshot,
  surface,
}: {
  snapshot: OrderBookSnapshot | null;
  surface: QuoteSurface | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApiBase<number> | null>(null);
  const bidsRef = useRef<ISeriesApi<'Area', number> | null>(null);
  const asksRef = useRef<ISeriesApi<'Area', number> | null>(null);
  const pathSellRef = useRef<ISeriesApi<'Line', number> | null>(null);
  const pathBuyRef = useRef<ISeriesApi<'Line', number> | null>(null);
  const theme = useThemeAttribute();

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const colors = readColors(el);
    const base = baseOptions(colors);
    const chart = createOptionsChart(el, {
      ...base,
      // The horizontal scale carries prices, not time.
      localization: { ...base.localization, timeFormatter: formatAxisNumber },
    });
    const sideOptions = {
      priceLineVisible: false,
      lastValueVisible: false,
      lineWidth: 2 as const,
      priceFormat: CUSTOM_PRICE_FORMAT,
    };
    bidsRef.current = chart.addSeries(AreaSeries, {
      ...sideOptions,
      lineColor: colors.buy,
      topColor: colors.buyDim,
      bottomColor: 'transparent',
    });
    asksRef.current = chart.addSeries(AreaSeries, {
      ...sideOptions,
      lineColor: colors.sell,
      topColor: colors.sellDim,
      bottomColor: 'transparent',
    });
    const pathOptions = {
      lineWidth: 2 as const,
      lineStyle: LineStyle.Dashed,
      pointMarkersVisible: true,
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: CUSTOM_PRICE_FORMAT,
    };
    pathSellRef.current = chart.addSeries(LineSeries, { ...pathOptions, color: colors.buy });
    pathBuyRef.current = chart.addSeries(LineSeries, { ...pathOptions, color: colors.sell });
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
      bidsRef.current = null;
      asksRef.current = null;
      pathSellRef.current = null;
      pathBuyRef.current = null;
    };
  }, [theme]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !bidsRef.current || !asksRef.current || !pathSellRef.current || !pathBuyRef.current) {
      return;
    }
    const { bids, asks } = snapshot ? depthData(snapshot) : { bids: [], asks: [] };
    const range = priceRange(bids, asks);
    const pathSell = surface ? surfaceDepthData(surface.sell, range) : [];
    const pathBuy = surface ? surfaceDepthData(surface.buy, range) : [];
    const referencePrice =
      asks[0]?.time ?? bids[bids.length - 1]?.time ?? pathBuy[0]?.time ?? pathSell[pathSell.length - 1]?.time;
    if (referencePrice !== undefined) {
      // precision lives on PriceChartOptions; createOptionsChart returns the
      // base interface, hence the cast.
      chart.applyOptions({
        localization: { precision: pricePrecision(referencePrice) },
      } as DeepPartial<PriceChartOptions>);
    }
    bidsRef.current.setData(bids);
    asksRef.current.setData(asks);
    pathSellRef.current.setData(pathSell);
    pathBuyRef.current.setData(pathBuy);
    chart.timeScale().fitContent();
  }, [snapshot, surface, theme]);

  return <div ref={containerRef} className="dex-chart" />;
}

/** Ascending, deduped points for one side of the quote surface. */
function surfaceSideData(samples: { amount: string; avgPrice: string }[]) {
  const points: { time: number; value: number }[] = [];
  for (const sample of samples) {
    const size = Number(sample.amount);
    const price = Number(sample.avgPrice);
    if (!Number.isFinite(size) || !Number.isFinite(price)) continue;
    const last = points[points.length - 1];
    if (last && last.time === size) last.value = price;
    else points.push({ time: size, value: price });
  }
  points.sort((a, b) => a.time - b.time);
  return points;
}

/**
 * Executable quote surface: trade size on the horizontal axis, average
 * execution price vertical. Buy side takes the ask color, sell side the bid
 * color, matching the depth chart.
 */
function SurfaceChart({ surface }: { surface: QuoteSurface | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApiBase<number> | null>(null);
  const sellRef = useRef<ISeriesApi<'Line', number> | null>(null);
  const buyRef = useRef<ISeriesApi<'Line', number> | null>(null);
  const theme = useThemeAttribute();

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const colors = readColors(el);
    const base = baseOptions(colors);
    const chart = createOptionsChart(el, {
      ...base,
      localization: { ...base.localization, timeFormatter: formatAxisNumber },
    });
    const sideOptions = {
      lineWidth: 2 as const,
      priceLineVisible: false,
      lastValueVisible: false,
      pointMarkersVisible: true,
      priceFormat: CUSTOM_PRICE_FORMAT,
    };
    sellRef.current = chart.addSeries(LineSeries, { ...sideOptions, color: colors.buy });
    buyRef.current = chart.addSeries(LineSeries, { ...sideOptions, color: colors.sell });
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
      sellRef.current = null;
      buyRef.current = null;
    };
  }, [theme]);

  useEffect(() => {
    if (!surface || !sellRef.current || !buyRef.current || !chartRef.current) return;
    const sell = surfaceSideData(surface.sell);
    const buy = surfaceSideData(surface.buy);
    const referenceSize = buy.at(-1)?.time ?? sell.at(-1)?.time;
    if (referenceSize !== undefined) {
      chartRef.current.applyOptions({
        localization: { precision: pricePrecision(referenceSize) },
      } as DeepPartial<PriceChartOptions>);
    }
    sellRef.current.setData(sell);
    buyRef.current.setData(buy);
    chartRef.current.timeScale().fitContent();
  }, [surface, theme]);

  return <div ref={containerRef} className="dex-chart" />;
}

/** Mid-price or spread over time, one point per received snapshot. */
function TimeChart({ kind, history }: { kind: 'mid' | 'spread'; history: PricePoint[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApiBase<UTCTimestamp> | null>(null);
  const seriesRef = useRef<ISeriesApi<'Line'> | ISeriesApi<'Histogram'> | null>(null);
  const theme = useThemeAttribute();

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const colors = readColors(el);
    const chart = createChart(el, {
      ...baseOptions(colors),
      timeScale: { borderColor: colors.line, timeVisible: true, secondsVisible: true },
    });
    seriesRef.current =
      kind === 'mid'
        ? chart.addSeries(LineSeries, {
            color: colors.accent,
            lineWidth: 2,
            priceLineVisible: false,
            priceFormat: CUSTOM_PRICE_FORMAT,
          })
        : chart.addSeries(HistogramSeries, {
            color: colors.warn,
            priceLineVisible: false,
            priceFormat: CUSTOM_PRICE_FORMAT,
          });
    chartRef.current = chart as IChartApiBase<UTCTimestamp>;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [kind, theme]);

  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return;
    seriesRef.current.setData(
      history.map((p) => ({ time: p.time, value: kind === 'mid' ? p.mid : p.spread })),
    );
    chartRef.current.timeScale().fitContent();
  }, [history, kind, theme]);

  return <div ref={containerRef} className="dex-chart" />;
}

export default function BookChart({
  kind,
  snapshot,
  surface,
  history,
}: {
  kind: ChartKind;
  snapshot: OrderBookSnapshot | null;
  surface: QuoteSurface | null;
  history: PricePoint[];
}) {
  if (kind === 'depth') return <DepthChart snapshot={snapshot} surface={surface} />;
  if (kind === 'quotes') return <SurfaceChart surface={surface} />;
  return <TimeChart kind={kind} history={history} />;
}
