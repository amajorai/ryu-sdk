// Co-located unit test for the `tool-firewall` plugin.
//
// Runner:  node --test plugins-store/plugins/tool-firewall/plugin.test.mjs
// Deps:    none (Node built-in test runner + assert only)
//
// WHAT THIS TESTS
// ---------------
// tool-firewall is a HOOK plugin: its behavior lives entirely in the JS bodies its
// `contributes.turn_hooks[]` reference by `code_file` (hooks/pre.js, hooks/post.js),
// which Core hydrates into `code` at parse time. So the test does two things:
//
//   1. Manifest validation — the manifest.json must stay well-formed: valid JSON,
//      id/name/version, and a turn_hooks contribution whose entries are well-shaped.
//      There is no Core fixture COPY to compare against; a packaged manifest has one
//      home (this directory) and Core `include_str!`s it from here.
//
//   2. Hook execution — it EXTRACTS the `.code` string from each hook and
//      ACTUALLY RUNS it against a realistic mock `ctx`, mirroring how Core's
//      plugin_host builds the sandbox program (build_hook_program in
//      apps/core/src/plugin_host/mod.rs): `ctx` is injected as a global const,
//      the body runs inside an async IIFE (so a bare top-level `return` yields
//      the directive), and the returned value is parsed by its `kind` field
//      into a HookDirective ({kind:'none'} | {kind:'deny',reason} |
//      {kind:'note',text} | ...). A `host` facade (with a stubbed sideModel)
//      is also in scope, matching the real substrate.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(HERE, "manifest.json");
const RAW = readFileSync(MANIFEST_PATH, "utf8");

// ── code_file hydration ───────────────────────────────────────────────────────
// This plugin keeps its sandboxed JS in real files (`hooks/*.js`, `adapters/*.js`)
// and references them from the manifest by `code_file`. Core resolves those into
// the inline `code` string at parse time (`PluginManifest::hydrate_code_files`),
// so every consumer — including the sandbox — only ever sees `code`. Mirror that
// here, or the assertions below would read an empty body and silently pass.
function hydrateCodeFiles(m) {
	const read = (rel) => readFileSync(join(HERE, rel), "utf8");
	for (const hook of m.contributes?.turn_hooks ?? []) {
		if (hook.code_file) {
			hook.code = read(hook.code_file);
			hook.code_file = undefined;
		}
	}
	for (const entry of m.provides ?? []) {
		for (const binding of Object.values(entry.tools ?? {})) {
			if (binding.adapter?.code_file) {
				binding.adapter.code = read(binding.adapter.code_file);
				binding.adapter.code_file = undefined;
			}
		}
	}
	return m;
}

/** The manifest as Core sees it: parsed, with every `code_file` hydrated. */
const parseManifest = () => hydrateCodeFiles(JSON.parse(RAW));

// Parse once; a throw here fails the whole suite (which is the point).
const manifest = parseManifest();

/**
 * Run a hook's `.code` body exactly the way Core's plugin_host does:
 * `ctx` is a global const, `host` is the capability facade, and the body
 * runs inside an async IIFE so a bare top-level `return` produces the value.
 * Returns the parsed directive value (or undefined if the hook returned nothing).
 */
async function runHook(code, ctx, host = makeHost()) {
	// Mirror build_hook_program: the body is spliced into an async IIFE with
	// `ctx` and `host` in lexical scope, and we capture its return value.
	// eslint-disable-next-line no-new-func
	const fn = new Function(
		"ctx",
		"host",
		"console",
		`return (async () => {\n${code}\n})();`
	);
	return await fn(ctx, host, { log() {} });
}

/** A host facade whose sideModel returns a canned string (tool-firewall never
 * uses it, but the real substrate always provides one, so we mirror it). */
function makeHost(sideModelReply = "CANNED_SIDE_MODEL_REPLY") {
	return {
		sideModel: async () => sideModelReply,
		runAgent: async () => sideModelReply,
		storage: {
			get: async () => null,
			set: async () => true,
			delete: async () => true,
			keys: async () => [],
		},
		log() {},
	};
}

function getHook(id) {
	const hook = manifest.contributes.turn_hooks.find((h) => h.id === id);
	if (!hook) {
		// A throw, not assert.ok: this helper runs outside any test() call, and an
		// assertion there is reported against whichever test happens to be running
		// (Biome's noMisplacedAssertion). Throwing fails the calling test honestly.
		throw new Error(`expected a turn_hook with id "${id}"`);
	}
	return hook;
}

// ─────────────────────────────────────────────────────────────────────────────
// Manifest shape
// ─────────────────────────────────────────────────────────────────────────────

