# Mosaic Agent Control V2

`MOSAIC_AGENT_CONTROL_V2` is the local protocol between one Mosaic Guardian and
one long-lived Supervisor. The Supervisor multiplexes all active agents over a
single bounded, length-prefixed JSON connection. It owns agent sandboxes and
external I/O; Guardian owns vault unlock, policy, communication-secret custody,
grants, and the future transaction approval boundary.

## Identity and authority

- `agentId` is exactly the agent vault's zone name.
- One active agent has one `grantId` and one unlocked agent vault.
- Preparation frames carry `agentId`. Every subsequent operational frame
  carries both `agentId` and `grantId`.
- Operational frames also carry `protocol`, `type`, `requestId`, an independent
  per-agent/grant `sequence`, `deadline`, and `idempotencyKey`.
- Guardian rejects mismatches between the outer frame and nested capability,
  event, lease, or transaction envelopes.
- Status/ping and separately authenticated administrative calls do not confer
  agent authority.

Frames use a four-byte big-endian payload length followed by UTF-8 JSON and are
capped at 3 MiB. Requests and responses may be concurrent and arrive out of
order; `requestId` correlates them.

## Credentials

The filesystem control token is an administrative local-app credential. It is
not given to the Supervisor. `runner.approve` creates a short-lived, single-use
pairing credential. Successful `runner.enroll` consumes it and returns a scoped
Supervisor session credential. That credential can prepare, renew, stop, and
broker operations for agents, but cannot unlock vaults, mutate policy or
secrets, start/stop Guardian, attach an MCP session, or shut Guardian down.

The current trust tier is `software-local`. No code-signing, XPC, Secure
Enclave, or same-user-malware claim is made.

## Agent secrets

Agent vaults use a separate `MOSAIC_AGENT_SECRET_STORE_V1` XChaCha20-Poly1305
blob. Its key is HKDF-derived from `zoneRootSecret` with a new frozen domain; AAD
binds the root wallet, vault/agent, network, schema, and optimistic revision.
MCP stores ciphertext only and caps plaintext-equivalent ciphertext at 64 KiB.

Secret records are either:

- `guardian-only`: transaction or imported signing keys; never leased.
- `supervisor-session`: XMTP owner/database keys and future communication
  credentials; leased only for a live agent.

Guardian holds decrypted material in mutable buffers and zeroes it on rotation,
agent stop, or Guardian shutdown. Supervisor receives a 60-second lease sealed
to an ephemeral X25519 key. Lease AAD binds the Supervisor certificate digest,
runner, agent, grant, network, and expiry. Supervisor zeroes communication and
session-wrapping buffers on stop, expiry, or control-connection failure. Raw
keys are never serialized in status, logs, audit records, or runtime files.

## Preparation and leases

The Local app explicitly unlocks the selected agent vault. Guardian then:

1. reads `mosaic.agent-policy.v1` from encrypted vault data;
2. fetches the pinned immutable artifact from MCP;
3. verifies artifact/source digests, agent identity, hooks, policy, resources,
   and key references;
4. initializes persistent XMTP owner/database keys on the first explicit start;
5. signs a 60-second execution grant; and
6. returns source, manifest, grant, resolved resources, public XMTP identity,
   and the sealed communication-key lease.

The Supervisor renews after 30 seconds. Renewal reloads policy and may preserve
or reduce capabilities/resources. Artifact, communication identity, resource
change, or authority expansion requires fresh preparation. A failed control
connection starts a 15-second grace timer and then closes only that agent's
external client and sandbox. Reconnection requires fresh preparation.

## Runtime surface

QuickJS receives no Node, filesystem, raw-network, Guardian, zone-secret,
private transaction key, or generic-signing authority. Its communication API is:

```js
mosaic.xmtp.address()
mosaic.xmtp.send(resourceId, text)
mosaic.xmtp.onMessage(handler)
mosaic.runtime.waitUntilStopped()
```

Only Guardian-resolved logical XMTP resources are accepted. Unknown senders are
discarded before reaching the sandbox. Events and acknowledgements carry
`agentId` and `grantId`; cursors advance only after acknowledgement. Handler
failures retry three times and then become audited dead-letter failures while
message content remains in the encrypted XMTP database.

WSS descriptors and `open`/`send`/`onMessage`/`close` hooks exist, but Guardian
rejects any WSS policy until an adapter is registered.

`mosaic.transaction.propose(...)` creates a bounded canonical proposal which
the Supervisor forwards on the same Guardian connection. Guardian validates the
agent, grant, key reference, chain/network, sequence, deadline, quota, and
idempotency binding, then returns `TRANSACTION_BROKER_UNAVAILABLE`. This phase
contains no signing or broadcast path and never invokes a Guardian-only key.
