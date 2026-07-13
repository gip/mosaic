# ADR 0001: Guardian, Vault Core, and Runner trust boundaries

- Status: Accepted
- Date: 2026-07-12

## Decision

Mosaic separates agent custody from agent execution into four boundaries:

1. MCP is an untrusted control plane for discovery, desired state, immutable
   artifacts, ciphertext, and revocation distribution. MCP cannot issue grants.
2. Guardian owns XMTP control transport, local approval, pairing, leases, and
   lifecycle orchestration.
3. Vault Core is networkless. It holds authorization state, evaluates policy,
   signs only canonical Mosaic control envelopes and structured transaction
   intents, and never starts a process.
4. Runner is an untrusted execution supervisor. It verifies Guardian-signed
   grants and spawns a clean, resource-limited QuickJS process. Agent code sees
   only typed hooks.

No process that has loaded a zone secret or derived transaction key may fork or
spawn agent code. The Runner never receives a zone secret, derived transaction
key, Guardian identity key, or generic signing oracle. The one exception is the
agent's dedicated XMTP messaging credentials (`xmtp-owner`, `xmtp-database`;
custody `supervisor-session`): they are generated for the agent, never derived
from the zone secret, cannot move funds, and are delivered to the Runner only
inside short-lived sealed key leases so it can operate the agent's XMTP
endpoint. A compromised Runner can therefore impersonate the agent *on XMTP*
(messaging) but can never sign transactions or recover zone key material.

## Authorization model

XMTP is encrypted transport, not Mosaic authorization. Initial local Runner
pairing is approved by the explicit UI start action. Vault Core issues a signed
`RunnerCertificate`, then an `ExecutionGrant` bound to the Runner public key,
Guardian, network, agent, source, manifest, configuration, policy, capability
limits, expiry, and offline grace period.

All application messages are versioned and canonical. Expired, replayed,
revoked, reordered, broadened, or digest-mismatched authorization fails closed.
Lease renewal may only reduce capabilities, quotas, duration, or offline grace.

## Sandbox claim

QuickJS is defense in depth inside a separate operating-system process. It has
memory, stack, deadline, pending-job, hook-concurrency, and response limits and
no Node globals, filesystem, environment, native module, or raw network API.
Remote Runner compromise remains able to inspect data processed on that host;
the initial security claim covers custody and bounded authority, not remote-host
confidentiality. Confidential remote execution requires a separately designed
attestation/TEE mode.

## Capability rollout

The first implementation grants only namespaced state, structured logging,
clock, and random hooks. LLM, XMTP, WebSocket, scheduling, and transaction
operations remain default-deny until each has an external policy broker. Strict
XMTP recipient enforcement requires Guardian-brokered XMTP; until that broker
exists the Runner operates the agent's XMTP installation under leased
`supervisor-session` credentials, so recipient allow-lists are enforced only by
the (untrusted) Runner and the messaging identity is exposed to Runner
compromise. Moving XMTP custody behind the Guardian removes that exposure
without changing wire contracts.

## Platform posture

macOS is the first always-on Guardian. The TypeScript implementation uses a
narrow logical Vault Core boundary; a hardened macOS release moves that API
behind authenticated XPC and Keychain storage without changing wire contracts.
iOS is an attended Guardian and approval/revocation companion. Agents must pause
when an iOS-only Guardian is suspended or unreachable.

