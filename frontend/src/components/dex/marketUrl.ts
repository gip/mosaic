import type { Asset } from '@mosaic/chain-core';
import { loadChainModule, type ChainModule } from '../../chains/load';

export type MarketChain = 'xrpl' | 'stellar';
export type MarketAssetKind = 'native' | 'issued';

export interface MarketAssetDraft {
  kind: MarketAssetKind;
  symbol: string;
  issuer: string;
  currency: string;
}

export interface MarketDraft {
  base: MarketAssetDraft;
  quote: MarketAssetDraft;
}

type AssetField = 'symbol' | 'issuer' | 'currency' | 'kind';
export type MarketAssetErrors = Partial<Record<AssetField, string>>;

export interface MarketDraftErrors {
  base: MarketAssetErrors;
  quote: MarketAssetErrors;
  pair?: string;
  query?: string[];
}

export interface ValidatedMarketDraft {
  base: Asset;
  quote: Asset;
  baseSymbol: string;
  quoteSymbol: string;
}

export interface MarketValidation {
  value: ValidatedMarketDraft | null;
  errors: MarketDraftErrors;
}

const QUERY_KEYS = ['base', 'baseIssuer', 'baseCurrency', 'quote', 'quoteIssuer', 'quoteCurrency'] as const;

export function nativeSymbol(chain: MarketChain): 'XRP' | 'XLM' {
  return chain === 'xrpl' ? 'XRP' : 'XLM';
}

/** Decode printable, right-zero-padded XRPL currency values for form assistance. */
export function decodePrintableCurrency(value: string): string | null {
  const code = value.trim();
  if (/^[!-~]{3}$/.test(code) && code.toUpperCase() !== 'XRP') return code;
  if (!/^[0-9A-Fa-f]{40}$/.test(code)) return null;
  const bytes = Uint8Array.from(code.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)));
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  if (end === 0 || bytes.slice(0, end).some((byte) => byte < 0x21 || byte > 0x7e)) return null;
  return new TextDecoder().decode(bytes.slice(0, end));
}

function queryValue(params: URLSearchParams, key: (typeof QUERY_KEYS)[number]): string {
  return params.get(key)?.trim() ?? '';
}

function draftAsset(
  chain: MarketChain,
  symbol: string,
  issuer: string,
  currency: string,
  defaultNative: boolean,
): MarketAssetDraft {
  const assistedSymbol = symbol || (chain === 'xrpl' ? decodePrintableCurrency(currency) ?? '' : '');
  const noAssetInput = !symbol && !issuer && !currency;
  const resolvedSymbol = noAssetInput && defaultNative ? nativeSymbol(chain) : assistedSymbol;
  return {
    kind: resolvedSymbol.toUpperCase() === nativeSymbol(chain) ? 'native' : 'issued',
    symbol: resolvedSymbol,
    issuer,
    currency,
  };
}

export function parseMarketQuery(chain: MarketChain, search: string): { draft: MarketDraft; queryErrors: string[] } {
  const params = new URLSearchParams(search);
  const queryErrors = QUERY_KEYS.flatMap((key) => params.getAll(key).length > 1 ? [`${key} must appear only once`] : []);
  const base = queryValue(params, 'base');
  const quote = queryValue(params, 'quote');
  if (!base) queryErrors.push('base is required');
  if (!quote) queryErrors.push('quote is required');
  return {
    draft: {
      base: draftAsset(chain, base, queryValue(params, 'baseIssuer'), queryValue(params, 'baseCurrency'), true),
      quote: draftAsset(chain, quote, queryValue(params, 'quoteIssuer'), queryValue(params, 'quoteCurrency'), false),
    },
    queryErrors,
  };
}

function sameAsset(left: Asset, right: Asset): boolean {
  if (left.kind === 'native' || right.kind === 'native') return left.kind === right.kind;
  return left.issuer === right.issuer
    && (left.currencyCode ?? left.code) === (right.currencyCode ?? right.code);
}

