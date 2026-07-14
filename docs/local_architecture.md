# Local architecture

The Electron app controls two independently supervised processes:

```text
Web ─────────────── MCP server
                       │ intents / metadata / ciphertext only
                       ▼
Local app (Electron)
  ├─ Mosaic Guardian process
  │    vault unlock, attended approval, XMTP control, signed grants
  └─ Agent Runner process
       verifies grants and starts clean QuickJS child processes
```

Electron talks to the Guardian it spawned through typed utility-process IPC.
Wallet signatures, passphrases, MCP session tokens, installation management,
approval resolution, and local status never enter XMTP. Discovery of an
independently CLI-started Guardian is deferred.

Guardian–Supervisor communication uses XMTP only. Each has a persistent,
network-specific transport identity distinct from Guardian authorization,
transaction, and agent messaging keys. The wire protocol is documented in
`agent_control_protocol_v3.md`.

The Electron window renders the same Vite/React frontend as Web. Local behavior
stays behind the optional preload bridge; there is no parallel renderer UI.

## Agent lifecycle

A running Supervisor service is not a running agent. The attended flow is:

```text
pair Runner → request agent start → notify user → unlock and approve
→ issue fixed grant → download scoped artifact → run QuickJS → checkpoint
```

One approval creates one non-renewable 24-hour execution grant and matching
communication-key lease. There is no renewal, polling, heartbeat, or routine
Guardian hook traffic. Supervisor enforces signed routine quotas locally.
Zone secrets and transaction keys never cross into Runner. The only leased
secrets are the agent's separately generated XMTP messaging credentials.

Agent source never travels in XMTP. Supervisor consumes a five-minute,
three-read MCP ticket scoped to the owner, network, artifact digest, and Runner
certificate, then independently verifies all digests before execution.

Guardian may gracefully stop or immediately kill one exact agent/grant. It
revokes and zeroes custody state before sending the signed command. Supervisor
remains alive and returns a signed result plus an untrusted audit checkpoint.

Transactions remain attended and default-deny until Guardian's structured
transaction policy, signer, and broadcaster exist. Supervisor never receives a
transaction key, raw signed transaction, or generic signing oracle.

## Reuse boundaries

- Web and Local render the same `frontend` application.
- `@mosaic/ui-theme` owns shared visual tokens.
- `@mosaic/local-runtime` owns lifecycle, V3 contracts, signatures, replay
  state, and control transport interfaces.
- Platform behavior belongs behind the Electron preload bridge.
- Future signer work must preserve `zone_derived_agent_wallets_spec_v2.md`,
  including ciphertext-only Mainnet custody and frozen derivation formats.
