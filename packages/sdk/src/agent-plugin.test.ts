// Tests for the Agent Plugins v1.0.0 export projection. The spec is unusually
// strict about two things and both are asserted here because getting either wrong
// produces a file that a conformant client REJECTS rather than degrades on:
//
//  1. `plugin.json`'s schema is closed (§5.2) — exporting a stray top-level field
//     is at best reported-and-ignored, and the field set is fixed.
//  2. An unknown field inside an `mcp.json` server entry invalidates THAT ENTRY
//     (§7.2.2 rule 3), so the server export must be an allowlist, not a passthrough.

import { describe, expect, test } from "bun:test";
import {
	AGENT_PLUGIN_EXTENSION_NS,
	AGENT_PLUGIN_MCP_SCHEMA_URL,
	AGENT_PLUGIN_SCHEMA_URL,
	toAgentPlugin,
	toSpecName,
} from "./agent-plugin.ts";

/** The exact top-level field set §5.2 permits. */
const PERMITTED_TOP_LEVEL = new Set([
	"$schema",
	"name",
	"version",
	"description",
	"author",
	"homepage",
	"repository",
	"license",
	"keywords",
	"extensions",
]);

/** Fields §7.2.1 permits on a stdio server entry. */
const PERMITTED_STDIO = new Set(["type", "command", "args", "env", "cwd"]);

/** §5.5 name constraints, expressed as one predicate. */
function isSpecLegalName(name: string): boolean {
	return (
		name.length >= 1 &&
		name.length <= 64 &&
		/^[a-z0-9][a-z0-9.-]*$/.test(name) &&
		/[a-z0-9]$/.test(name) &&
		!name.includes("--") &&
		!name.includes("..")
	);
}

describe("toSpecName", () => {
	test("projects a scoped id onto a legal dotted name", () => {
		expect(toSpecName("@ryu/advisor")).toBe("ryu.advisor");
		expect(toSpecName("@example/research-assistant")).toBe(
			"example.research-assistant"
		);
	});

	test("output is spec-legal for every shape our ids take", () => {
		const ids = [
			"@ryu/advisor",
			"@ryu/hook-session-context",
			"@ryu/sample-widget",
			"com.ryu.browser",
			"@Scope/UPPER_Case",
			"@ryu/weird--id..here",
			"@ryu/-leading-and-trailing-",
			`@ryu/${"x".repeat(120)}`,
		];
		for (const id of ids) {
			expect(isSpecLegalName(toSpecName(id))).toBe(true);
		}
	});

	test("clamping to 64 chars cannot leave a trailing separator", () => {
		// 63 chars then a hyphen at position 64: the naive slice would end on '-'.
		const id = `@ryu/${"a".repeat(58)}-tail`;
		const name = toSpecName(id);
		expect(name.length).toBeLessThanOrEqual(64);
		expect(isSpecLegalName(name)).toBe(true);
	});

	test("throws when nothing legal survives", () => {
		expect(() => toSpecName("@/")).toThrow();
	});
});

