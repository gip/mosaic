# mosaic-x

Zone-derived agent wallets, browser-zone MVP. A user logs in with a root wallet
(Xaman / MetaMask / Freighter), creates a zone, and gets deterministic agent
addresses on EVM, XRPL, and Stellar derived from a locally generated
`zoneRootSecret`. Spec: `docs/zone_derived_agent_wallets_spec_v2.md` — read it
before touching anything cryptographic.

## Custody boundary (do not weaken for Mainnet)

For Mainnet and protected browser zones, the backend stores only ciphertext. It
must never receive raw private keys, `zoneRootSecret`, or any signature usable
to derive keys. Browser zones are
"non-custodial with a software-delivery trust assumption": the wrapped blob on
the backend is the source of truth; browser storage is only a session cache;
the secret is always one wallet signature away.

Testnet has an explicit `testnet-server-v1` sandbox exception: the MCP server
may envelope-encrypt and release the Testnet `zoneRootSecret` to the owning
authenticated session because Testnet accounts cannot access Mainnet funds.
This mode is server-managed, must be clearly labeled, and must never be used
for Mainnet.

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
- `packages/local-runtime` — shared utility-process lifecycle and IPC contract
  for the Electron host, Mosaic Guardian, and Agent Runner.
- `packages/ui-theme` — shared visual tokens for Web and Local. Palette,
  spacing, typography scale, radii, and theme behavior belong here once.
- `packages/guardian` / `packages/agent-runner` — independently supervised
  local process boundaries. The runner never receives zone secrets or keys.
- `local-app` — Electron host for the shared frontend and local processes. It
  must not contain a parallel renderer UI. The runner service starts with the
  app; individual agents start only after their zone is unlocked by the signer.
- `frontend` — the Vite + React 19 app rendered by both Web and Local. Local
  capabilities are detected through the optional preload bridge; `/agents` is
  shown in Electron and uses the same providers, MCP client, components, CSS,
  and assets as every other route.

## Commands

- `pnpm install` once at root. **Never `npm install`.**
- `pnpm build` — builds the whole TS graph via `tsc -b` project references.
- `pnpm test` — `pnpm -r test`; each package runs `tsc -b && node --test test/*.test.mjs`
  (Node built-in runner, no vitest/jest).
- `pnpm --filter @mosaic/mcp http` — run the MCP server (needs Postgres:
  `docker compose up -d`, and `.env` per `.env.example`).
- `pnpm --filter frontend dev` — Vite dev server.
- `pnpm local:dev` — build and run the Electron local app.
- `pnpm --filter @mosaic/guardian start -- [vault] --network testnet` — run Mosaic Guardian (defaults to vault `mosaic-agent-guardian` and Testnet).
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
- Web and Local render the same `frontend`; never build a separate Electron
  renderer or copy screens/components/styles into `local-app`. Keep styling
  plain CSS with no Tailwind/CSS-in-JS. Platform behavior goes behind the
  optional Electron preload bridge.