export async function validateMarketDraft(chain: MarketChain, draft: MarketDraft): Promise<MarketValidation> {
  const errors: MarketDraftErrors = { base: {}, quote: {} };
  let module: ChainModule;
  try {
    module = await loadChainModule(chain);
  } catch (cause) {
    errors.query = [`Could not load ${chain.toUpperCase()} validation: ${cause instanceof Error ? cause.message : String(cause)}`];
    return { value: null, errors };
  }

  function validateAsset(side: 'base' | 'quote'): Asset | null {
    const input = draft[side];
    const fieldErrors = errors[side];
    const symbol = input.symbol.trim();
    const issuer = input.issuer.trim();
    const currency = input.currency.trim();
    const native = nativeSymbol(chain);

    if (input.kind === 'native') {
      if (symbol.toUpperCase() !== native) fieldErrors.symbol = `Native ${chain.toUpperCase()} markets use ${native}`;
      if (issuer) fieldErrors.issuer = `${native} does not have an issuer`;
      if (currency) fieldErrors.currency = `${native} does not have an issued currency code`;
      return Object.keys(fieldErrors).length === 0 ? { kind: 'native' } : null;
    }

    if (!symbol) fieldErrors.symbol = 'Enter the asset symbol';
    if (symbol.toUpperCase() === native) fieldErrors.kind = `Choose Native for ${native}`;
    if (!issuer) fieldErrors.issuer = 'Enter the issuer address';

    if (chain === 'stellar') {
      if (symbol && !/^[A-Za-z0-9]{1,12}$/.test(symbol)) fieldErrors.symbol = 'Use 1–12 letters or numbers';
      if (issuer && !module.isValidStellarIssuer?.(issuer)) fieldErrors.issuer = 'Enter a valid Stellar G-address';
      if (currency) fieldErrors.currency = 'Stellar assets do not use an encoded currency value';
      return Object.keys(fieldErrors).length === 0 ? { kind: 'issued', code: symbol, issuer } : null;
    }

    if (issuer && !module.isValidXrplIssuer?.(issuer)) fieldErrors.issuer = 'Enter a valid classic XRPL r-address';
    if (symbol) {
      try {
        module.normalizeCurrency!(symbol);
      } catch (cause) {
        fieldErrors.symbol = cause instanceof Error ? cause.message : String(cause);
      }
    }
    let normalizedCurrency = '';
    if (symbol || currency) {
      try {
        normalizedCurrency = module.normalizeCurrency!(currency || symbol);
      } catch (cause) {
        fieldErrors.currency = cause instanceof Error ? cause.message : String(cause);
      }
    }
    if (currency && normalizedCurrency) {
      const decoded = module.decodeCurrency?.(normalizedCurrency);
      if (decoded && symbol && decoded !== symbol) {
        fieldErrors.currency = `Currency decodes to ${decoded}, not ${symbol}`;
      }
    }
    return Object.keys(fieldErrors).length === 0
      ? { kind: 'issued', code: symbol, issuer, currencyCode: normalizedCurrency }
      : null;
  }

  const base = validateAsset('base');
  const quote = validateAsset('quote');
  if (base && quote && sameAsset(base, quote)) errors.pair = 'Base and quote must be different assets';
  if (!base || !quote || errors.pair) return { value: null, errors };
  return {
    value: {
      base,
      quote,
      baseSymbol: base.kind === 'native' ? nativeSymbol(chain) : draft.base.symbol.trim(),
      quoteSymbol: quote.kind === 'native' ? nativeSymbol(chain) : draft.quote.symbol.trim(),
    },
    errors,
  };
}

export function serializeMarketQuery(chain: MarketChain, value: ValidatedMarketDraft): string {
  const params = new URLSearchParams();
  function append(side: 'base' | 'quote', asset: Asset, symbol: string) {
    params.set(side, asset.kind === 'native' ? nativeSymbol(chain) : symbol);
    if (asset.kind === 'issued') {
      params.set(`${side}Issuer`, asset.issuer);
      if (chain === 'xrpl') params.set(`${side}Currency`, asset.currencyCode ?? asset.code);
    }
  }
  append('base', value.base, value.baseSymbol);
  append('quote', value.quote, value.quoteSymbol);
  return params.toString();
}
