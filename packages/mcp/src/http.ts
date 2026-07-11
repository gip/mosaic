import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { AuthService } from './auth.js';
import { envNumber, envString } from './env.js';
import { classifyMcpError, errorMessage, MosaicMcpError } from './errors.js';
import { createMosaicMcpServer, type MosaicMcpOptions } from './server.js';
import { openMosaicStore } from './store.js';
import { xamanServiceFromEnv } from './xaman.js';
import { xrplRpcUrl } from './xrplLedger.js';

export interface HttpServerOptions extends MosaicMcpOptions {
  bind?: string;
  corsOrigin?: string;
}

type TransportRecord = { transport: StreamableHTTPServerTransport; lastUsed: number; openStreams: number };

function parseBind(bind: string): { host: string; port: number } {
  const [host, rawPort] = bind.includes(':') ? bind.split(':') : ['127.0.0.1', bind];
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 0) throw new Error(`invalid MOSAIC_BIND: ${bind}`);
  return { host: host || '127.0.0.1', port };
}

function parseOrigins(value: string): Set<string> {
  // Origins are scheme://host[:port] — the browser's Origin header never has a
  // trailing slash, so strip any pasted from a URL bar before exact-matching.
  return new Set(
    value
      .split(',')
      .map((item) => item.trim().replace(/\/+$/, ''))
      .filter(Boolean),
  );
}

function loopbackDevOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin);
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (maxBytes > 0 && total > maxBytes) {
      throw new MosaicMcpError('VALIDATION_FAILED', `request body exceeds ${maxBytes} bytes`, { status: 413 });
    }
    chunks.push(buf);
  }
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function writeCors(req: IncomingMessage, res: ServerResponse, allowedOrigins: Set<string>): boolean {
  const origin = req.headers.origin;
  const allowed =
    typeof origin === 'string' &&
    (allowedOrigins.has('*') ||
      allowedOrigins.has(origin) ||
      (process.env.NODE_ENV !== 'production' && loopbackDevOrigin(origin)));
  if (!origin) return true;
  if (!allowed) return false;
  res.setHeader('access-control-allow-origin', allowedOrigins.has('*') ? '*' : origin);
  res.setHeader('vary', 'Origin');
  res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader(
    'access-control-allow-headers',
    req.headers['access-control-request-headers'] ??
      'accept,authorization,content-type,last-event-id,mcp-protocol-version,mcp-session-id',
  );
  res.setHeader('access-control-expose-headers', 'mcp-session-id,mcp-protocol-version');
  if (req.headers['access-control-request-private-network']) {
    res.setHeader('access-control-allow-private-network', 'true');
  }
  return true;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function jsonRpcId(body: unknown): unknown {
  if (body && typeof body === 'object' && 'id' in body) return (body as { id?: unknown }).id ?? null;
  return null;
}

async function probe(run: () => Promise<unknown>): Promise<{ value: unknown; ok: boolean }> {
  try {
    return { value: await run(), ok: true };
  } catch (error) {
    return { value: { ok: false, error: errorMessage(error) }, ok: false };
  }
}

async function readiness(store: NonNullable<MosaicMcpOptions['store']>, xamanConfigured: boolean) {
  const probes: [string, Promise<{ value: unknown; ok: boolean }>][] = [
    ['store', probe(() => store.healthCheck())],
    [
      'xrpl_rpc',
      probe(async () => {
        const res = await fetch(xrplRpcUrl('testnet'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method: 'server_info', params: [{}] }),
          signal: AbortSignal.timeout(3_000),
        });
        if (!res.ok) throw new Error(`${res.status}`);
        return { ok: true };
      }),
    ],
  ];
  const checks: Record<string, unknown> = { xaman_configured: xamanConfigured };
  let ok = true;
  for (const [name, pending] of probes) {
    const result = await pending;
    checks[name] = result.value;
    if (!result.ok) ok = false;
  }
  return { ok, checks };
}

