/**
 * Thin Xaman client. All payload creation and result fetching go through the
 * MCP server (the API secret is server-only); the browser's job is to render
 * the payload QR and watch the status websocket until the user signs on
 * their phone.
 */

export interface XamanPayloadRefs {
  uuid: string;
  qrPng: string;
  websocketStatus: string;
  deeplink: string;
}

export interface XamanWatchResult {
  signed: boolean;
  expired: boolean;
}

/**
 * Watch a Xaman payload status websocket until it resolves. Xaman pushes JSON
 * frames; `{signed: true|false}` fires on user action, `{expired: true}` when
 * the payload times out.
 */
export function watchXamanPayload(
  websocketStatus: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<XamanWatchResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(websocketStatus);
    const timeout = setTimeout(() => finish(new Error('Xaman payload timed out')), opts.timeoutMs ?? 5 * 60_000);

    const finish = (error: Error | null, result?: XamanWatchResult) => {
      clearTimeout(timeout);
      opts.signal?.removeEventListener('abort', onAbort);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      if (error) reject(error);
      else resolve(result!);
    };
    const onAbort = () => finish(new Error('cancelled'));
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    ws.onmessage = (event) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof data.signed === 'boolean') {
        finish(null, { signed: data.signed, expired: false });
      } else if (data.expired === true) {
        finish(null, { signed: false, expired: true });
      }
    };
    ws.onerror = () => finish(new Error('Xaman status websocket failed'));
  });
}
