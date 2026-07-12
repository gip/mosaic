# Zone-Derived Agent Wallets — Production Spec v2

Non-custodial local signer with deterministic agent key derivation, wallet-signature recovery, and on-chain root sweep authority.

## Product Claim

> Agent keys derive from a locally generated zone secret. The secret is recoverable via your root wallet signature or your backup passphrase; the platform stores only ciphertext it cannot decrypt. On XRPL and Stellar, your root wallet additionally retains on-chain signing authority over agent accounts as a last-resort sweep path.

Not claimed: trustless. The user trusts the local signer application and their own machine. The zone system inherits the root wallet's own recovery story (seed phrase) as its floor — loss of the root wallet loses everything.

## Custody Boundary

The platform is non-custodial for Mainnet and protected browser-zone key
material. The backend never receives:

1. Raw private keys
2. `zoneRootSecret`
3. Any signature usable to derive keys (backup signatures unwrap only ciphertext the attacker must separately obtain)

Testnet sandbox exception: Testnet-only vaults may use the explicitly
server-managed `testnet-server-v1` policy. The MCP server envelope-encrypts the
random Testnet `zoneRootSecret` under an operator-held server key and releases
it only to a session authenticated for the owning root wallet. This exception
exists because Testnet accounts cannot access Mainnet funds; it is not a
non-custodial mode and must not be enabled for Mainnet.

The backend **does** hold revocable, policy-bounded spending delegation: it sends agent intents, and the signer auto-signs within policy until session expiry or kill switch. State this honestly; do not claim "backend cannot move funds."

---

## 1. Architecture

```text
Root wallet (Xaman / Freighter / MetaMask)
    │  signs: zone authorization, backup wrap, recovery challenge
    ▼
Local signer (user's machine, localhost-only daemon)
    generates + stores zoneRootSecret
    derives agent keys (HKDF zone-bound → BIP44)
    enforces policy; signs agent transactions
    provisions on-chain recovery signers (XRPL/Stellar)
    produces backup blobs (signature-wrapped + passphrase-wrapped)
    │
    ▼
Chains: EVM / Stellar / XRPL

Backend: UI, sessions, agent intents, metadata,
         encrypted blob storage. No secret material.
```

## 2. Canonical Messages

All messages are canonical JSON: sorted keys, no whitespace, UTF-8. Three distinct `purpose` values; wallets must never be asked to sign one purpose in a flow belonging to another.

| Purpose | Nonce/expiry | Signed when |
|---|---|---|
| `authorize-zone` | yes / yes (5 min) | Zone creation |
| `backup-wrap` | **no / no** (must re-sign identically years later) | Zone creation + recovery |
| `session-auth` | yes / yes | Backend login, blob fetch |

### 2.1 `authorize-zone`

```json
{
  "protocol": "MOSAIC_ZONE_DERIVATION_V1",
  "purpose": "authorize-zone",
  "rootChain": "xrpl",
  "rootAddress": "r...",
  "zone": "agents",
  "network": "mainnet",
  "localSignerPublicKey": "...",
  "policyHash": "...",
  "zoneRootCommitment": "...",
  "nonce": "...",
  "issuedAt": "...",
  "expiresAt": "...",
  "version": 1
}
```

### 2.2 `backup-wrap`

```json
{
  "protocol": "MOSAIC_ZONE_DERIVATION_V1",
  "purpose": "backup-wrap",
  "rootChain": "xrpl",
  "rootAddress": "r...",
  "zone": "agents",
  "network": "mainnet",
  "version": 1
}
```

Deliberately timeless: no nonce, no expiry, no signer key. Scoped by protocol + address + zone + network.

### 2.3 Chain-specific signing

- **EVM:** EIP-712 typed data only (never `personal_sign`). Pin the domain: `{name: "MosaicZone", version: "1", chainId}`. Recovery re-signs the identical struct hash.
- **Stellar:** `stellar_signMessage` via WalletConnect v2; verify Ed25519 against the root `G...` key.
- **XRPL:** Xaman `SignIn` pseudo-transaction (non-submittable). Signer must verify the signing key is currently authoritative for the root address via ledger lookup (master not disabled, or key in current RegularKey/SignerList) — not merely that the signature matches the embedded key. Signer stores the exact signed payload template so recovery re-requests byte-identical content.

Replay protection: signer persists a monotonic nonce store that survives restarts.

## 3. Zone Root and Derivation

### 3.1 Zone creation

```text
zoneRootSecret     = random_32_bytes()            // CSPRNG
zoneRootCommitment = SHA256(zoneRootSecret)
wallet signs authorize-zone (binds commitment, policyHash, signer key)
signer verifies signature, stores secret + metadata + policy
```

### 3.2 Zone-bound derivation

Zone separation is cryptographic, not bookkeeping:

```text
seed = HKDF-SHA256(ikm  = zoneRootSecret,
                   salt = SHA256("MOSAIC_ZONE_V1"),
                   info = "MOSAIC_ZONE_V1" || rootAddress || zone || network)
```

