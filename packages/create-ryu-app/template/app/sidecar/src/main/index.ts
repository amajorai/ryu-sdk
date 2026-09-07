#!/usr/bin/env bun
// __APP_DISPLAY_NAME__ sidecar — entrypoint.
//
// A dependency-free Node/Bun process Core spawns as a `local` manifest sidecar.
// It owns ONE loopback HTTP control server (`control.ts`) and nothing else: no
// import from `apps/core`, no Ryu SDK, no shared workspace package. That is the
// satellite contract — this directory must build and ship from its own tree.
//
//   bun run src/main/index.ts        # standalone (set __APP_TOKEN_ENV__ first)
//   bun run build                    # → dist/ryu-__APP_NAME__, the `command` the
//                                    #   manifest's sidecars[].process names

import {
	MemoryItemStore,
	resolveControlPort,
	resolveControlToken,
	startControlServer,
} from "./control.ts";

function main(): void {
	const port = resolveControlPort();
	const token = resolveControlToken();
	if (!token) {
		// Fail-closed is enforced per-request; warn once so a misconfigured spawn is
		// diagnosable rather than silently 401ing every call.
		// biome-ignore lint/suspicious/noConsole: main-process diagnostic, no renderer.
		console.warn(
			"[ryu-__APP_NAME__] no RYU_EXT_TOKEN/__APP_TOKEN_ENV__ set — all control routes will 401"
		);
	}
	startControlServer({ store: new MemoryItemStore(), token }, port);
	// biome-ignore lint/suspicious/noConsole: main-process diagnostic, no renderer.
	console.log(`[ryu-__APP_NAME__] control server on 127.0.0.1:${port}`);
}

main();
