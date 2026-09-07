# mosaic-x

Zone-derived agent wallets with a shared Web/Local UI and local agent runtime.
A user logs in with a root wallet
(Xaman / MetaMask / Freighter), creates a zone, and gets deterministic agent
addresses on EVM, XRPL, and Stellar derived from a locally generated
`zoneRootSecret`. Spec: `docs/zone_derived_agent_wallets_spec_v2.md` — read it
before touching anything cryptographic.

Read `docs/local_architecture.md`,
`docs/adr/0001-guardian-runner-trust-boundaries.md`, and
`docs/agent_control_protocol_v3.md` before changing local execution or control
authorization. Read `docs/agent_packages.md` for agent authoring, compilation,
and installation.

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
- Never regenerate frozen vectors or recorded backup-wrap signatures to make
  a failing test pass. `determinism-regression.test.mjs` protects existing blobs
  against signing-library encoding drift.
- The Xaman API secret is server-only (`@mosaic/mcp`); the browser only renders
  server-created payload QR codes.

## Layout

- `packages/catalog` — `@mosaic/catalog`: shared supported chains, asset
  deployments, and trust/preference types. Keep shared catalog definitions here.
- `packages/zone-keys` — `@mosaic/zone-keys`: pure isomorphic crypto (noble/scure
  only on the `.` entry): canonical JSON, messages, zone-seed HKDF, SLIP-0010,
  per-chain derivation + address generation, recovery blob wrap/unwrap.
  `./verify` subpath adds per-chain signature verification (viem, ripple-*).
  No network I/O ever in this package.
- `packages/web-connector` — `@mosaic/web-connector`: browser wallet
  connectivity behind one `RootWalletConnector` interface. Subpath exports
  (`./evm`, `./xrpl`, `./stellar`, `./qr`) so the frontend lazy-loads per chain.
  The MCP server must never depend on this package.
- `packages/chain-core` — `@mosaic/chain-core`: chain-agnostic market, balance,
  transfer, and trading contracts, feed lifecycle, and fixed-point arithmetic.
  No runtime dependencies or chain-specific implementations. Prices and amounts
  use decimal strings and BigInt arithmetic, not floating-point calculations.
- `packages/mosaic-xrpl`, `packages/mosaic-stellar`, `packages/mosaic-evm` —
  `@mosaic/xrpl`, `@mosaic/stellar`, `@mosaic/evm`: chain SDK integration,
  balance/market feeds, and transaction preparation/submission. XRPL and
  Stellar support DEX feeds; EVM DEX factories currently report unsupported.
  Preserve per-chain dynamic imports in `frontend/src/chains/load.ts`.
- `packages/mcp` — `@mosaic/mcp`: MCP server (Streamable HTTP) with Postgres.
  Session auth (per-chain signature verification, single-use nonces), zone
  registry, encrypted blob storage, Xaman payload proxy, XRPL
  authoritative-key ledger checks, catalog preferences, activity, and agent
  artifact storage. Store implementations live in `src/store.ts`; SQL migrations
  in `src/migrations.ts` are append-only once shipped.
- `packages/local-runtime` — shared utility-process lifecycle, IPC contracts,
  V3 control protocol, capability catalog, artifact digests, sealed key leases,
  and XMTP control transport.
- `packages/agent-sdk` — `@mosaic/agent-sdk`: inert typed agent authoring API.
- `packages/agent-compiler` — `@mosaic/agent-compiler`: `mosaic-agent`
  check/build/inspect CLI; type-checks and bundles agent projects into immutable
  content-addressed `.mosaic-agent` artifacts without installing dependencies.
- `packages/ui-theme` — shared visual tokens for Web and Local. Palette,
  spacing, typography scale, radii, and theme behavior belong here once.
- `packages/guardian` / `packages/agent-runner` — independently supervised
  local process boundaries. Guardian owns unlock, approval, policy, and grants;
  Runner verifies grants and starts isolated QuickJS child processes. See the
  trust boundary below for the limited XMTP messaging-key exception.
- `local-app` — Electron host for the shared frontend and local processes. It
  must not contain a parallel renderer UI. The runner service starts with the
  app; individual agents start only after their zone is unlocked by the signer.
- `frontend` — the Vite + React 19 app rendered by both Web and Local. Local
  capabilities are detected through the optional preload bridge; `/agents` is
  shown in Electron and uses the same providers, MCP client, components, CSS,
  and assets as every other route.

## Local agent trust boundary

- MCP is an untrusted control plane for metadata, artifacts, ciphertext, and
  revocation distribution; it cannot issue execution grants.
