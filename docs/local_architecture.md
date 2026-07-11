# Local architecture

The local Electron app owns the lifecycle of two separate utility processes:

```text
Web ─────────────── MCP server
                       │ intents / metadata / ciphertext only
                       ▼
Local app (Electron)
  ├─ Signer & Policy Manager process
  │    future: zone unlock, policy checks, signing, XMTP, secure storage
  └─ Agent Runner process
       future: starts local agent instances and talks only to the signer boundary
```

The current slice establishes process isolation and lifecycle only. On app
startup both processes are launched; on app shutdown both receive a graceful
shutdown message and are force-stopped after a short timeout.

The Electron window hosts the exact same Vite/React frontend as Web. It uses the
same routes, MCP client, session providers, components, assets, and CSS. Local
adds an Electron bridge and an `/agents` page; it does not have a separate
renderer implementation. Its primary local flow is:

```text
select zone → unlock zone locally → start that zone's agent → monitor / stop
```

A running Agent Runner service is not the same thing as a running agent. The
runner service may start with the app, but it must refuse to start an agent
instance until the Signer & Policy Manager confirms that agent's zone is
unlocked. Zone secrets and derived keys never cross into the runner process.

No signing API exists yet. The signer scaffold cannot derive or export keys,
unlock zones, communicate over XMTP, store secrets, or approve transactions.
The runner scaffold does not execute agent code and stores no state.

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
  shared by the Electron host, Signer/Policy Manager, and Agent Runner.
- Platform-specific behavior belongs behind the optional Electron preload
  bridge. React components stay in the shared frontend.
