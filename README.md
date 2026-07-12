# mosaic-x

Zone-derived agent wallets — browser-zone MVP.

Log in with a root wallet — mobile app first, by scanning a QR (Xaman on XRPL,
MetaMask mobile on EVM, Freighter mobile on Stellar; browser extensions are a
small fallback that can't authorize agents) — create a zone, and get
deterministic agent
addresses on EVM, XRPL, and Stellar derived from a locally generated
`zoneRootSecret`. Mainnet and protected browser zones are non-custodial: the
backend stores only ciphertext it cannot decrypt. Testnet uses an explicit
server-managed sandbox mode because its accounts have no Mainnet funds; an
authenticated session can unlock those vaults on any device.

Spec: [`docs/zone_derived_agent_wallets_spec_v2.md`](docs/zone_derived_agent_wallets_spec_v2.md).
Conventions and custody boundary: [`CLAUDE.md`](CLAUDE.md).

## Layout

| Path | Package | What it is |
|---|---|---|
| `packages/zone-keys` | `@mosaic/zone-keys` | Pure isomorphic crypto: canonical messages, HKDF zone seeds, BIP44/SLIP-0010 derivation, address generation, recovery-blob AEAD. `./verify` subpath adds per-chain signature verification. Frozen golden vectors in `vectors/`. |
| `packages/web-connector` | `@mosaic/web-connector` | Browser wallet connectivity: WalletConnect QR to MetaMask mobile + EIP-6963 extension fallback (EVM), WalletConnect QR to Freighter mobile + extension fallback (Stellar), Xaman payload QR/websocket helpers (XRPL). |
| `packages/mcp` | `@mosaic/mcp` | MCP server (Streamable HTTP) with Postgres: per-chain session auth, zone registry, encrypted blob storage, Xaman payload proxy, XRPL authoritative-key checks. |
| `packages/ui-theme` | `@mosaic/ui-theme` | Shared Web/Local design tokens: palette, spacing, typography scale, radii, and dark/light themes. |
| `packages/local-runtime` | `@mosaic/local-runtime` | Shared Electron/Node utility-process lifecycle and IPC contract. |
| `packages/guardian` | `@mosaic/guardian` | Mosaic Guardian: local MCP session, vault unlock, encrypted vault data, XMTP control identity, and networkless lease/policy core. |
| `packages/agent-runner` | `@mosaic/agent-runner` | Independently supervised Agent Runner that verifies Guardian grants and spawns isolated QuickJS agents. |
| `local-app` | `@mosaic/local-app` | Electron host for the shared frontend plus Mosaic Guardian and Agent Runner processes. It adds a narrow preload bridge, not a second UI. |
| `frontend` | — | The shared Vite + React 19 application rendered by both Web and Local. Local exposes an additional `/agents` navigation item through its Electron bridge. |

## Quick start

```sh
pnpm install
pnpm build

# 1. Postgres
docker compose up -d

# 2. Server env (.env from .env.example; Xaman keys from https://apps.xaman.dev)
export MOSAIC_DATABASE_URL=postgres://mosaic:mosaic@localhost:5432/mosaic
export XAMAN_API_KEY=... XAMAN_API_SECRET=...
pnpm --filter @mosaic/mcp http

# 3. Frontend (WalletConnect project id from https://cloud.reown.com)
cd frontend
VITE_WALLETCONNECT_PROJECT_ID=... pnpm dev

# Local desktop process scaffold (separate terminal)
pnpm local:dev
```

Login is mobile-wallet-first: each tile shows a QR to scan with the wallet's
phone app (Xaman natively; MetaMask mobile and Freighter mobile pair over
WalletConnect — Freighter mobile has no other dapp transport). Without Xaman
keys the XRPL tile reports itself unavailable; without a WalletConnect project
id the EVM/Stellar QR tiles explain what to set. The extension fallback
buttons work with no configuration, but extension logins are locked to one
browser and can't authorize agents.

For wallet-less development, `VITE_DEMO_WALLET=<0x-privkey> pnpm dev` adds a
dev-only "Demo wallet" button (an in-page deterministic EVM key) that drives
every real flow — login, ceremony, unlock — against the real server.

## Tests

```sh
pnpm test                                  # all packages (node --test)
MOSAIC_TEST_DATABASE_URL=postgres://mosaic:mosaic@localhost:5432/mosaic \
  pnpm --filter @mosaic/mcp test           # + real-Postgres store tests
```

Release-blocking suites in `@mosaic/zone-keys`: frozen derivation vectors,
SLIP-0010/SEP-0005/BIP44 cross-checks, blob round-trips + tamper cases, and a
determinism-regression test that re-verifies recorded backup-wrap signatures
against current library versions — if that one fails, an encoding drift would
strand existing layer-1 blobs; never update the recorded values.

## Custody model (browser zones)

Mainnet and signed browser zones are non-custodial for key material, with a
software-delivery trust assumption:

- `zoneRootSecret` is generated in the browser (CSPRNG) and held in memory;
  IndexedDB caches it wrapped under a non-extractable WebCrypto key.
- Layer 1: the wallet's deterministic `backup-wrap` signature derives the wrap
  key for an XChaCha20-Poly1305 blob stored server-side (+ auto-downloaded).
  A double-sign self-test at creation hard-rejects non-deterministic wallets
  (hardware / smart-contract wallets) for browser zones.
- Layer 2: a mandatory Argon2id (m=256 MiB, t=3, p=1) passphrase blob covers
  wallet signing-behavior drift.
- Sessions authenticate via `session-auth` messages only — users are never
  asked to sign `backup-wrap` to log in.

Testnet sandbox exception:

- New Testnet sandbox vaults use `testnet-server-v1` and are envelope-encrypted
  under `MOSAIC_TESTNET_VAULT_KEY` on the MCP server.
- A session authenticated for the owning root wallet may request the secret on
  any device; the browser still caches it locally for the current session.
- This is intentionally server-managed and must never be used for Mainnet
  vaults. Legacy `testnet-device-v1` vaults remain device-bound.
