# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; @ryuhq/sdk

> Ryu's own developer SDK for authoring agents, workflows, tools, and skills. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/TypeScript-SDK-3178C6.svg?logo=typescript&logoColor=white)](../../README.md)

`@ryuhq/sdk` provides a canonical `defineAction` contract plus typed Runnable factories (`agent`, `workflow`, `tool`, `skill` and their builders), a gateway-mandatory model client so every model call routes through the Ryu Gateway, an MCP server/client, and a `ryu` CLI for packing and publishing plugin bundles. It is Runnable-native: reference the AI SDK / Mastra / ACP patterns, but depend on none of them. The native logic ships through a prebuilt addon, `@ryuhq/sdk-native` (the `crates/sdk/napi` binding).

**Tier:** OSS (Apache-2.0)

## Install / Build

```bash
bun add @ryuhq/sdk
# build from source
bun run build   # tsup → dist/
bun test
```

## What it provides

- **Runnable factories:** `agent`, `workflow`, `tool`, `skill` (and `AgentBuilder` / `WorkflowBuilder` / `ToolBuilder` / `SkillBuilder` / `PluginBuilder`) for the one Runnable contract (input to run to output). `defineApp` can attach a `ToolRunnable` so a widget's behavior ships as a grant-gated Core `inline_deno` tool.
- **Canonical Actions:** `defineAction` adds one description, input schema, output schema, effect, approval requirement, and implementation, then lowers it to a governed Ryu Tool/Runnable.
- **Action adapters:** the same contract is callable through Core HTTP (`@ryuhq/core-client/actions`), `ryu action`, the SDK MCP adapter, and A2A card discovery; calls remain Core-governed.
- **App-owned state:** `RunnableContext.storage` exposes the grant-gated `storage:kv` bridge for durable plugin state. Relational app data remains owned by an app sidecar.
- **Manifest model:** `PluginManifest` types + `PluginManifestSchema` / `validateManifestStrict` / `validatePluginId` (also exported from `@ryuhq/sdk/manifest`).
- **Gateway-mandatory model client:** chat types and a client where every model call routes through the Ryu Gateway (also from `@ryuhq/sdk/model`).
- **MCP server/client:** author (`McpServer`) and consume (`listTools` / `callTool`) MCP tool surfaces, via `@ryuhq/sdk/mcp`, `@ryuhq/sdk/mcp/server`, or `@ryuhq/sdk/mcp/client`.
- **Plugin host surface:** `RyuPlugin` / `PluginContext` / `definePlugin` types for the desktop companion host, via `@ryuhq/sdk/plugin`.
- **Runnables + builders as entries:** `@ryuhq/sdk/runnable` (the four kinds and their factories) and `@ryuhq/sdk/builder`.
- **CLI:** `bunx ryu pack <dir>` (and `ryu publish`) via the package `bin` entry.

## Canonical Actions

An Action is Ryu's public contract for a business operation. It keeps the implementation beside the
input/output contract and declares the effect that Core uses for read-only and approval enforcement.
The same Action can run in-process, be adapted to the SDK MCP server, or be lowered into an
installable `inline_deno` tool without maintaining a second implementation.

```ts
import { defineAction } from "@ryuhq/sdk";

export const createTicket = defineAction({
  id: "action-create-ticket",
  name: "Create Ticket",
  description: "Create a support ticket for a customer.",
  schema: {
    type: "object",
    properties: {
      customer: { type: "string" },
      summary: { type: "string" },
    },
    required: ["customer", "summary"],
  },
  outputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
  effect: "mutate",
  needsApproval: true,
  async run(input, _ctx) {
    return { id: `${input.customer}:${input.summary}` };
  },
});
```

`createTicket.toManifest({ id: "com.example.support", version: "1.0.0" })` emits the existing
`kind: "tool"` manifest shape with `backend: "inline_deno"`, `output_schema`, MCP effect annotations,
and `needs_approval`. Core keeps the existing tool registry, Gateway grants, audit trail, and
approval inbox as the execution authorities; `defineAction` is the shared authoring seam, not a
second runtime.

The generated Action can also be invoked by `POST /api/actions/<id>` or `ryu action <id> <json>
--agent <agent-id>`. Both require the calling agent explicitly, so a node token cannot silently
become an unscoped action principal. A2A publishes enabled Actions as skills on the agent card and
delegates the actual request to the published agent.

## Managing a running node

`@ryuhq/sdk` is the *authoring* SDK — it builds, packs, and publishes plugin
bundles and runs Runnables in-process. If you want to **drive a running Ryu
node programmatically** (install/enable/disable plugins, manage agents, models,
skills, MCP servers, spaces, workflows, gateway config, chat against Core),
that surface lives in [`@ryuhq/core-client`](../../packages/core-client) — the
same client the desktop app, TUI, and CLI run on — plus `@ryuhq/client` for
embedded agent chat. Nothing here duplicates it; `@ryuhq/sdk` deliberately
stays the authoring layer.

## License

Apache-2.0. See [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
