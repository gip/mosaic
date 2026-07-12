# Local architecture

The local Electron app controls two independently supervised processes:

```text
Web ─────────────── MCP server
                       │ intents / metadata / ciphertext only
                       ▼
Local app (Electron)
  ├─ Mosaic Guardian process
  │    MCP session, vault unlock, encrypted data, XMTP control, signed grants
  └─ Agent Runner process
       verifies grants and starts clean QuickJS agent processes with typed hooks
```

Processes start explicitly from the shared UI or their CLI. The Electron host
also discovers a CLI-started Guardian through its authenticated local control
socket.

The Electron window hosts the exact same Vite/React frontend as Web. It uses the
same routes, MCP client, session providers, components, assets, and CSS. Local
adds an Electron bridge and an `/agents` page; it does not have a separate
renderer implementation. Its primary local flow is:

```text
select zone → unlock zone locally → start that zone's agent → monitor / stop
```

A running Agent Runner service is not the same thing as a running agent. The
runner service may start with the app, but it must refuse to start an agent
instance until Mosaic Guardian issues a short-lived execution grant bound to
the Runner device key, agent source digest, manifest, policy, and capability
limits. Zone secrets and derived keys never cross into the runner process.

The Runner no longer receives XMTP signatures or a vault-derived XMTP database
key. Guardian owns control XMTP. Strict agent-recipient policy will use
Guardian-brokered XMTP hooks; transaction intents remain default-deny until the
structured transaction policy broker is implemented.

Agent source runs in a clean QuickJS child process created by Runner, never by
Guardian or Vault Core. The initial hook surface is namespaced state, structured
logging, clock, and random bytes. See
`docs/adr/0001-guardian-runner-trust-boundaries.md` for the frozen trust model.

Future signer work must preserve the custody and policy rules in
`zone_derived_agent_wallets_spec_v2.md`, including localhost API hardening,
separately scoped pairing tokens, default-deny account-control transactions,
and the rule that the backend receives ciphertext only.

## Reuse boundaries

- Web and Local render the same `frontend` application. Shared screens and
  components must never be copied into `local-app`.
- `@mosaic/ui-theme` is the single source for palette, typography scale,
  spacing, radii, and dark/light theme tokens.
- `@mosaic/local-runtime` owns the utility-process lifecycle and IPC contract
  shared by the Electron host, Mosaic Guardian, and Agent Runner.
- Platform-specific behavior belongs behind the optional Electron preload
  bridge. React components stay in the shared frontend.
