import { useEffect, useState } from 'react';
import type { FeedStatus, OrderBookRequest, OrderBookSnapshot } from '@mosaic/dex';

export interface OrderBookFeedState {
  snapshot: OrderBookSnapshot | null;
  status: FeedStatus;
  error: Error | null;
}

/**
 * Subscribe to a streaming order-book feed for the given pair. `@mosaic/dex`
 * is imported dynamically so it stays out of the entry chunk; the feed is
 * stopped on unmount, when the request changes, or when `enabled` is false.
 */
const INITIAL_STATE: OrderBookFeedState = { snapshot: null, status: 'idle', error: null };

export function useOrderBookFeed(request: OrderBookRequest, enabled = true): OrderBookFeedState {
  const [state, setState] = useState<OrderBookFeedState>(INITIAL_STATE);

  // The request is plain data; keying the effect on its JSON avoids re-running
  // when callers pass a fresh-but-equal object on every render.
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
        const { createOrderBookFeed } = await import('@mosaic/dex');
        const feed = await createOrderBookFeed(JSON.parse(requestKey) as OrderBookRequest);
        const unsubscribe = feed.subscribe((event) => {
          if (event.type === 'snapshot') {
            setState((s) => ({ ...s, snapshot: event.snapshot, error: null }));
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
            snapshot: null,
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

export function isUnsupportedChain(error: Error | null): boolean {
  return error !== null && (error as { code?: string }).code === 'UNSUPPORTED_CHAIN';
}
