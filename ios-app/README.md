# Mosaic iOS

Native SwiftUI companion app: monitor zones, balances, and agent activity;
approve zone unlocks and agent transactions (Phase C); send vault transfers
signed on-device (Phase B). See the iOS plan and ADR 0001 — the phone is an
attended Guardian companion, never an agent host.

## Layout

- `Mosaic.xcodeproj` + `Mosaic/` — thin SwiftUI app target (screens, stores).
- `MosaicKit/` — local SPM package with all logic:
  - `MosaicCore` — models mirroring the MCP tool results, `JSONValue`, config.
  - `MCPClient` — minimal MCP Streamable HTTP client (`initialize` +
    `tools/call`, SSE-framed responses) and typed wrappers mirroring
    `frontend/src/api.ts`. The bearer token is a tool argument, like web.
  - `WalletLink` — Xaman deeplink/QR payload watching (payloads are always
    server-created). WalletConnect (EVM/Stellar) lands next.
  - `ChainFeeds` — native polled balances (XRPL JSON-RPC, Horizon, Base RPC);
    amounts are decimal strings, never floats.
  - `VaultKeychain` — Keychain storage. Phase A keeps only the session token;
    Phase B adds biometry-gated zone-secret items.

## Build & test

- Open `ios-app/Mosaic.xcodeproj` in Xcode 16+, run the `Mosaic` scheme, or:
  `xcodebuild -project Mosaic.xcodeproj -scheme Mosaic -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build`
- Unit tests (macOS, no simulator needed): `cd MosaicKit && swift test`
- Live-server smoke tests: `MOSAIC_MCP_URL=http://127.0.0.1:8788/mcp swift test`
  (needs the local MCP server: `pnpm --filter @mosaic/mcp http`).

The app defaults to `http://127.0.0.1:8788/mcp` (simulator reaches the host
loopback); change it under Settings → Server.

## Custody rules (do not weaken)

Phase A holds no key material. From Phase B on: the `zoneRootSecret` is
unwrapped client-side only, cached in the Keychain behind Face ID
(`biometryCurrentSet`, `WhenUnlockedThisDeviceOnly`); the backend only ever
sees ciphertext and signed transaction blobs. `backup-wrap` signatures are
requested solely to unwrap blobs — sessions use `session-auth` only. No
`testnet-server-v1` paths exist in this app.