export async function startHttpServer(opts: HttpServerOptions = {}): Promise<{ close(): Promise<void>; url: string }> {
  const bind = opts.bind ?? envString('MOSAIC_BIND') ?? `127.0.0.1:${envNumber('MOSAIC_MCP_PORT', 8788)}`;
  const { host, port } = parseBind(bind);
  const corsOrigins = parseOrigins(
    opts.corsOrigin ?? envString('MOSAIC_CORS_ORIGIN') ?? 'http://localhost:5173,http://127.0.0.1:5173,http://127.0.0.1:4174',
  );
  const store = opts.store ?? openMosaicStore(envString('MOSAIC_DATABASE_URL'));
  await store.init();
  const xaman = opts.xaman ?? xamanServiceFromEnv();
  // One AuthService for the whole process: a per-session AuthService would
  // reset the rate limiter on each initialize and leave verify brute-forceable.
  const auth = opts.auth ?? new AuthService(store, xaman);
  const serverOptions: MosaicMcpOptions = { ...opts, store, xaman, auth };

  const transports = new Map<string, TransportRecord>();
  const maxBodyBytes = envNumber('MOSAIC_MCP_MAX_BODY_BYTES', 1024 * 1024, { allowZero: true });
  const transportTtlMs = envNumber('MOSAIC_MCP_TRANSPORT_TTL_MS', 30 * 60_000, { allowZero: true });

  const cleanup = setInterval(() => {
    const cutoff = Date.now() - transportTtlMs;
    for (const [id, record] of transports) {
      if (record.openStreams <= 0 && record.lastUsed < cutoff) {
        record.transport.close?.();
        transports.delete(id);
      }
    }
  }, Math.max(transportTtlMs / 2, 30_000));
  cleanup.unref?.();

  const sweep = setInterval(() => void store.sweepExpired().catch(() => {}), 10 * 60_000);
  sweep.unref?.();

  const http = createServer(async (req, res) => {
    const corsOk = writeCors(req, res, corsOrigins);
    if (req.method === 'OPTIONS') {
      res.writeHead(corsOk ? 204 : 403);
      res.end();
      return;
    }
    if (!corsOk) {
      sendJson(res, 403, { error: 'CORS origin not allowed' });
      return;
    }
    const path = req.url?.split('?')[0];
    if (path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (path === '/readyz') {
      const ready = await readiness(store, Boolean(xaman));
      sendJson(res, ready.ok ? 200 : 503, ready);
      return;
    }
    if (path !== '/mcp') {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    let parsedBody: unknown;
    try {
      parsedBody = req.method === 'POST' ? await readJson(req, maxBodyBytes) : undefined;
      const sessionId = req.headers['mcp-session-id'];
      const record = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;
      let transport = record?.transport;
      if (!record) {
        if (req.method !== 'POST' || !isInitializeRequest(parsedBody)) {
          sendJson(res, 400, {
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: initialize first' },
            id: null,
          });
          return;
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, { transport: transport!, lastUsed: Date.now(), openStreams: 0 });
          },
        });
        transport.onclose = () => {
          const id = transport?.sessionId;
          if (id) transports.delete(id);
        };
        await createMosaicMcpServer(serverOptions).connect(transport);
      } else {
        record.lastUsed = Date.now();
        record.openStreams += 1;
        res.on('close', () => {
          record.openStreams -= 1;
          record.lastUsed = Date.now();
        });
      }
      if (!transport) throw new MosaicMcpError('INTERNAL', 'MCP transport was not initialized');
      await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      if (!res.headersSent) {
        const classified = classifyMcpError(error);
        sendJson(res, classified.status, {
          jsonrpc: '2.0',
          error: { code: -32603, message: classified.message, data: classified.body() },
          id: jsonRpcId(parsedBody),
        });
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, () => {
      http.off('error', reject);
      resolve();
    });
  });
  const address = http.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  return {
    url: `http://${host}:${actualPort}/mcp`,
    close: () =>
      new Promise((resolve, reject) => {
        clearInterval(cleanup);
        clearInterval(sweep);
        for (const record of transports.values()) record.transport.close?.();
        void store.close();
        http.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
