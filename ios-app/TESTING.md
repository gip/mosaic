# Manual test script — Mosaic iOS

Run before each TestFlight build. Phases B/C sections apply once those land.

## Phase A — monitor

Setup: MCP server reachable (local dev or hosted), a root wallet with at
least one zone created from web/desktop.

1. **Login (Xaman, this phone)**: pick Testnet → Continue with Xaman → tap
   "Open in Xaman" → sign. App lands on the Zones tab with the session active.
1b. **Login (MetaMask)**: set the WalletConnect project id in Settings →
   Continue with MetaMask → approve the session and signature in MetaMask
   mobile. Same for a WC-capable Stellar wallet (Lobstr).
2. **Login (Xaman, second device)**: same flow but scan the QR from Xaman on
   another phone. Resolution must arrive without touching the app.
3. **Login rejection**: reject the payload in Xaman → app shows the rejection
   message and stays on the login screen.
4. **Zones**: zone list shows every zone with the correct mode badge
   (PROTECTED vs TESTNET). Pull to refresh.
5. **Zone detail**: agent addresses grouped per chain, copy button works,
   balances appear for funded accounts, "Not funded on-ledger" for fresh
   XRPL/Stellar addresses.
6. **Activity**: transfers/orders made on web appear in the Activity tab and
   in the zone detail's recent activity after refresh.
7. **Session persistence**: kill the app, relaunch — still logged in, zones
   reload. (Token lives in the Keychain.)
8. **Session expiry**: log the session out server-side (or wait for expiry) →
   next refresh drops the app back to login without a crash.
9. **Network switch**: Settings → Network → Mainnet. Zone list and balances
   reflect Mainnet; switch back.
10. **Server change**: Settings → set an unreachable server URL → errors
    surface (no hang); restore the default, log in again.
11. **Logout**: Settings → Log out → back to login; relaunching does not
    restore the session.

## Phase B — unlock + transfers

- Unlock via one `backup-wrap` re-signature (Xaman deeplink round trip);
  for EVM/Stellar roots the same via WalletConnect re-signing, including the
  wrong-wallet rejection.
- Unlock fallback via passphrase (Argon2id) with wrong-passphrase rejection.
- Face ID cache hit on second unlock; commitment mismatch rejected.
- Vault transfer on each chain (testnet), signed on-device, submitted via
  `transfer_submit`; activity row reaches `confirmed`.
- Device wipe → recover the zone from layer 1.

## Phase C — companion Guardian + push

- Pair with the desktop Guardian via companion QR.
- Agent start request on desktop → push arrives with the app killed →
  Face ID review → grant issued; desktop runner proceeds.
- Revoke from the phone kills the agent on desktop.
- Approval attempt while the desktop vault is locked fails with the
  "unlock desktop" message.
