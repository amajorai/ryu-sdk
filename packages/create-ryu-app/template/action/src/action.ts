#!/usr/bin/env bun
/**
 * __APP_DISPLAY_NAME__ — a governed business Action.
 *
 * The Action is the single implementation used by local TypeScript callers,
 * the SDK MCP adapter, and the Core inline tool emitted by toManifest().
 *
 *   bun run src/action.ts   # prints the generated manifest
 *   bunx ryu pack .         # validates and bundles manifest.json
 */

import { defineAction } from "@ryuhq/sdk";

const action = defineAction({
	id: "action-main",
	name: "Main Action",
	description: "Accept a message and return a governed receipt.",
	schema: {
		type: "object",
		properties: {
			message: { type: "string", description: "The message to record." },
		},
		required: ["message"],
	},
	outputSchema: {
		type: "object",
		properties: {
			ok: { type: "boolean" },
			message: { type: "string" },
		},
		required: ["ok", "message"],
	},
	effect: "mutate",
	needsApproval: true,
	run: async ({ message }) => ({ ok: true, message }),
});

const manifest = action.toManifest({
	id: "com.example.__APP_NAME__",
	name: "__APP_DISPLAY_NAME__",
	version: "0.1.0",
});

export default manifest;

if (import.meta.main) {
	process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}
