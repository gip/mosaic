import { useEffect, useState } from 'react';
import type { FeedStatus, OrderBookRequest, QuoteSurface } from '@mosaic/dex';

export interface QuoteSurfaceFeedState {
  surface: QuoteSurface | null;
  status: FeedStatus;
  error: Error | null;
}

const INITIAL_STATE: QuoteSurfaceFeedState = { surface: null, status: 'idle', error: null };

/**
 * Subscribe to the executable-quote-surface feed (pathfinding) for a pair.
 * Same lifecycle rules as useOrderBookFeed: dynamic import, stop on unmount /
 * request change / disable.
 */
export function useQuoteSurfaceFeed(request: OrderBookRequest, enabled = true): QuoteSurfaceFeedState {
  const [state, setState] = useState<QuoteSurfaceFeedState>(INITIAL_STATE);

  const requestKey = enabled ? JSON.stringify(request) : '';

  // Reset stale data as soon as the pair changes (state-during-render pattern).
  const [prevKey, setPrevKey] = useState(requestKey);
  if (prevKey !== requestKey) {
    setPrevKey(requestKey);
    setState(INITIAL_STATE);
  }

  useEffect(() => {
    if (requestKey === '') return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    void (async () => {
      try {
        const { createQuoteSurfaceFeed } = await import('@mosaic/dex');
        const feed = await createQuoteSurfaceFeed(JSON.parse(requestKey) as OrderBookRequest);
        const unsubscribe = feed.subscribe((event) => {
          if (event.type === 'surface') {
            setState((s) => ({ ...s, surface: event.surface, error: null }));
          } else if (event.type === 'status') {
            setState((s) => ({ ...s, status: event.status }));
          } else {
            setState((s) => ({ ...s, error: event.error }));
          }
        });
        cleanup = () => {
          unsubscribe();
          feed.stop();
        };
        if (cancelled) {
          cleanup();
          cleanup = null;
          return;
        }
        feed.start();
      } catch (err) {
        if (!cancelled) {
          setState({
            surface: null,
            status: 'idle',
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [requestKey]);

  return state;
}
