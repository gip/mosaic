# ADR 0002: iOS companion Guardian

- Status: Accepted
- Date: 2026-07-21

## Decision

The iOS app is an **attended Guardian companion**: an approval/revocation
endpoint and monitor, never an agent host (ADR 0001 reserves execution for the
desktop Runner). It adds no new authority cryptography:

1. **One authority, two devices.** The approval authority remains the
   vault-derived guardian EVM key (`deriveEvmAgentKey` at the zone address
   named `guardian`). The phone derives the *same* key after unlocking the
   zone, so companion-signed messages verify under the existing Guardian
   authority — the desktop's `verifyGuardianControlEnvelope` semantics apply
   unchanged.
2. **XMTP is transport, not authorization.** The phone's XMTP identity is a
   locally generated secp256k1 transport key (Keychain,
   `AfterFirstUnlockThisDeviceOnly`, no biometry) so forwards can be received
   while every zone is locked. It signs nothing but XMTP registration.
3. **Companion protocol** (`@mosaic/local-runtime/companion`, additive to
   control V3): `companion-offer` (desktop-signed QR), `companion-enrollment`,
   `approval-forward`, `approval-decision`, `approval-resolved`. All envelopes
   are canonical JSON, digest-bound, windowed, size-capped, and EIP-191-signed
   by the guardian authority in **both** directions. The module is pure
   (noble-only) and is bundled byte-identically into `@mosaic/mobile-bridge`,
   so phone and desktop run the same code.
4. **Enrollment is proof of vault control.** A companion offer lives five
   minutes; accepting it requires the phone to sign the enrollment with the
   guardian authority key — possible only with the same zone unlocked on the
   phone. The desktop records exactly one companion inbox per Guardian.
5. **Decisions are attended.** Forwards queue while locked; acting requires
   Face ID (biometry-gated Keychain read) and an on-screen review. A decision
   binds to the forward's `payloadDigest`; replays and digest mismatches fail
   closed. Approve/reject map to the desktop's existing approval paths;
   `revoke` maps to the immediate-termination path. **Grant and key-lease
   issuance never leaves the desktop** — the phone only decides.
6. **Push is content-free.** The desktop Guardian calls the MCP `push_notify`
   tool when forwarding; APNs carries only "an approval is waiting". Zone,
   agent, and amount data travel exclusively over MCP and XMTP. Device tokens
   live in the MCP `mobile_devices` registry (session-authenticated
   `device_register`/`device_list`/`device_remove`), and dead tokens are
   dropped on delivery failure.

## Custody notes

- The phone follows the browser-zone custody model: the backend stores only
  ciphertext; the `zoneRootSecret` is unwrapped on-device and cached in the
  Keychain behind `biometryCurrentSet` + `WhenUnlockedThisDeviceOnly`.
- The frozen crypto runs as the exact `@mosaic/zone-keys` JS inside a
  networkless JavaScriptCore context (`@mosaic/mobile-bridge`); only host
  randomness is injected. Golden vectors gate the bundle in CI (Node vm) and
  on-device (XCTest, real JSC).
- JS-side secret zeroization is best-effort (JS strings are not reliably
  wipeable). This is an accepted residual risk of the same class as browser
  caches; the context is discarded on lock.

## Explicitly out of scope (future ADRs)

- The phone acting as a standalone Guardian for a Runner (certificates,
  runner-facing inboxes, grant issuance from the phone).
- Remote unlock of a locked desktop vault from the phone. A companion approval
  that needs desktop-held state while the desktop vault is locked fails with
  "unlock desktop".
- Multiple companions per Guardian, and companion revocation lists.
