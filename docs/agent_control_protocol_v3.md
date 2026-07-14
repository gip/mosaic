# Mosaic Agent Control V3

`MOSAIC_AGENT_CONTROL_V3` is the application protocol between an attended
Mosaic Guardian and a long-lived Supervisor. XMTP is encrypted delivery, not
Mosaic authority: every operational message is also signed and bound to both
XMTP inboxes, the Runner device key, Guardian authority, network, sequence,
deadline, idempotency key, and payload digest.

## Identity and pairing

Guardian and Supervisor each have a persistent, network-specific XMTP transport
identity unrelated to zone and transaction keys. Supervisor also has a
persistent Ed25519 device key. Guardian authorization signatures remain
vault-derived EIP-191 signatures.

Supervisor creates a signed five-minute pairing offer containing its Runner ID,
device public key, XMTP address/inbox, network, nonce, and timestamps. After
explicit user approval Guardian initiates the XMTP DM. Supervisor sends
`runner-enrollment`; Guardian returns a signed certificate binding both inboxes
and the Runner device key. Unsolicited conversations are ignored.

## Envelopes and traffic

Canonical JSON messages are capped at 256 KiB and use `runner-enrollment`,
`agent-start-request/result`, `privileged-request/result`,
`agent-termination-command/result`, `runtime-audit-checkpoint`, and
`control-error`.

Every envelope has request/reply IDs, both identities and inboxes, optional
exact agent/grant bindings, a monotonic sequence, issued/expiry times,
idempotency key, payload digest, payload, and application signature. Sequences,
processed XMTP IDs, completed results, pending approvals, and termination state
persist locally. Replays, expiry, reordering, and cross-binding fail closed.
Duplicate completed requests return the stored result.

XMTP performs one catch-up sync at startup followed by a live stream. There is
no polling, heartbeat, ping, status request, lease renewal, per-hook Guardian
call, or scheduled control message.

## Attended start and fixed authority

An agent start request becomes a Guardian approval for at most fifteen minutes.
Approval unlocks the selected agent vault inside Guardian, verifies pinned
policy and artifact, and creates one non-renewable 24-hour execution grant and
matching sealed communication-key lease. Supervisor receives no passphrase,
wallet signature, zone secret, Guardian key, or transaction key.

Agent source is not sent through XMTP. Guardian requests a random 256-bit MCP
ticket scoped to owner, network, artifact digest, and Runner certificate. MCP
stores only its hash. The ticket expires after five minutes and allows at most
three reads. Supervisor re-verifies artifact, manifest, source, grant, and
certificate bindings before execution.

Routine state, log, clock, random, and agent-XMTP hooks are validated and
metered locally from the signed grant and produce no Guardian traffic. A crash
cannot reuse the grant. Policy changes require another attended start.
Transaction proposals wait for Guardian and remain default-deny with
`TRANSACTION_BROKER_UNAVAILABLE`; no transaction signing or broadcast exists.

## Stop, kill, and audit

Guardian first revokes the exact active grant, locks the agent vault, zeroes
decrypted agent material, and appends its authoritative audit decision. It then
sends an exact Runner/agent/grant-bound termination command.

`graceful` closes external XMTP, rejects new work, delivers
`runtime.stopping`, waits at most five seconds, then sends `SIGKILL` if needed.
`immediate` sends `SIGKILL` without cleanup handlers. Both clear queues, zero
leased credentials, invalidate local grant state, emit one final checkpoint,
and return a Runner-signed result. The Supervisor service remains running.

An offline Supervisor cannot prevent Guardian revocation or zeroization. It
processes the queued command after reconnect; otherwise the sandbox and lease
stop at fixed grant expiry. A delayed command cannot affect a replacement
grant.

Supervisor's local audit is hash-chained. Its final checkpoint is explicitly
untrusted Runner telemetry. Guardian approvals, revocations, termination
decisions, and future privileged operations remain authoritative Guardian
audit events.
