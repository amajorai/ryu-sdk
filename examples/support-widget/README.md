# ResolveDesk support widget

ResolveDesk is a small customer-support product built with `@ryuhq/sdk`. It is
the concrete proof that a software team can own the app experience while Ryu
owns the governed runtime:

- `defineTool` supplies the support behavior and typed input schema.
- `defineApp` turns the same tool into an installable widget contribution.
- `ryu pack` carries the self-contained widget HTML and the inline tool body.
- Core runs the body in its `inline_deno` sandbox.
- The model path uses `host.sideModel`, which routes through the Ryu Gateway.
- The widget receives structured output and never holds a provider key.

## Run the sample

From the Ryu checkout:

```bash
bun install
bun run --cwd examples/support-widget build-manifest
bun run --cwd examples/support-widget pack
bun run --cwd examples/support-widget dev
```

Open the URL printed by `bun run dev`. The default preview is credential-free
and uses the verified help-center fallback, so the interaction works in a fresh
checkout. To use a live Ryu Gateway instead, start the sample with
`RYU_SUPPORT_LIVE=1` and set the same gateway/model environment used by the
other SDK examples.

## What to inspect

`src/app.ts` is the SDK source of truth. `manifest.json` is the generated
installable projection, and `dist/plugin.bundle.json` is the packed carriage.
The browser page shows the customer widget plus the four boundaries the request
crosses: input, SDK Runnable, Gateway policy, and structured widget output.

The sample deliberately keeps its tiny help-center excerpts in the tool body.
Swap those excerpts for a Ryu RAG primitive in a real app; keep the same
`defineTool` → `defineApp` → `ryu pack` shape.