test("manifest.json is valid JSON with id/name/version", () => {
	// JSON.parse above already proved it parses; assert the round-trip is stable.
	assert.deepEqual(parseManifest(), manifest);
	assert.equal(manifest.id, "@ryu/tool-firewall");
	assert.equal(typeof manifest.name, "string");
	assert.ok(manifest.name.length > 0);
	assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test("declares no runnables / permission_grants (pure inline-hook plugin)", () => {
	// tool-firewall is a policy hook: it needs no sidecar and no capabilities.
	assert.deepEqual(manifest.runnables, []);
	assert.deepEqual(manifest.permission_grants, []);
	assert.deepEqual(manifest.activation_events, ["*"]);
});

test("contributes.turn_hooks are well-formed", () => {
	const hooks = manifest.contributes.turn_hooks;
	assert.ok(Array.isArray(hooks));
	assert.equal(hooks.length, 2);
	const phases = new Set();
	for (const h of hooks) {
		assert.equal(typeof h.id, "string");
		assert.ok(h.id.length > 0);
		assert.ok(
			h.on === "pre_tool_use" || h.on === "post_tool_use",
			`unexpected hook phase: ${h.on}`
		);
		// Firewall matches every tool.
		assert.deepEqual(h.match, { tools: ["*"] });
		assert.equal(typeof h.code, "string");
		assert.ok(h.code.length > 0);
		phases.add(h.on);
	}
	// Exactly one pre + one post.
	assert.deepEqual([...phases].sort(), ["post_tool_use", "pre_tool_use"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// pre_tool_use hook (the actual firewall) — extract .code and RUN it
// ─────────────────────────────────────────────────────────────────────────────

test("pre hook DENIES a destructive `rm -rf` command", async () => {
	const hook = getHook("tool-firewall.pre");
	const ctx = {
		conversation_id: "conv-1",
		tool_name: "shell",
		tool_input: { command: "rm -rf /" },
		flags: {},
		transcript: [],
	};
	const out = await runHook(hook.code, ctx);
	assert.equal(out.kind, "deny");
	assert.equal(typeof out.reason, "string");
	// Reason names the tool and the policy.
	assert.match(out.reason, /shell/);
	assert.match(out.reason, /tool-firewall/);
});

test("pre hook DENIES a `DROP TABLE` (case-insensitive) SQL payload", async () => {
	const hook = getHook("tool-firewall.pre");
	const ctx = {
		tool_name: "postgres.query",
		tool_input: { sql: "drop table users;" }, // lowercase → regex has /i
		flags: {},
		transcript: [],
	};
	const out = await runHook(hook.code, ctx);
	assert.equal(out.kind, "deny");
	assert.match(out.reason, /postgres\.query/);
});

test("pre hook DENIES `mkfs`", async () => {
	const hook = getHook("tool-firewall.pre");
	const out = await runHook(hook.code, {
		tool_name: "shell",
		tool_input: { command: "mkfs.ext4 /dev/sda1" },
	});
	assert.equal(out.kind, "deny");
});

test("pre hook ALLOWS a benign command → {kind:'none'}", async () => {
	const hook = getHook("tool-firewall.pre");
	const out = await runHook(hook.code, {
		tool_name: "shell",
		tool_input: { command: "ls -la /tmp" },
	});
	assert.deepEqual(out, { kind: "none" });
});

test("pre hook ALLOWS when tool_input is missing (no crash, {kind:'none'})", async () => {
	// ctx.tool_input undefined → JSON.stringify({}) → no match.
	const hook = getHook("tool-firewall.pre");
	const out = await runHook(hook.code, { tool_name: "noop" });
	assert.deepEqual(out, { kind: "none" });
});

test("pre hook does NOT deny a substring that isn't the danger token", async () => {
	// "performbefore" contains "form" etc. but none of the danger patterns;
	// and "rm" without "-rf" must NOT trip (regex requires `rm\s+-rf`).
	const hook = getHook("tool-firewall.pre");
	const out = await runHook(hook.code, {
		tool_name: "shell",
		tool_input: { command: "rm file.txt && npm run format" },
	});
	assert.deepEqual(out, { kind: "none" });
});

// ─────────────────────────────────────────────────────────────────────────────
// post_tool_use hook (the observer) — extract .code and RUN it
// ─────────────────────────────────────────────────────────────────────────────

test("post hook returns a NOTE naming the tool and echoing (truncated) output", async () => {
	const hook = getHook("tool-firewall.post");
	const ctx = {
		tool_name: "shell",
		tool_output: { stdout: "hello world", code: 0 },
	};
	const out = await runHook(hook.code, ctx);
	assert.equal(out.kind, "note");
	assert.match(out.text, /^tool-firewall observed shell -> /);
	// The serialized output appears in the note.
	assert.match(out.text, /hello world/);
});

test("post hook TRUNCATES long output to 80 chars of the serialized payload", async () => {
	const hook = getHook("tool-firewall.post");
	const big = "x".repeat(500);
	const ctx = { tool_name: "shell", tool_output: { blob: big } };
	const out = await runHook(hook.code, ctx);
	assert.equal(out.kind, "note");
	// Prefix "tool-firewall observed shell -> " + at most 80 chars of payload.
	const PREFIX = "tool-firewall observed shell -> ";
	assert.ok(out.text.startsWith(PREFIX));
	const payload = out.text.slice(PREFIX.length);
	assert.ok(
		payload.length <= 80,
		`payload slice should be <= 80 chars, got ${payload.length}`
	);
});

test("post hook handles a missing tool_name (uses '?') and null output", async () => {
	const hook = getHook("tool-firewall.post");
	const out = await runHook(hook.code, {}); // no tool_name, no tool_output
	assert.equal(out.kind, "note");
	// "?" fallback for the name and "null" for the serialized output.
	assert.match(out.text, /^tool-firewall observed \? -> null/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Directive kinds the hooks emit are exactly those Core's HookDirective accepts
// ─────────────────────────────────────────────────────────────────────────────

test("every kind the hooks can return is a valid HookDirective kind", async () => {
	const valid = new Set([
		"none",
		"note",
		"continue",
		"replace",
		"inject",
		"deny",
	]);
	const pre = getHook("tool-firewall.pre").code;
	const post = getHook("tool-firewall.post").code;

	const denied = await runHook(pre, {
		tool_name: "t",
		tool_input: { c: "rm -rf /" },
	});
	const allowed = await runHook(pre, {
		tool_name: "t",
		tool_input: { c: "ok" },
	});
	const noted = await runHook(post, { tool_name: "t", tool_output: 1 });

	for (const d of [denied, allowed, noted]) {
		assert.ok(valid.has(d.kind), `unexpected directive kind: ${d.kind}`);
	}
});
