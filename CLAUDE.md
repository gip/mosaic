# mosaic-x

Zone-derived agent wallets, browser-zone MVP. A user logs in with a root wallet
(Xaman / MetaMask / Freighter), creates a zone, and gets deterministic agent
addresses on EVM, XRPL, and Stellar derived from a locally generated
`zoneRootSecret`. Spec: `docs/zone_derived_agent_wallets_spec_v2.md` — read it
before touching anything cryptographic.

## Custody boundary (do not weaken)

The backend stores only ciphertext. It must never receive raw private keys,
`zoneRootSecret`, or any signature usable to derive keys. Browser zones are
"non-custodial with a software-delivery trust assumption": the wrapped blob on
the backend is the source of truth; browser storage is only a session cache;
the secret is always one wallet signature away.

- `backup-wrap` signatures unwrap blobs. Never ask users to sign `backup-wrap`
  for login — sessions use `session-auth` only.
- Canonical message shapes, HKDF info strings, and derivation paths are
  **frozen**. Changing any of them re-keys every zone. Golden vectors in
  `packages/zone-keys/vectors/` are release-blocking.
- The Xaman API secret is server-only (`@mosaic/mcp`); the browser only renders
  server-created payload QR codes.

## Layout

- `packages/zone-keys` — `@mosaic/zone-keys`: pure isomorphic crypto (noble/scure
  only on the `.` entry): canonical JSON, messages, zone-seed HKDF, SLIP-0010,
  per-chain derivation + address generation, recovery blob wrap/unwrap.
  `./verify` subpath adds per-chain signature verification (viem, ripple-*).
  No network I/O ever in this package.
- `packages/web-connector` — `@mosaic/web-connector`: browser wallet
  connectivity behind one `RootWalletConnector` interface. Subpath exports
  (`./evm`, `./xrpl`, `./stellar`, `./qr`) so the frontend lazy-loads per chain.
  The MCP server must never depend on this package.
- `packages/mcp` — `@mosaic/mcp`: MCP server (Streamable HTTP) with Postgres.
  Session auth (per-chain signature verification, single-use nonces), zone
  registry, encrypted blob storage, Xaman payload proxy, XRPL
  authoritative-key ledger checks.
- `frontend` — Vite + React 19 app. UI theme copied from stellar-mosaic-x
  (plain CSS, `data-theme` tokens, Zed Sans/Mono).

## Commands

- `pnpm install` once at root. **Never `npm install`.**
- `pnpm build` — builds the whole TS graph via `tsc -b` project references.
- `pnpm test` — `pnpm -r test`; each package runs `tsc -b && node --test test/*.test.mjs`
  (Node built-in runner, no vitest/jest).
- `pnpm --filter @mosaic/mcp http` — run the MCP server (needs Postgres:
  `docker compose up -d`, and `.env` per `.env.example`).
- `pnpm --filter frontend dev` — Vite dev server.
- Postgres tests run only when `MOSAIC_TEST_DATABASE_URL` is set; MemoryStore
  tests always run.

## Conventions

- TypeScript `~6.0.2` everywhere, ESM-only (`"type": "module"`), packages built
  with plain `tsc` (no bundler for libs), `workspace:*` internal deps,
  `@mosaic/*` scope.
- TS project references: every package `tsconfig.json` extends
  `tsconfig.base.json` (`composite: true`); root `tsconfig.json` lists
  references. Add new packages there and to `pnpm-workspace.yaml`.
- ESLint flat-config in `frontend/` only; no prettier anywhere.
- Frontend styling is plain CSS with theme tokens (`src/styles/tokens.css`);
  no Tailwind/CSS-in-JS. Dark is default; light via `[data-theme="light"]`.
