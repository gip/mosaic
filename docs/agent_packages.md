# TypeScript agent packages

Mosaic agents are reusable, content-addressed TypeScript packages. A package requests authority; it does not receive authority until a user reviews and installs it into a particular agent vault.

## Authoring

Install the committed workspace dependencies without changing the lockfile:

```sh
pnpm install --frozen-lockfile
```

An agent project contains a strict `mosaic.agent.json`, a strict TypeScript configuration, and an entry module that default-exports an `AgentDefinition`:

```ts
import { defineAgent } from '@mosaic/agent-sdk';

export default defineAgent(async (mosaic) => {
  await mosaic.log.emit({ message: 'started' });
  if (mosaic.capabilities.has('xmtp.receive')) {
    await mosaic.xmtp.onMessage(async (message) => {
      await mosaic.log.emit({ message: 'received', resourceId: message.resourceId });
    });
  }
  await mosaic.runtime.waitUntilStopped();
});
```

The project manifest declares required and optional capabilities, logical resource slots, and maximum runtime limits. Constraints are immutable at installation time; users may omit optional capabilities and reduce quotas or limits.

```json
{
  "packageName": "hello-agent",
  "version": "1.0.0",
  "entry": "src/agent.ts",
  "tsconfig": "tsconfig.json",
  "capabilities": {
    "required": [
      {
        "operation": "log.emit",
        "maxCalls": 100,
        "maxResponseBytes": 1024,
        "constraints": { "maxEntryBytes": 4096 }
      }
    ],
    "optional": []
  },
  "resourceSlots": [],
  "limits": {
    "memoryBytes": 8388608,
    "stackBytes": 262144,
    "wallTimeMs": 60000,
    "maxPendingJobs": 16,
    "maxHookConcurrency": 2,
    "maxHookResponseBytes": 4096,
    "maxEventBytes": 4096
  },
  "minimumRuntimeVersion": "2.0.0"
}
```

## CLI

```sh
pnpm --filter @mosaic/agent-compiler exec mosaic-agent check ./path/to/project
pnpm --filter @mosaic/agent-compiler exec mosaic-agent build ./path/to/project
pnpm --filter @mosaic/agent-compiler exec mosaic-agent inspect ./path/to/project/dist/hello-agent-1.0.0.mosaic-agent
```

`build` type-checks and bundles the entry graph without installing dependencies, rejects ambient Node and dynamic-code authority, and writes canonical JSON to `dist/<packageName>-<version>.mosaic-agent`.

## Installation

Open the Local app's Agents page, select the package, stop and load any current installation, review the requested capabilities and constraints, bind resource slots, reduce quotas or runtime limits if desired, and approve installation. The immutable package is uploaded to the authenticated wallet-scoped MCP store; the Guardian-owned encrypted installation policy binds it to the selected vault.

XMTP credentials remain in Agent Runner under the software-local trust tier. QuickJS receives only the reviewed hooks, granted-operation names, and bound resource IDs. Transaction proposal, LLM, WebSocket, scheduling, filesystem, environment, network, and signing authority are not grantable.