describe("toAgentPlugin", () => {
	test("emits only permitted top-level fields", () => {
		const { plugin } = toAgentPlugin({
			id: "@ryu/advisor",
			name: "Advisor",
			version: "1.0.0",
			description: "Consult a stronger reviewer model.",
			category: "Research",
			icon: "bulb",
			iconDither: { from: 261, to: 295 },
			surfaces: { core: { support: "full" } },
			engines: { ryu: ">=0.1.0" },
			runnables: [{ id: "t", name: "T", kind: "tool" }],
			permission_grants: ["hook:side-model"],
			contributes: { slash_commands: [] },
		});
		for (const key of Object.keys(plugin)) {
			expect(PERMITTED_TOP_LEVEL.has(key)).toBe(true);
		}
		expect(plugin.$schema).toBe(AGENT_PLUGIN_SCHEMA_URL);
		expect(plugin.name).toBe("ryu.advisor");
	});

	test("carries the real id and display name in the extension namespace", () => {
		const { plugin } = toAgentPlugin({
			id: "@ryu/advisor",
			name: "Advisor",
			version: "1.0.0",
		});
		expect(plugin.extensions[AGENT_PLUGIN_EXTENSION_NS]).toMatchObject({
			id: "@ryu/advisor",
			displayName: "Advisor",
		});
	});

	test("falls back to the tagline when there is no description", () => {
		const { plugin } = toAgentPlugin({
			id: "@ryu/advisor",
			name: "Advisor",
			tagline: "A stronger second model reviews your answers",
		});
		expect(plugin.description).toBe(
			"A stronger second model reviews your answers"
		);
	});

	test("normalizes a bare-string author into the spec object form", () => {
		const { plugin } = toAgentPlugin({
			id: "@ryu/a",
			name: "A",
			author: "Ryu",
		});
		expect(plugin.author).toEqual({ name: "Ryu" });
	});

	test("drops author fields the spec does not permit", () => {
		// An extra member on `author` makes the WHOLE manifest invalid (§5.4), so
		// this must be a drop, not a passthrough.
		const { plugin } = toAgentPlugin({
			id: "@ryu/a",
			name: "A",
			author: { name: "Ryu", url: "https://example.com", twitter: "@ryu" },
		});
		expect(plugin.author).toEqual({ name: "Ryu", url: "https://example.com" });
	});

	test("no mcp.json when the manifest declares no servers", () => {
		const { mcp } = toAgentPlugin({ id: "@ryu/a", name: "A" });
		expect(mcp).toBeNull();
	});

	test("exports a stdio server with only the permitted fields", () => {
		const { plugin, mcp } = toAgentPlugin({
			id: "@ryu/ghost",
			name: "Ghost",
			mcp_servers: {
				ghost: {
					command: "ghost",
					command_env: "RYU_GHOST_BIN",
					args: ["mcp"],
					description: "Ghost — desktop automation.",
				},
			},
		});
		expect(mcp?.$schema).toBe(AGENT_PLUGIN_MCP_SCHEMA_URL);
		const server = mcp?.mcpServers.ghost;
		expect(server).toEqual({ type: "stdio", command: "ghost", args: ["mcp"] });
		for (const key of Object.keys(server ?? {})) {
			expect(PERMITTED_STDIO.has(key)).toBe(true);
		}
		// The stripped native fields survive in the extension namespace.
		expect(plugin.extensions[AGENT_PLUGIN_EXTENSION_NS]).toMatchObject({
			mcp: {
				ghost: {
					command_env: "RYU_GHOST_BIN",
					description: "Ghost — desktop automation.",
				},
			},
		});
	});

	test("exports Streamable HTTP, legacy SSE, and inferred remote servers", () => {
		const { mcp, notes } = toAgentPlugin({
			id: "@ryu/remote",
			name: "Remote",
			mcp_servers: {
				hosted: {
					type: "streamable-http",
					url: "https://mcp.example.com/mcp",
					headers: { Authorization: "Bearer static" },
				},
				legacy: {
					type: "sse",
					url: "https://legacy.example.com/sse",
				},
				inferred: { url: "https://inferred.example.com/mcp" },
			},
		});
		expect(mcp?.mcpServers.hosted).toEqual({
			type: "streamable-http",
			url: "https://mcp.example.com/mcp",
			headers: { Authorization: "Bearer static" },
		});
		expect(mcp?.mcpServers.legacy).toEqual({
			type: "sse",
			url: "https://legacy.example.com/sse",
		});
		expect(mcp?.mcpServers.inferred).toEqual({
			type: "streamable-http",
			url: "https://inferred.example.com/mcp",
		});
		expect(notes).toEqual([]);
	});

	test("omits malformed remote URLs while preserving valid HTTP endpoints", () => {
		const { mcp, notes } = toAgentPlugin({
			id: "@ryu/remote",
			name: "Remote",
			mcp_servers: {
				insecure: {
					type: "streamable-http",
					url: "http://remote.example.com/mcp",
				},
				bad: { type: "streamable-http", url: "file:///tmp/mcp" },
				local: { type: "sse", url: "http://127.0.0.1:8787/sse" },
			},
		});
		expect(mcp?.mcpServers.insecure).toEqual({
			type: "streamable-http",
			url: "http://remote.example.com/mcp",
		});
		expect(mcp?.mcpServers.local).toEqual({
			type: "sse",
			url: "http://127.0.0.1:8787/sse",
		});
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("http or https");
	});

	test("omits a disabled server but records it", () => {
		const { plugin, mcp, notes } = toAgentPlugin({
			id: "@ryu/a",
			name: "A",
			mcp_servers: {
				off: { command: "x", enabled: false },
				on: { command: "y" },
			},
		});
		expect(mcp?.mcpServers.off).toBeUndefined();
		expect(mcp?.mcpServers.on).toBeDefined();
		expect(plugin.extensions[AGENT_PLUGIN_EXTENSION_NS]).toMatchObject({
			mcp: { off: { enabled: false } },
		});
		expect(notes.some((n) => n.includes("off"))).toBe(true);
	});

	test("omits a command the spec cannot express, with a note", () => {
		const { mcp, notes } = toAgentPlugin({
			id: "@ryu/a",
			name: "A",
			mcp_servers: {
				shellish: { command: "node server.mjs" },
				absolute: { command: "/usr/local/bin/thing" },
				fine: { command: "npx", args: ["-y", "pkg"] },
			},
		});
		expect(mcp?.mcpServers.shellish).toBeUndefined();
		expect(mcp?.mcpServers.absolute).toBeUndefined();
		expect(mcp?.mcpServers.fine).toBeDefined();
		expect(notes).toHaveLength(2);
	});

	test("throws on a manifest with no id", () => {
		expect(() => toAgentPlugin({ name: "No id" })).toThrow("no id");
	});
});