Then per agent index `i` from `seed`:

```text
EVM(i):     m/44'/60'/0'/0/i        secp256k1
Stellar(i): m/44'/148'/i'           ed25519 (SLIP-0010)
XRPL(i):    m/44'/144'/0'/0/i       secp256k1 (pinned; never ed25519 for XRPL accounts)
```

Determinism guarantee (corrected): **same `zoneRootSecret` + zone + network + index + chain → same address.** The root wallet alone cannot re-derive addresses; it recovers the secret (§4).

Test vectors for all three chains ship in `@mosaic/zone-keys` and are release-blocking.

## 4. Recovery Architecture

Three independent layers. Layers 1–2 recover keys; layer 3 recovers funds.

### 4.1 Layer 1 — Signature-wrapped blob

At zone creation:

```text
1. Determinism self-test: request backup-wrap signature TWICE.
   deterministic := (sig1 == sig2 byte-for-byte)
2. If deterministic:
   wrapKey    = HKDF-SHA256(ikm  = sig1,
                            salt = zoneRootCommitment,
                            info = "MOSAIC_BACKUP_V1" || rootAddress || zone || network)
   blobSig    = XChaCha20-Poly1305(key = wrapKey,
                                   nonce = random_24_bytes(),
                                   plaintext = zoneRootSecret,
                                   aad = canonical zone metadata)
3. If self-test fails (hardware wallets, SCWs, hedged Ed25519): layer 1 disabled; layer 2 mandatory.
```

Recovery / add-device:

```text
fetch blobSig → wallet re-signs backup-wrap → re-derive wrapKey
→ AEAD decrypt → verify SHA256(secret) == zoneRootCommitment → restore
```

The commitment check is mandatory: it catches corrupted blobs and wallets whose signing behavior changed, before any key derivation or transaction signing occurs.

### 4.2 Layer 2 — Passphrase-wrapped blob (mandatory)

Always created, even when layer 1 is enabled — insurance against wallet updates that break signature determinism post-creation:

```text
kek      = Argon2id(passphrase, salt = random_16_bytes(),
                    m = 256 MiB, t = 3, p = 1)
blobPass = XChaCha20-Poly1305(kek, zoneRootSecret, aad = zone metadata)
```

User stores the exported file. Signer re-runs the layer-1 self-test opportunistically on zone operations; if signing behavior changed, alert the user and re-wrap while the live secret is still available.

### 4.3 Layer 3 — Root wallet as on-chain recovery signer

During agent account provisioning (privileged signer code path, §5.3):

- **XRPL:** `SignerListSet` on each agent account: root address, weight = quorum. (Alternative: `SetRegularKey` to a root-controlled key.) Accepts owner-reserve cost per account.
- **Stellar:** `SetOptions` adding root as signer with weight ≥ thresholds.
- **EVM:** no EOA mechanism; funds recovery on EVM rests on layers 1–2 only.

Loss of both blobs → root wallet signs sweep transactions directly on XRPL/Stellar agent accounts.

### 4.4 Blob storage

`blobSig` and `blobPass` are ciphertext keyed to material the backend never has; backend storage does not breach the custody boundary.

- Backend serves blobs only to a session authenticated by a fresh `session-auth` signature for that root address (never the `backup-wrap` message — do not train users to sign it for login).
- Encourage redundant user-side copies (file export, cloud drive). Blobs are safe anywhere.
- Multi-device = the recovery flow.

### 4.5 Failure matrix

| Loss event | Recovery |
|---|---|
| Signer machine dies | Layer 1: wallet signature unwraps blob |
| Wallet signing behavior changed | Layer 2: passphrase blob |
| Both blobs lost | Layer 3: root sweeps XRPL/Stellar; **EVM funds lost** |
| Root wallet lost | Total loss — out of scope; floor is the wallet's own seed backup |

## 5. Local Signer

Desktop daemon/app (Rust or Go daemon preferred; Tauri acceptable). Binds `127.0.0.1` only.

### 5.1 API security

Localhost binding is not sufficient (browser tabs and local processes can reach it):

- Per-client pairing tokens issued at enrollment; `agent-client` and `web-connector` get separately scoped credentials.
- Host-header validation (DNS-rebinding defense) + strict CORS allowlist + token auth on every request.
- No key-export endpoint. Export of encrypted blobs requires an explicit local user action; plaintext export requires an unsafe flag and interactive confirmation.
- Logs redact all key material.

### 5.2 Signing flow

```text
agent intent → decode tx → normalize → policy check → sign → append audit log
```

Audit log is append-only and hash-chained.

### 5.3 Privileged provisioning path

Layer-3 setup transactions (`SignerListSet`, `SetOptions`) are emitted only by the signer's own provisioning code, only installing the enrolled root address. The agent-facing API cannot request them (§6.1). Provisioning requires interactive user confirmation.

### 5.4 Storage

- Default: OS keychain (macOS Keychain / Windows Credential Manager / Linux Secret Service), zone secret encrypted at rest.
- Memory-only mode remains available for high-value short-lived zones, but is safe now only because §4 exists — a restart is a recovery event, not a loss event.

