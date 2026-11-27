# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; @ryu/protocol

> Surface-agnostic wire-format contracts shared across every Ryu surface. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Proprietary-71717A.svg)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/TypeScript-Library-3178C6.svg?logo=typescript&logoColor=white)](../../README.md)

`@ryu/protocol` holds the small, pure wire-format contracts that more than one surface (desktop, web, mobile) must agree on. Each used to be duplicated per app and drifted; consolidating them here makes one definition authoritative. It has no runtime dependencies, just pure parsing/building helpers.

**Tier:** Closed, proprietary (A Major Pte. Ltd.)

## What it provides

- **Agent rules format** (`agent-rules.ts`): `composeRules` / split helpers that fold an agent's editable "Rules" list into and out of its single stored `systemPrompt`, using HTML-comment-delimited markers so the round-trip is unambiguous. Rules genuinely become part of the prompt, honored on every route (ACP and openai-compat alike).
- **Ryu Node Protocol continuity** (`continuity.ts`): the bounded RNP v0 conversation bundle, strict parser, configured-node resolver, and portable context contract used for explicit node-to-node chat handoff. See [`RNP.md`](./RNP.md).
- **`ryu://` deep links** (`deep-link.ts`): the canonical parser/builder for the scheme that opens the app from a link, covering navigation intents (`ryu://open/<page>`, `ryu://chat/new`) and confirm-gated action intents (`ryu://models/…`, `ryu://skills/…`, `ryu://nodes/connect`). A dedicated host per intent keeps navigation unambiguous with side-effecting actions.

## Role

Security: this package only validates and builds wire data; it never installs, connects, or sends by itself. Deep-link actions and RNP transfers go through explicit review surfaces. RNP excludes credentials, files, hidden prompts, workspace paths, and live agent state. Consumed by `apps/desktop`, `apps/web`, and `apps/native`.

## License

Proprietary. See [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
