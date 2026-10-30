# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; create-ryu-app

> Scaffold a starter Ryu SDK project in one command. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/TypeScript-CLI-3178C6.svg?logo=typescript&logoColor=white)](../../README.md)

`create-ryu-app` is the project scaffolder for Ryu extensions. Running it generates a starter project with a `manifest.json` validated against the PluginManifest schema, so it installs out of the box.

Ryu extensions come in two shapes, and `--template` picks which one you get.

**Apps** are self-contained `apps-store/<app>` satellites: a manifest plus an out-of-process `sidecar/`, driven through the generic ext-proxy (`/api/ext/<plugin_id>/*`). Shipping one never requires a change to Ryu Core or the Gateway.

| Template | Emits | Runtime |
|---|---|---|
| `app` | A manifest declaring a lazy local sidecar + a grant-gated capability, and the loopback HTTP sidecar that serves it | Bun/Node, dependency-free |

**Plugins** are manifest contributions Ryu renders in-process — runnables, turn hooks, widgets, composer controls, a companion panel. No sidecar, no port. They are authored against `@ryuhq/sdk` and shipped with `ryu pack`.

| Template | Emits | Factory |
|---|---|---|
| `agent` (default) | A loop-owning agent with a local tool; runs against your node with no keys | `Agent` + `defineTool` |
| `expense-agent` | An agent that calls existing Ryu tools (Gmail via Composio; needs a Composio key and Gmail sign-in) | `Agent` + `ryuTool` |
| `workflow` | A typed workflow with an agent step and a human approval gate; `bun dev` opens the dev studio, `bun run build` bundles a server | `createWorkflow` + `createStep` + `Agent` |
| `multi-agent` | A supervisor that routes between agents, with an approval-gated tool; `bun dev` opens the dev studio | `createSupervisor` + `Agent` + `defineTool` |
| `action` | A governed business operation with input/output contracts | `defineAction` |
| `hook-plugin` | A post-assistant-turn plugin | `definePlugin` + `defineTurnHook` |
| `ryu-app` | An interactive in-chat widget | `defineApp` + a self-contained widget |
| `companion-plugin` | A Ryu App whose widget calls a companion tool, plus a panel surface | `defineApp` |
| `adapter` | A capability adapter: a provider tool runnable, a `provides` binding, and a flat `adapters/<verb>.js` body with golden cases (same shape as `tools/toolsmith scaffold --kind adapter`) | none (manifest + sandbox fragment) |

**Services:** `--template services` emits a standalone Hono server (no manifest) that publishes with Notify, sends with Mail and verifies their webhooks through `@ryuhq/services`.

**Tier:** OSS, Apache-2.0

## Install / Build

```bash
# scaffold a new project (default: agent template)
bunx create-ryu-app <name>

# scaffold a specific template
bunx create-ryu-app <name> --template ryu-app

# scaffold an apps-store satellite (manifest + sidecar)
bunx create-ryu-app <name> --template app

# build from source
bun run build   # tsup → dist/
bun test
```

## What it provides

- A one-command scaffolder (`create-ryu-app <name> [--template <t>]`) bundled with a `template/<name>/` tree per starter.
- For plugins: a starter Runnable plus a gateway-pointed model config, and a manifest ready for `ryu pack`.
- For apps: a satellite tree — `manifest.json` (sidecar + capability + grant) and a fail-closed, bearer-gated loopback sidecar that owns no dependency on this repo.
- A `manifest.json` validated against the PluginManifest schema at scaffold time.

## License

Apache-2.0. See [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
