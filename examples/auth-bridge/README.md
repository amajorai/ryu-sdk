# Reference auth bridge

A working example of an **auth bridge**: a Ryu plugin that turns a provider
subscription into an OpenAI-compatible endpoint the rest of Ryu can use as a normal
model provider. This is the opencode/openclaw pattern - anyone can ship one, for any
provider, without changing Core.

This example bridges a **ChatGPT (Codex) subscription**. Copy it and replace three
seams to target something else.

The sidecar and extension-host contracts it uses are described in the public
[extension host guide](https://docs.ryuhq.com/docs/extend/develop/extensions/extension-host).

## How it works

```
Pi (inference)  ->  http://127.0.0.1:<sidecar port>/v1/chat/completions   (this bridge)
                        -> translate chat/completions -> Responses API
                        -> https://chatgpt.com/backend-api/codex/responses
                           Authorization: Bearer <your subscription token>
```

The bridge runs as a `kind: "node"` sidecar. Core spawns its own bootstrap under
`bun` or `node`, verifies the bundle against `backend_sha256`, loads `backend.js`,
and calls its exported `activate(ctx)`. The plugin registers one HTTP handler and
Core supervises the rest (health, lazy start, idle stop).

## Two postures, and which one this is

**This bridge rides an existing credential.** The user runs `codex login` (or the
in-app ChatGPT login), the vendor CLI writes `~/.codex/auth.json`, and the bridge
reuses that result, refreshing it with the standard `refresh_token` grant. Nothing
here impersonates a login.

**The other posture is in-plugin login**, where the bridge runs its own authorize
flow. That is a per-provider question, not an architectural one:

- A provider offering a **device-code grant**, or accepting a **dynamic `localhost`
  redirect**, can be logged into entirely from a bridge. Add an `/login/start` route,
  do the exchange, store the result. No impersonation involved.
- ChatGPT and Claude **pin their CLI client's redirect URI**, so an in-plugin login
  means reproducing that vendor client. That is a product decision with real
  fragility and ToS exposure, so this reference does not do it.

Swap `loadCredential()` to change posture. The rest of the file is unaffected.

## The three seams

Everything provider-specific is isolated. To target a different provider, change
these and nothing else:

| Seam | Function | What to change |
| --- | --- | --- |
| 1 | `loadCredential()` | Where the credential comes from (file, own OAuth flow, host storage) |
| 2 | `refresh()` | How it is renewed. Standard `refresh_token` grant here |
| 3 | `translateRequest()` / `translateResponse()` | Wire format mapping |

If your upstream already speaks OpenAI chat/completions, **delete seam 3 entirely**
and forward the body unchanged.

## Configuration

Every value is env-overridable; nothing is hardcoded.

| Variable | Default |
| --- | --- |
| `RYU_BRIDGE_AUTH_PATH` | `~/.codex/auth.json` |
| `RYU_BRIDGE_TOKEN_URL` | `https://auth.openai.com/oauth/token` |
| `RYU_BRIDGE_CLIENT_ID` | `app_EMoamEEZ73f0CkXaXp7hrann` |
| `RYU_BRIDGE_UPSTREAM` | `https://chatgpt.com/backend-api/codex` |
| `RYU_BRIDGE_REFRESH_SKEW_SECS` | `300` |
| `RYU_BRIDGE_MODELS` | `gpt-5,gpt-5-codex` |

## Build

`manifest.json` is generated. The manifest carries `backend.js` inline as
`backend_code` plus its `backend_sha256`, and Core refuses a mismatch at the install
door, so the two must be produced together.

```bash
bun examples/auth-bridge/build.mjs
```

Never hand-edit `manifest.json`.

## Install and run

1. **Enable the extension host.** `kind: "node"` sidecars are gated and default OFF.
   Toggle `ryu:experimental-plugin-runtime`, or set
   `RYU_EXPERIMENTAL_PLUGIN_RUNTIME=1` for a headless Core.

2. **Install the plugin** from the generated `manifest.json`, for example with the SDK
   CLI: `bunx ryu install examples/auth-bridge/manifest.json` (it posts to Core's
   authenticated `POST /api/plugins/install-bundle`).

3. **Select it** as the active provider and send a message. Registration is automatic:
   the sidecar's `provides_provider` declaration tells Core to register
   `chatgpt-bridge` at the sidecar's loopback `/v1` once the process reports healthy,
   and to remove it again when the plugin is disabled or stopped.

The manifest's `port` (7997) is the release-profile port. Core assigns the port it
actually spawns the sidecar on (a non-release profile shifts it), so never hard-code
it in a client. Check the bridge through Core's generic ext-proxy instead, which also
stamps the sidecar bearer for you:

```bash
curl -H "Authorization: Bearer $RYU_CORE_TOKEN" \
  "${RYU_CORE_URL:-http://127.0.0.1:7980}/api/ext/com.example.chatgpt-bridge/status"
```

## Limitations

These are real and worth understanding before building on this.

- **Streaming is incremental.** The extension-host bootstrap accepts an async
  iterable or `ReadableStream` and writes each chunk with backpressure. This bridge
  forwards Responses API text deltas as OpenAI-compatible SSE chunks. Provider-specific
  event types beyond text deltas are still intentionally outside this reference.
- **Translation is minimal.** Seam 3 handles text in and text out. Tool calls,
  images, and structured output are not mapped.

### How Pi authenticates to the bridge

Non-obvious, and worth knowing before you debug a wall of 401s. The extension-host
bootstrap treats **loopback as not authentication**: it refuses any request whose
`Authorization` header is not exactly the sidecar's minted `RYU_EXT_TOKEN`. Core
stamps that token automatically when forwarding through `/api/ext/<id>/*`, but Pi
does not go through the proxy - it reads `models.json` and calls `baseUrl` directly.

So Core writes the ext-token into the registered provider entry as its `apiKey`, and
Pi presents it as a bearer. That happens automatically; you do not declare it. But if
you point a client at the sidecar port yourself, you must send the same bearer.

Note that a sidecar still cannot register *itself*: it holds only `RYU_EXT_TOKEN`,
scoped to the ext-proxy hop and `/api/host/*`, and the host-RPC vocabulary has no
provider-registration method. `provides_provider` is a **declaration** Core acts on,
which is why the id is validated against the built-in provider table and the written
entry is stamped with its owning plugin.

## Trust

An auth bridge runs as an **unsandboxed** process with **full host access** and
**custody of your live subscription token**. Declared sidecar permissions are
recorded but not OS-enforced.

Core does gate the supply chain: unsigned plugins have their inline `backend_code`
stripped at install, because a self-referential hash attests nothing. So a bridge
comes from an identifiable publisher. But signing is provenance, not sandboxing -
a signed bridge still sees every request you route through it.

Installing a third-party auth bridge means trusting that author with your
subscription and your machine. This is the same trust model opencode and openclaw
operate under. Treat it accordingly.