## 6. Policy Engine

Enforced locally; the signer never trusts backend or agent claims.

### 6.1 Default-deny: account-control transactions

Denied unconditionally on the agent API, regardless of policy JSON:

- **XRPL:** `SetRegularKey`, `SignerListSet`, `AccountSet` (master-key disable / critical flags), `AccountDelete`
- **Stellar:** `SetOptions` (signers, thresholds, master weight), `AccountMerge`
- **EVM:** `approve` / `increaseAllowance` / `setApprovalForAll` / Permit2 and permit-style signatures, `DELEGATECALL`-pattern upgrades — except contract+spender+amount tuples on an explicit allowlist with bounded amounts

Rationale: any one of these installs persistent spending authority that survives all future policy enforcement, rotation, and kill switches.

### 6.2 Limits in native units

Policy limits are denominated in native/asset units, not USD. USD limits require a price oracle; if the backend supplies prices it controls effective limits, violating the custody boundary. If USD limits are offered later, the signer fetches prices itself from pinned sources and fails closed.

```json
{
  "allowedChains": ["xrpl", "stellar", "evm"],
  "allowedAssets": ["XRP", "RLUSD", "USDC"],
  "allowedDexPairs": ["XRP/RLUSD"],
  "maxTxValue":    { "XRP": "1000", "RLUSD": "500", "USDC": "500" },
  "maxDailyVolume":{ "XRP": "20000", "RLUSD": "10000", "USDC": "10000" },
  "requireManualApprovalAbove": { "XRP": "2000" },
  "evmAllowlist": [ { "contract": "0x...", "selectors": ["0xa9059cbb"] } ],
  "expiresAt": "2026-07-09T00:00:00.000Z"
}
```

### 6.3 EVM posture

General calldata is not normalizable. EVM policy = contract address + function selector allowlist + decoded-argument bounds for allowlisted selectors. Anything else is denied.

### 6.4 Check order

decode → chain/network → source account → §6.1 denylist → destination/contract/asset → amount → daily accumulator (persisted) → policy expiry → sign.

## 7. Revocation & Operations

- One zone per operational scope; one agent index per agent; small working-capital balances, topped up from root.
- Session expiry on backend delegation; local kill switch halts all signing immediately.
- Rotation: new agent index, sweep old address (via agent key, or layer 3 on XRPL/Stellar).
- Cold wallet is never a trading wallet; it funds and (via layer 3) sweeps agent wallets.

## 8. Package Split

```text
@mosaic/zone-keys      HKDF zone binding, BIP44/SLIP-0010 derivation,
                       canonical messages, test vectors, address generation
@mosaic/local-signer   daemon, QR/WalletConnect flows, signature verification,
                       storage, policy engine, provisioning, backup/recovery
@mosaic/agent-client   signature-request client for agents
@mosaic/web-connector  browser helpers, wallet login, signer discovery/pairing
```

## 9. Test Requirements (release-blocking)

**Derivation:** fixed vectors per chain; zone/network/index separation; HKDF info-string binding (different zone → different seed even with same secret).

**Recovery:**
- Layer 1 round-trip: wrap → destroy secret → re-sign → unwrap → commitment verifies → addresses match vectors
- Tampered blob / wrong signature / wrong wallet → AEAD failure, no partial state
- Self-test correctly disables layer 1 for a non-deterministic mock wallet
- Layer 2 round-trip incl. wrong-passphrase rejection; Argon2id params asserted
- Layer 3: provisioned XRPL/Stellar agent account sweepable by root signature on testnet
- Determinism regression: recorded `backup-wrap` signatures re-verified against current wallet libs in CI

**Wallet auth:** per-chain signature verification to expected root address; XRPL authoritative-key ledger check; nonce replay rejected across signer restarts; expiry/zone/signer-key mismatch rejected.

**Policy:** every §6.1 denylist transaction type rejected via agent API on all three chains; provisioning path succeeds only interactively; allowed tx signs; asset/destination/amount/daily-limit/expiry rejections; daily accumulator survives restart.

**API security:** non-localhost refused; missing/invalid pairing token refused; DNS-rebinding Host header refused; no plaintext key in any normal API response; log redaction verified.

## 10. Threat Model Summary

| Adversary | Outcome |
|---|---|
| Compromised backend | Can issue intents within policy until expiry/kill; cannot obtain keys or exceed limits; cannot install approvals/signers (§6.1) |
| Phished `backup-wrap` signature | Inert without the encrypted blob; blob fetch requires separate `session-auth` |
| Phished `authorize-zone` signature | Inert: authorizes a commitment to a secret the attacker doesn't hold |
| Malicious webpage → localhost | Blocked: pairing token + CORS + Host validation |
| Local malware / machine compromise | Out of scope: trust boundary is the user's machine |
| Root wallet compromise | Full compromise, incl. layer-3 sweep authority — unchanged from any root-wallet system |
