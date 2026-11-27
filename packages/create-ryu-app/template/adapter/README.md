# __APP_DISPLAY_NAME__

A Ryu **capability adapter** plugin. It implements a capability verb
(`example.verb` → `search`) by calling a provider tool this plugin owns
(`provider.tool`) and shaping the answer into the capability's canonical result.

```
manifest.json        the provider tool runnable, the `provides` binding, and the grants
adapters/search.js   the adapter body — a flat sandbox fragment (see below)
cases.json           golden cases: input, stubbed provider answers, expected result
src/harness.ts       runs the fragment with Core's four injected bindings
test/adapter.test.ts runs every case in cases.json as an assertion
```

## How the pieces fit

- **`runnables[]`** declares `provider.tool`, the tool the adapter calls. Core
  rejects a binding whose `tool` is not owned by the same plugin, so the provider
  tool and the adapter ship together. Replace the example HTTP endpoint with your
  provider's. It is an `http` tool with `unwrap_body: true`, so a successful call
  returns the provider's JSON body itself; a non-2xx response arrives as
  `{status, body}`, and with `fail_open: true` a rejected key or unreachable host
  arrives as `{available: false, reason, hint}`. The adapter passes both through
  under `raw`.
- **`provides[]`** publishes the `example.verb` capability. Its `tools.search`
  binding points at `provider.tool` and names the adapter body with
  `adapter.code_file`.
- **`permission_grants`** needs `tool:execute`: without it Core lists the provider
  and then refuses every call through the adapter. It also needs
  `tool:http-egress:<host>` for the host in the provider tool's `url`; change the
  two together when you point the tool at your provider, or Core refuses the
  request.

## The adapter body

`adapters/search.js` is not an ES module. Core splices it into an async function
with `input`, `defaults`, `callTool(args)` and `callNamed(id, args)` in scope, so
a top-level `return` is correct and `export`/`import` are not. Keep the header
comment and keep the file flat under `adapters/` (`adapters/<verb>.js`). The body
must be a pure function of its inputs and the provider's answers — no clock,
randomness or network of its own. Core's sandbox has no `fetch`, `process`,
`Buffer`, `require` or filesystem, and the local harness runs the body in a
context without them too, so `bun test` fails for a body that depends on them,
as Core would.

`ryu pack` inlines `code_file` into `code` so the whole body stays inside the
signed bundle.

## Run it

```bash
bun install
bun dev          # run every case in cases.json and print the results
bun test         # the same cases as assertions
bun run pack     # validate and bundle manifest.json (inlines the adapter)
```

Inside the Ryu repository, `cases.json` also drives toolsmith, which adds
purity checks and the repository's manifest rules. Those rules require a scoped
`@scope/name` id, so rename `com.example.*` first. Then generate toolsmith's
test runner and verify:

```bash
node tools/toolsmith/index.mjs scaffold --id @scope/name --tool search --kind adapter --out <dir>
node tools/toolsmith/index.mjs verify <dir>
```

This scaffold matches what toolsmith generates, so `scaffold` only writes its
`tool.test.mjs` here and leaves the body, `cases.json` and `manifest.json`
untouched.