- Guardian owns approval and control transport. Its logical Vault Core is
  networkless and never starts processes. No process that has loaded a zone
  secret or transaction key may spawn agent code.
- Runner must never receive zone secrets, transaction keys, Guardian identity
  keys, or a generic signing oracle. Its only leased secrets are independently
  generated agent XMTP credentials (`xmtp-owner`, `xmtp-database`, custody
  `supervisor-session`). They allow messaging impersonation, not fund movement.
- Electron–Guardian communication uses typed utility-process IPC; Guardian–
  Runner control uses XMTP. Wallet signatures, passphrases, and MCP session
  tokens stay out of XMTP. Agent source is fetched through scoped MCP tickets.
- Grants are signed, bound to the Runner and installation digests, and fixed
  for at most 24 hours with matching key leases. Preserve replay, expiry,
  revocation, and digest checks; no renewal or routine per-hook Guardian calls.
- QuickJS exposes reviewed typed hooks only, with resource limits and no Node
  globals, filesystem, environment, native modules, or raw network access.
  Currently grantable operations are state, log, clock, random, and agent XMTP.
  Agent transaction execution, LLM, WebSocket, and scheduling stay default-deny
  until their policy brokers exist.

## Commands

- Use Node.js 24 and pnpm 10 (the CI versions).
- `pnpm install --frozen-lockfile` for the committed dependency set. Use
  `pnpm install` when intentionally updating dependencies. **Never `npm install`.**
- `pnpm build` / `pnpm typecheck` — root `tsc -b` project references. These
  compile libraries and the Electron host, but do not build or check frontend.
- `pnpm -r build` — full workspace build, including Vite assets; CI runs this.
- `pnpm test` — recursive package tests. Library suites use
  `tsc -b && node --test test/*.test.mjs` (Node built-in runner, no vitest/jest).
  Local app's test script only type-checks; frontend builds its workspace
  dependencies and runs Node tests for local transaction review validation.
- `pnpm --filter <package-name> test` — targeted package suite.
- `pnpm --filter frontend build` and `pnpm --filter frontend lint` — frontend
  TypeScript/Vite validation and ESLint; run for relevant frontend changes.
- `pnpm --filter @mosaic/mcp http` — run the MCP server (needs Postgres:
  `docker compose up -d`, and `.env` per `.env.example`).
- `pnpm --filter frontend dev` — Vite dev server.
- `pnpm local:dev` — build and run the Electron local app.
- `pnpm --filter @mosaic/guardian start -- [vault] --network testnet` — run Mosaic Guardian (defaults to vault `mosaic-agent-guardian` and Testnet).
- `pnpm vault:recover ./backup.json` — local recovery CLI; private-key output
  requires explicit `--show-private-keys` and must never enter logs.
- Postgres tests run only when `MOSAIC_TEST_DATABASE_URL` is set; MemoryStore
  tests always run. CI supplies Postgres 17 and runs the database suites.
- Live XMTP dev-network tests are opt-in with `MOSAIC_XMTP_INTEGRATION=1`.

Use `.env.example` for server configuration. The MCP CLI loads the nearest
`.env` up to the workspace root, or `MOSAIC_ENV_FILE`. Configure the required
UInt32 `MOSAIC_XRPL_SOURCE_TAG`; server-managed Testnet vaults require a stable
`MOSAIC_TESTNET_VAULT_KEY`. WalletConnect uses frontend
`VITE_WALLETCONNECT_PROJECT_ID`. Keep server secrets out of `VITE_*` variables.

Validate the affected packages and their consumers when shared contracts change.
For crypto changes run the complete zone-keys suite; for store changes include
Postgres tests when available. Report skipped integration checks explicitly.

## Conventions

- TypeScript `~6.0.2` everywhere, ESM-only (`"type": "module"`), packages built
  with plain `tsc` (no bundler for libs), `workspace:*` internal deps,
  `@mosaic/*` scope.
- Library and local-app TypeScript projects extend `tsconfig.base.json`
  (`composite: true`). Register new TS packages in root `tsconfig.json` and add
  consumer project references and `workspace:*` dependencies. The workspace
  already includes `packages/*`; edit `pnpm-workspace.yaml` for other locations.
  Frontend has separate Vite TS configs; `ui-theme` is CSS-only.
- ESLint flat-config in `frontend/` only; no prettier anywhere.
- Web and Local render the same `frontend`; never build a separate Electron
  renderer or copy screens/components/styles into `local-app`. Keep styling
  plain CSS with no Tailwind/CSS-in-JS. Platform behavior goes behind the
  optional Electron preload bridge.
