/**
 * create-ryu-app scaffold test: the default `agent` template, the other
 * single-file plugin templates (expense-agent, action, hook-plugin), the
 * Ryu-branded name fallback, and `parseArgs`.
 *
 * The widget templates live in widget-templates.test.ts and the `app` satellite
 * template in app-template.test.ts; shared readers are in test-helpers.ts.
 *
 * The native addon is mocked in test-preload.ts (bunfig.toml) so the zod
 * PluginManifestSchema — the gate this suite exercises — loads without the
 * `@ryuhq/sdk-native` binary.
 *
 * Asserts, for each template here:
 *   1. The scaffold produces the expected file set.
 *   2. The generated manifest.json parses against PluginManifestSchema.
 *   3. The manifest has the shape that template promises (agent runnable /
 *      governed action / turn hook).
 *   4. The authoring src uses the matching defineX factory.
 *   5. `parseArgs` handles `--template` and rejects bad input.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, scaffold } from "./index.ts";
import { PackageSchema, readManifest } from "./test-helpers.ts";

// ── default (agent) template — preserves the original scaffold contract ────────

describe("create-ryu-app scaffold (agent, default)", () => {
	let tmpDir: string;
	let projectDir: string;

	beforeAll(() => {
		tmpDir = join(import.meta.dir, `__test-agent-${Date.now()}`);
		projectDir = scaffold("my-test-app", tmpDir);
	});

	afterAll(() => {
		if (existsSync(tmpDir)) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("produces the expected file set", () => {
		for (const file of ["manifest.json", "src/agent.ts", "package.json"]) {
			expect(existsSync(join(projectDir, file))).toBe(true);
		}
	});

	it("manifest.json parses against PluginManifestSchema", () => {
		expect(() => readManifest(projectDir)).not.toThrow();
	});

	it("manifest.json contains the correct plugin id slug and name", () => {
		const parsed = readManifest(projectDir);
		expect(parsed.id).toBe("com.example.my-test-app");
		expect(parsed.name).toBe("My Test App");
	});

	it("manifest.json companion label matches display name", () => {
		const parsed = readManifest(projectDir);
		expect(parsed.companion?.label).toBe("My Test App");
	});

	it("generated package.json has correct name and dev script", () => {
		const pkg = PackageSchema.parse(
			JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8"))
		);
		expect(pkg.name).toBe("my-test-app");
		expect(pkg.scripts.dev).toBe("bun run src/agent.ts");
		expect(pkg.dependencies["@ryuhq/sdk"]).toBe("^0.5.0");
	});

	it("manifest.json has at least one agent runnable", () => {
		const parsed = readManifest(projectDir);
		const agents = parsed.runnables.filter((r) => r.kind === "agent");
		expect(agents.length).toBeGreaterThan(0);
	});

	it("src/agent.ts imports the scoped @ryuhq/sdk/agent entry (not the legacy @ryu/sdk)", () => {
		const src = readFileSync(join(projectDir, "src/agent.ts"), "utf8");
		expect(src).toContain('from "@ryuhq/sdk/agent"');
		expect(src).not.toContain("@ryu/sdk");
	});

	it("src/agent.ts is zero-config: a local tool, no remote Ryu tool or Core agent", () => {
		const src = readFileSync(join(projectDir, "src/agent.ts"), "utf8");
		expect(src).toContain("defineTool<");
		expect(src).not.toContain("ryuTool(");
		expect(src).not.toContain("agentId");
		expect(src).not.toContain("__APP_NAME__");
	});
});

// ── expense-agent template ───────────────────────────────────────────────────

describe("create-ryu-app scaffold (expense-agent)", () => {
	let tmpDir: string;
	let projectDir: string;

	beforeAll(() => {
		tmpDir = join(import.meta.dir, `__test-expense-${Date.now()}`);
		projectDir = scaffold("my-expenses", tmpDir, "expense-agent");
	});

	afterAll(() => {
		if (existsSync(tmpDir)) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("ships the remote-tool agent and a valid manifest", () => {
		const src = readFileSync(join(projectDir, "src/agent.ts"), "utf8");
		expect(src).toContain('ryuTool("composio.GMAIL_SEARCH_EMAILS"');
		const parsed = readManifest(projectDir);
		expect(parsed.id).toBe("com.example.my-expenses");
		expect(parsed.runnables.some((r) => r.kind === "agent")).toBe(true);
	});
});

// ── action template ──────────────────────────────────────────────────────────

describe("create-ryu-app scaffold (action)", () => {
	let tmpDir: string;
	let projectDir: string;

	beforeAll(() => {
		tmpDir = join(import.meta.dir, `__test-action-${Date.now()}`);
		projectDir = scaffold("my-action", tmpDir, "action");
	});

	afterAll(() => {
		if (existsSync(tmpDir)) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("produces an action source, manifest, and package", () => {
		for (const file of ["manifest.json", "src/action.ts", "package.json"]) {
			expect(existsSync(join(projectDir, file))).toBe(true);
		}
	});

	it("declares a governed action with structured output and approval", () => {
		const parsed = readManifest(projectDir);
		const action = parsed.runnables.find((r) => r.id === "action-main");
		expect(action).toMatchObject({
			name: "Main Action",
			kind: "tool",
		});
		expect(action?.config).toMatchObject({
			action: true,
			backend: "inline_js",
			needs_approval: true,
			annotations: {
				destructiveHint: true,
				readOnlyHint: false,
			},
		});
		expect(action?.config?.output_schema).toBeDefined();
	});

	it("source uses defineAction from the public SDK", () => {
		const src = readFileSync(join(projectDir, "src/action.ts"), "utf8");
		expect(src).toContain('import { defineAction } from "@ryuhq/sdk"');
		expect(src).toContain("needsApproval: true");
		expect(src).toContain('effect: "mutate"');
	});
});

// ── a Ryu-branded project name never crashes the manifest gate ─────────────────

describe("create-ryu-app scaffold (Ryu-branded name)", () => {
	let tmpDir: string;

	afterAll(() => {
		if (tmpDir && existsSync(tmpDir)) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("falls back to a safe companion label instead of failing validation", () => {
		tmpDir = join(import.meta.dir, `__test-branded-${Date.now()}`);
		// `ryu-helper` → display "Ryu Helper" would impersonate system chrome; the
		// label must NOT crash scaffold (the tool is literally create-ryu-app).
		const projectDir = scaffold("ryu-helper", tmpDir);
		const parsed = readManifest(projectDir);
		expect(parsed.id).toBe("com.example.ryu-helper");
		expect(parsed.name).toBe("Ryu Helper");
		const label = (parsed.companion?.label ?? "").toLowerCase();
		expect(label.includes("ryu")).toBe(false);
		expect(label.includes("system")).toBe(false);
	});
});

// ── hook-plugin template ───────────────────────────────────────────────────────

describe("create-ryu-app scaffold (hook-plugin)", () => {
	let tmpDir: string;
	let projectDir: string;

	beforeAll(() => {
		tmpDir = join(import.meta.dir, `__test-hook-${Date.now()}`);
		projectDir = scaffold("my-hook", tmpDir, "hook-plugin");
	});

	afterAll(() => {
		if (existsSync(tmpDir)) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("produces the expected file set", () => {
		for (const file of ["manifest.json", "src/plugin.ts", "package.json"]) {
			expect(existsSync(join(projectDir, file))).toBe(true);
		}
	});

	it("manifest is valid and declares a post-assistant-turn hook", () => {
		const parsed = readManifest(projectDir);
		expect(parsed.id).toBe("com.example.my-hook");
		const hooks = parsed.contributes?.turn_hooks ?? [];
		expect(hooks.length).toBeGreaterThan(0);
		expect(hooks[0]?.on).toBe("post_assistant_turn");
		expect(hooks[0]?.code).toContain("host.log");
		// A pure turn-hook plugin contributes no runnables.
		expect(parsed.runnables).toHaveLength(0);
	});

	it("src/plugin.ts uses definePlugin + defineTurnHook", () => {
		const src = readFileSync(join(projectDir, "src/plugin.ts"), "utf8");
		expect(src).toContain(
			'import { definePlugin, defineTurnHook } from "@ryuhq/sdk"'
		);
		expect(src).not.toContain("@ryu/sdk");
	});

	it("dev script targets the plugin entry", () => {
		const pkg = PackageSchema.parse(
			JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8"))
		);
		expect(pkg.scripts.dev).toBe("bun run src/plugin.ts");
	});
});

// ── parseArgs ──────────────────────────────────────────────────────────────────

describe("parseArgs", () => {
	it("defaults to the agent template", () => {
		expect(parseArgs(["my-app"])).toEqual({
			name: "my-app",
			template: "agent",
		});
	});

	it("accepts --template <value>", () => {
		expect(parseArgs(["my-app", "--template", "ryu-app"])).toEqual({
			name: "my-app",
			template: "ryu-app",
		});
	});

	it("accepts the app template alongside the plugin ones", () => {
		expect(parseArgs(["my-app", "--template", "app"])).toEqual({
			name: "my-app",
			template: "app",
		});
	});

	it("accepts --template=<value>", () => {
		expect(parseArgs(["my-app", "--template=hook-plugin"])).toEqual({
			name: "my-app",
			template: "hook-plugin",
		});
	});

	it("rejects a second positional argument", () => {
		const result = parseArgs(["a", "b"]);
		expect("error" in result).toBe(true);
	});

	it("rejects an unknown flag", () => {
		const result = parseArgs(["a", "--nope"]);
		expect("error" in result).toBe(true);
	});

	it("errors when --template is given without a value", () => {
		const result = parseArgs(["my-app", "--template"]);
		expect(result).toEqual({ error: "--template requires a value" });
	});

	it("treats a trailing --template=<empty> as an empty template string", () => {
		// The scaffold gate (not parseArgs) rejects an unknown template; parseArgs
		// only splits on the first '=', so an empty value parses through as "".
		expect(parseArgs(["my-app", "--template="])).toEqual({
			name: "my-app",
			template: "",
		});
	});

	it("--template before the name still binds both positionally", () => {
		expect(parseArgs(["--template", "ryu-app", "my-app"])).toEqual({
			name: "my-app",
			template: "ryu-app",
		});
	});

	it("returns an undefined name when no positional is given", () => {
		expect(parseArgs(["--template", "agent"])).toEqual({
			name: undefined,
			template: "agent",
		});
	});

	it("reports the unknown flag's exact name in the error", () => {
		const result = parseArgs(["my-app", "--verbose"]);
		expect(result).toEqual({ error: "unknown option: --verbose" });
	});
});
