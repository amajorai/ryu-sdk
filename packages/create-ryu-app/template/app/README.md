# __APP_DISPLAY_NAME__

A Ryu **app**: a self-contained satellite that ships a manifest and an
out-of-process sidecar. It is not a plugin — there is no widget, no turn hook and
no bundled UI code. Everything a Ryu node needs to run it is in this directory.

```
manifest.json          the whole integration surface (sidecar + capability + grant)
sidecar/               the backend process, dependency-free (node:http only)
  src/main/control.ts  the loopback HTTP control server (pure router + auth)
  src/main/index.ts    entrypoint
```

## The contract

An app owns **only** its `manifest.json` and its `sidecar/`. It must never require
a change to Ryu Core or the Gateway — no route module, no reserved MCP server, no
hardcoded id or port anywhere but this manifest. Control flows through the generic
ext-proxy:

```
client → GET /api/ext/com.example.__APP_NAME__/items → Core → 127.0.0.1:<port>/items
```

Core forwards **only** the sub-paths declared in `sidecars[].http.routes[]` and
404s everything else, so that list is a security boundary, not documentation. Keep
it in sync with the router in `sidecar/src/main/control.ts`.

`provides[]` publishes the sidecar as the `__APP_NAME__.control` capability behind
the `__APP_NAME__:control` grant, so another app can depend on the *capability*
rather than on this app's id.

## Run it

```bash
bun install --cwd sidecar
__APP_TOKEN_ENV__=dev-token bun run dev
curl -s localhost:8342/health
curl -s -H 'Authorization: Bearer dev-token' localhost:8342/items
```

Every route except `GET /health` is bearer-gated and **fails closed**: with no
`RYU_EXT_TOKEN` (injected by Core at spawn) and no `__APP_TOKEN_ENV__` override,
every protected route 401s. Do not relax that — loopback is not a trust boundary.

## Before you ship

- **Pick a free port.** There is no registry and no allocator: the manifest number
  is what Core tries. `8342` is the scaffold default — change it, or every app
  built from this template collides with every other. Pick from the community band
  `8300`–`8699`, avoiding round numbers; Core (`7980`), the Gateway (`7981`), the
  first-party app band (`7990`–`8079`) and the local engines (`8080`–`8096`) are all
  taken. Core injects the profile-shifted port through `__APP_PORT_ENV__`, so read
  it — never hardcode. A collision does not relocate you: Core bind-probes the port
  and refuses to start the sidecar.
- **Build the binary.** `sidecars[].process.command` names `ryu-__APP_NAME__` on
  `PATH`; `bun run --cwd sidecar build` compiles it. `__APP_BIN_ENV__` points a
  node at a local build instead.
- **Rename the demo domain.** `/items` is a placeholder for whatever this app
  actually does. Change it in `control.ts` *and* in the manifest's `routes[]`.
- **Keep `sidecar/` self-contained.** No workspace imports, no Ryu SDK — this tree
  is published on its own.
