// Capability adapter for `search`, run in Core's plugin sandbox.
//
// Injected globals: `input` (canonical verb args), `defaults` (the provider's
// resolved arg_defaults), `callTool(args)` (the manifest-fixed provider tool) and
// `callNamed(id, args)` (one of the extra tools `adapter.tools` declared).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// and it `return`s the canonical result. That is why a top-level `return` is
// correct here, and why plugins-store/{plugins,lsp,external_plugins}/*/adapters is excluded from Biome.
//
// It must be a PURE function of `input`/`defaults` and the provider's answers:
// the ONLY nondeterminism a verified adapter may contain is the provider call
// itself. `node tools/toolsmith/index.mjs verify` enforces that.

const res = await callTool({ query: input.query });
// `provider.tool` is an `http` tool with `unwrap_body`, so a 2xx answer IS the
// provider's parsed JSON body. Anything else is not a result set: a non-2xx
// response arrives as `{status, body}` and, because the tool is `fail_open`, a
// rejected key or unreachable host as `{available: false, reason, hint}`. Pass
// those through under `raw`; shaping them into an empty result would report a
// broken install as "nothing found".
if (!(res && Array.isArray(res.results))) {
	return { raw: res };
}

return { results: res.results };
