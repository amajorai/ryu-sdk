/**
 * Round-trip test: build a Plugin in TS via the SDK, validate it, pack it, and
 * confirm the packed JSON round-trips through `PluginManifestSchema` — proving
 * that the SDK schema and Core schema agree.
 *
 * This test runs entirely in-process (no filesystem side effects beyond a
 * temp directory) and is the authoritative acceptance proof for the acceptance
 * criterion "A round-trip test builds a Plugin in TS, packs it, and Core's
 * loader installs it successfully."
 *
 * The "Core's loader installs it" part is verified here by confirming that the
 * emitted JSON satisfies `PluginManifestSchema` — the same schema Core's
 * `PluginManifestLoader::parse_and_validate` enforces in Rust (the Rust tests in
 * `apps/core/src/plugin_manifest/mod.rs` assert the same fixture parses).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { agent, app, PluginBuilder, skill, tool, workflow } from "./builder.ts";
import { PluginManifestSchema } from "./manifest.ts";
import { defineApp } from "./runnable/app.ts";
import { defineTool } from "./runnable/tool.ts";

// ── builder unit tests ────────────────────────────────────────────────────────

describe("PluginBuilder", () => {
	it("builds a valid minimal manifest", () => {
		const manifest = new PluginBuilder()
			.id("com.example.minimal")
			.name("Minimal App")
			.version("0.1.0")
			.build();

		expect(manifest.id).toBe("com.example.minimal");
		expect(manifest.name).toBe("Minimal App");
		expect(manifest.version).toBe("0.1.0");
		expect(manifest.runnables).toEqual([]);
		expect(manifest.permission_grants).toEqual([]);
		expect(manifest.companion).toBeUndefined();
	});

	it("builds a manifest with all runnable kinds", () => {
		const manifest = new PluginBuilder()
			.id("com.example.full")
			.name("Full App")
			.version("1.2.3")
			.runnable(agent().id("agent-main").name("Main Agent").build())
			.runnable(workflow().id("wf-pipeline").name("Pipeline").build())
			.runnable(tool().id("tool-search").name("Web Search").build())
			.runnable(skill().id("skill-research").name("Research").build())
			.grant("mcp:web_search")
			.grant("mcp:file_read")
			.companion({
				label: "Full App",
				icon: "sparkles",
				shortcut: "ctrl+shift+f",
			})
			.build();

		expect(manifest.runnables).toHaveLength(4);
		expect(manifest.runnables.map((r) => r.kind)).toEqual([
			"agent",
			"workflow",
			"tool",
			"skill",
		]);
		expect(manifest.permission_grants).toEqual([
			"mcp:web_search",
			"mcp:file_read",
		]);
		expect(manifest.companion?.label).toBe("Full App");
	});

	it("throws on missing id", () => {
		expect(() =>
			new PluginBuilder().name("No ID").version("1.0.0").build()
		).toThrow(/id/);
	});

	it("rejects a companion label that impersonates system chrome", () => {
		for (const bad of ["Ryu Settings", "System Tools", "my RYU panel"]) {
			expect(() =>
				new PluginBuilder()
					.id("com.example.evil")
					.name("Evil")
					.version("1.0.0")
					.companion({ label: bad })
					.build()
			).toThrow(/impersonate system chrome/);
		}
	});

	it("throws on invalid semver", () => {
		expect(() =>
			new PluginBuilder()
				.id("com.example.bad")
				.name("Bad")
				.version("not-semver")
				.build()
		).toThrow(/semver/);
	});

	it("engine/model fields are open strings — no union", () => {
		// This test proves the SDK type system doesn't restrict engines to a
		// hardcoded list.  RunnableMeta has no engine/model field at the identity
		// layer (engine is a config concern, not a manifest identity concern), and
		// the PluginManifest schema places no restriction on what values permission
		// grants strings may carry. Any new provider or engine id works without an
		// SDK change.
		const manifest = new PluginBuilder()
			.id("com.example.custom-engine")
			.name("Custom Engine App")
			.version("1.0.0")
			.grant("engine:my-custom-llm-v99")
			.build();

		expect(manifest.permission_grants).toContain("engine:my-custom-llm-v99");
	});
});

describe("per-kind builders", () => {
	it("agent() factory builds an agent runnable", () => {
		const r = agent().id("a-1").name("Agent One").build();
		expect(r.kind).toBe("agent");
		expect(r.id).toBe("a-1");
	});

	it("workflow() factory builds a workflow runnable", () => {
		const r = workflow().id("wf-1").name("Workflow One").build();
		expect(r.kind).toBe("workflow");
	});

	it("tool() factory builds a tool runnable", () => {
		const r = tool().id("t-1").name("Tool One").build();
		expect(r.kind).toBe("tool");
	});

	it("skill() factory builds a skill runnable", () => {
		const r = skill().id("s-1").name("Skill One").build();
		expect(r.kind).toBe("skill");
	});

	it("throws when id is empty", () => {
		expect(() => agent().name("No ID").build()).toThrow();
	});
});

// ── round-trip test ───────────────────────────────────────────────────────────

describe("round-trip: SDK build → JSON → Core schema parse", () => {
	let tmpDir: string;

	beforeAll(() => {
		tmpDir = join(import.meta.dir, `../__test-roundtrip-${Date.now()}`);
		mkdirSync(tmpDir, { recursive: true });
	});

	afterAll(() => {
		if (existsSync(tmpDir)) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("emitted manifest.json satisfies PluginManifestSchema (Core compat proof)", () => {
		// 1. Build a manifest using the SDK.
		const manifest = new PluginBuilder()
			.id("@example/research-assistant")
			.name("Research Assistant")
			.version("1.0.0")
			.runnable(agent().id("agent-researcher").name("Researcher").build())
			.runnable(
				workflow().id("wf-summarise").name("Summarise Workflow").build()
			)
			.runnable(tool().id("tool-web-search").name("Web Search").build())
			.runnable(skill().id("skill-research").name("Research Skill").build())
			.grant("mcp:web_search")
			.grant("mcp:file_read")
			.companion({
				label: "Research Assistant",
				icon: "magnifying-glass",
				shortcut: "ctrl+shift+r",
			})
			.build();

		// 2. Emit to a temp manifest.json (simulating what `ryu pack` writes).
		const manifestPath = join(tmpDir, "manifest.json");
		writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

		// 3. Read it back and parse through `PluginManifestSchema` — the same
		//    validation Core's PluginManifestLoader applies in Rust.
		const raw = readFileSync(manifestPath, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		const result = PluginManifestSchema.safeParse(parsed);

		expect(result.success).toBe(true);
		if (!result.success) {
			return;
		}

		const loaded = result.data;
		expect(loaded.id).toBe("@example/research-assistant");
		expect(loaded.runnables).toHaveLength(4);
		expect(loaded.permission_grants).toEqual([
			"mcp:web_search",
			"mcp:file_read",
		]);
		expect(loaded.companion?.shortcut).toBe("ctrl+shift+r");
	});

	it("matches the Core fixture (sample.manifest.json)", () => {
		// The Core Rust test (`sample_fixture_deserializes_into_app_manifest`)
		// asserts the same values — this verifies TS schema parity.
		const fixture = {
			id: "@example/research-assistant",
			name: "Research Assistant",
			version: "1.0.0",
			runnables: [
				{ id: "agent-researcher", name: "Researcher", kind: "agent" },
				{ id: "wf-summarise", name: "Summarise Workflow", kind: "workflow" },
				{ id: "tool-web-search", name: "Web Search", kind: "tool" },
				{ id: "skill-research", name: "Research Skill", kind: "skill" },
			],
			permission_grants: ["mcp:web_search", "mcp:file_read"],
			companion: {
				label: "Research Assistant",
				icon: "magnifying-glass",
				shortcut: "ctrl+shift+r",
			},
		};

		const result = PluginManifestSchema.safeParse(fixture);
		expect(result.success).toBe(true);
		if (!result.success) {
			return;
		}

		expect(result.data.id).toBe("@example/research-assistant");
		expect(result.data.runnables).toHaveLength(4);
		const kinds = result.data.runnables.map((r) => r.kind);
		expect(kinds).toContain("agent");
		expect(kinds).toContain("workflow");
		expect(kinds).toContain("tool");
		expect(kinds).toContain("skill");
	});

	it("invalid semver in JSON is rejected", () => {
		const bad = {
			id: "com.example.bad",
			name: "Bad",
			version: "not-a-version",
			runnables: [],
		};
		const result = PluginManifestSchema.safeParse(bad);
		expect(result.success).toBe(false);
	});

	it("missing id in JSON is rejected", () => {
		const bad = { name: "No ID", version: "1.0.0", runnables: [] };
		const result = PluginManifestSchema.safeParse(bad);
		expect(result.success).toBe(false);
	});
});

// ── Ryu App (defineApp / AppBuilder) ──────────────────────────────────────────

describe("defineApp", () => {
	// A fixture app with one render tool + one companion (accessible) tool. This
	// exercises the render-vs-companion derivation that mirrors Core's
	// `apps::tools()`.
	function fixtureApp() {
		return defineApp({
			id: "com.example.checklist",
			title: "Checklist",
			version: "1.0.0",
			slug: "checklist",
			uiEntry: "src/checklist.tsx",
			grants: ["mcp:file_read"],
			tools: [
				{
					name: "render",
					description: "Render a checklist",
					inputSchema: {
						type: "object",
						properties: { title: { type: "string" } },
					},
					invoking: "Building…",
					invoked: "Ready",
				},
				{ name: "toggle", description: "Toggle an item", accessible: true },
			],
		});
	}

	it("emits one WidgetContribution for the render tool and none for the companion", () => {
		const manifest = fixtureApp();
		const widgets = manifest.contributes?.widgets ?? [];

		expect(widgets).toHaveLength(1);
		expect(widgets[0]?.tool_id).toBe("checklist.render");
		expect(widgets[0]?.uri).toBe("ui://widget/checklist.html");
		expect(widgets[0]?.ui_entry).toBe("src/checklist.tsx");
		expect(widgets[0]?.mime).toBe("text/html+skybridge");
		expect(widgets[0]?.default_display_mode).toBe("inline");
	});

	it("builds one kind:'tool' runnable per tool with the widget config flags", () => {
		const manifest = fixtureApp();
		expect(manifest.runnables).toHaveLength(2);
		expect(manifest.runnables.every((r) => r.kind === "tool")).toBe(true);

		const render = manifest.runnables.find((r) => r.id === "checklist.render");
		expect(render?.config).toMatchObject({
			slug: "checklist.render",
			// The manifest is the only channel for a packed app: description +
			// input_schema must survive so Core can rebuild a driveable tool.
			description: "Render a checklist",
			input_schema: {
				type: "object",
				properties: { title: { type: "string" } },
			},
			widget: true,
			// The render tool's widget may call tools because the app declares a
			// companion (widget_accessible tool).
			widget_accessible: true,
			invoking: "Building…",
			invoked: "Ready",
		});

		const toggle = manifest.runnables.find((r) => r.id === "checklist.toggle");
		expect(toggle?.config).toMatchObject({
			slug: "checklist.toggle",
			widget: false,
			widget_accessible: true,
		});
	});

	it("marks a render tool's widget non-accessible when the app has no companion", () => {
		const manifest = defineApp({
			id: "com.example.chart",
			title: "Chart",
			version: "1.0.0",
			slug: "chart-studio",
			server: "chart",
			uiEntry: "src/chart.tsx",
			tools: [{ name: "render", description: "Render a chart" }],
		});
		const render = manifest.runnables.find((r) => r.id === "chart.render");
		expect(render?.config).toMatchObject({
			widget: true,
			widget_accessible: false,
		});
		// `server` override qualifies the tool id and the widget binding.
		expect(manifest.contributes?.widgets[0]?.tool_id).toBe("chart.render");
		// The widget uri still derives from the slug, not the server.
		expect(manifest.contributes?.widgets[0]?.uri).toBe(
			"ui://widget/chart-studio.html"
		);
	});

	it("embeds an executable ToolRunnable in the widget tool", () => {
		const renderTool = defineTool({
			id: "support.render",
			name: "Support answer",
			schema: {
				type: "object",
				properties: { message: { type: "string" } },
				required: ["message"],
			},
			run: async (input) => ({
				content: [{ type: "text", text: input.message }],
				structuredContent: { answer: input.message },
			}),
		});
		const manifest = defineApp({
			id: "com.example.support",
			title: "Support",
			version: "1.0.0",
			slug: "support",
			uiEntry: "src/widget.html",
			tools: [
				{
					name: "render",
					description: "Answer a support question",
					inputSchema: renderTool.schema as unknown as Record<string, unknown>,
					runnable: renderTool,
				},
			],
		});
		const render = manifest.runnables[0];

		expect(render?.config).toMatchObject({
			backend: "inline_deno",
			code: renderTool.code,
			input_schema: renderTool.schema,
			widget: true,
		});
		expect(manifest.permission_grants).toEqual([
			"widget:render",
			"tool:execute",
		]);
	});

	it("round-trips through PluginManifestSchema without stripping widgets", () => {
		// The load-bearing check: `contributes.widgets` is only preserved because it
		// was added to `ContributesSchema`. A JSON round-trip proves the field
		// survives Core-strict zod parse (the same parse the CLI applies).
		const manifest = fixtureApp();
		const json = JSON.stringify(manifest);
		const parsed = PluginManifestSchema.safeParse(JSON.parse(json));

		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			return;
		}
		expect(parsed.data.contributes?.widgets).toHaveLength(1);
		expect(parsed.data.contributes?.widgets[0]?.tool_id).toBe(
			"checklist.render"
		);
		// description + input_schema survive the strict parse (the only channel for
		// a packed app — no `generated.rs` on the Core side).
		const render = parsed.data.runnables.find(
			(r) => r.id === "checklist.render"
		);
		expect(render?.config?.description).toBe("Render a checklist");
		expect(render?.config?.input_schema).toBeDefined();
	});

	it("rejects an invalid semver version", () => {
		expect(() =>
			defineApp({
				id: "com.example.bad",
				title: "Bad",
				version: "not-semver",
				slug: "bad",
				uiEntry: "src/bad.tsx",
				tools: [{ name: "render", description: "Render" }],
			})
		).toThrow(/semver/);
	});
});

describe("AppBuilder", () => {
	it("builds an equivalent manifest to defineApp", () => {
		const manifest = app()
			.id("com.example.checklist")
			.title("Checklist")
			.version("1.0.0")
			.slug("checklist")
			.uiEntry("src/checklist.tsx")
			.grant("mcp:file_read")
			.tool({
				name: "render",
				description: "Render a checklist",
				invoking: "Building…",
				invoked: "Ready",
			})
			.tool({ name: "toggle", description: "Toggle an item", accessible: true })
			.build();

		expect(manifest.id).toBe("com.example.checklist");
		expect(manifest.runnables).toHaveLength(2);
		expect(manifest.contributes?.widgets).toHaveLength(1);
		expect(manifest.contributes?.widgets[0]?.tool_id).toBe("checklist.render");
		// The author's own grant, plus the `widget:render` the builder adds because
		// this app synthesises a widget — without it Core silently degrades the
		// widget to plain text.
		expect(manifest.permission_grants).toEqual([
			"mcp:file_read",
			"widget:render",
		]);
	});

	it("throws on missing id", () => {
		expect(() =>
			app()
				.title("No ID")
				.version("1.0.0")
				.slug("x")
				.uiEntry("src/x.tsx")
				.tool({ name: "render", description: "Render" })
				.build()
		).toThrow(/id/);
	});
});

// ── requires / targets (plugin-to-plugin dependencies + surface gating) ───────
//
// These pin the SDK schema to Core's `PluginManifest.requires` / `.targets`
// (`apps/core/src/plugin_manifest/mod.rs`). The load-bearing property is that zod
// `z.object()` STRIPS unknown keys: without these fields in the schema, `ryu pack`
// / `ryu publish` (which return `PluginManifestSchema.safeParse(...).data`) would
// silently delete a plugin's dependencies BEFORE the manifest is signed. So every
// case below asserts the field SURVIVES the parse, not merely that it parses.

describe("engines (host version floors)", () => {
	/** The regression: `engines` was absent from `PluginManifestSchema`, and zod
	 *  strips unlisted keys — so `ryu pack` dropped the block from every bundle. A
	 *  plugin could declare a Core floor, publish, and ship a bundle declaring none. */
	it("does not strip `engines` — the whole block survives the parse", () => {
		const parsed = PluginManifestSchema.safeParse({
			engines: {
				cli: ">=0.1.0",
				desktop: ">=0.2.0",
				extension: ">=0.1.0",
				gateway: ">=0.1.5",
				island: ">=0.1.0",
				mobile: ">=1.0.0",
				ryu: ">=0.1.0",
				web: ">=0.1.0",
			},
			id: "com.example.floors",
			name: "Floors",
			runnables: [],
			version: "1.0.0",
		});

		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			return;
		}
		expect(parsed.data.engines).toEqual({
			cli: ">=0.1.0",
			desktop: ">=0.2.0",
			extension: ">=0.1.0",
			gateway: ">=0.1.5",
			island: ">=0.1.0",
			mobile: ">=1.0.0",
			ryu: ">=0.1.0",
			web: ">=0.1.0",
		});
	});

	it("keeps a legacy `{ ryu }`-only block intact and adds no sibling keys", () => {
		const parsed = PluginManifestSchema.safeParse({
			engines: { ryu: ">=0.1.0" },
			id: "com.example.legacy-engines",
			name: "Legacy",
			runnables: [],
			version: "1.0.0",
		});

		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			return;
		}
		expect(parsed.data.engines).toEqual({ ryu: ">=0.1.0" });
	});

	it("leaves `engines` undefined when the manifest declares none", () => {
		const parsed = PluginManifestSchema.safeParse({
			id: "com.example.no-engines",
			name: "None",
			runnables: [],
			version: "1.0.0",
		});

		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			return;
		}
		expect(parsed.data.engines).toBeUndefined();
	});

	it("rejects an `engines` block with no Core floor", () => {
		const parsed = PluginManifestSchema.safeParse({
			engines: { desktop: ">=0.2.0" },
			id: "com.example.bad-engines",
			name: "Bad",
			runnables: [],
			version: "1.0.0",
		});

		expect(parsed.success).toBe(false);
	});
});

describe("requires / targets", () => {
	it("keeps a manifest with NEITHER requires nor targets valid (all 37 shipped plugins)", () => {
		const parsed = PluginManifestSchema.safeParse({
			id: "com.example.legacy",
			name: "Legacy",
			version: "1.0.0",
			runnables: [],
		});

		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			return;
		}
		// Absent `requires` = NO dependencies (never an empty-object default, so the
		// key stays off the wire exactly like Core's `Option<Requires>`).
		expect(parsed.data.requires).toBeUndefined();
		// Absent `targets` = EVERY surface. It must never be read as "hidden", or
		// every manifest predating the field would vanish from every listing.
		expect(parsed.data.targets).toEqual([]);
	});

	it("round-trips `requires` through the schema without stripping it", () => {
		const manifest = new PluginBuilder()
			.id("com.example.meetings")
			.name("Meetings")
			.version("1.0.0")
			.dependsOn("@ryu/spaces", "1.2.0")
			.dependsOn("@ryu/voice")
			.requiredGrant("spaces:docs")
			.build();

		// Survives the builder…
		expect(manifest.requires?.apps).toEqual([
			{ id: "@ryu/spaces", min_version: "1.2.0" },
			{ id: "@ryu/voice" },
		]);
		expect(manifest.requires?.grants).toEqual(["spaces:docs"]);

		// …and the JSON round-trip the CLI applies before signing.
		const parsed = PluginManifestSchema.safeParse(
			JSON.parse(JSON.stringify(manifest))
		);
		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			return;
		}
		expect(parsed.data.requires?.apps).toHaveLength(2);
		// snake_case on the wire — Core's `AppDependency.min_version` declares no
		// serde rename, so a camelCase `minVersion` here would be silently dropped.
		expect(parsed.data.requires?.apps[0]?.min_version).toBe("1.2.0");
		expect(parsed.data.requires?.apps[1]?.min_version).toBeUndefined();
		expect(parsed.data.requires?.grants).toEqual(["spaces:docs"]);
	});

	it("defaults the two `requires` members so a partial block parses", () => {
		const parsed = PluginManifestSchema.safeParse({
			id: "com.example.partial",
			name: "Partial",
			version: "1.0.0",
			runnables: [],
			requires: { apps: [{ id: "@ryu/spaces" }] },
		});

		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			return;
		}
		expect(parsed.data.requires?.grants).toEqual([]);
	});

	it("round-trips `targets` through the schema without stripping it", () => {
		const manifest = new PluginBuilder()
			.id("com.example.desktop-only")
			.name("Desktop Only")
			.version("1.0.0")
			.target("desktop")
			.target("island")
			.build();

		expect(manifest.targets).toEqual(["desktop", "island"]);

		const parsed = PluginManifestSchema.safeParse(
			JSON.parse(JSON.stringify(manifest))
		);
		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			return;
		}
		expect(parsed.data.targets).toEqual(["desktop", "island"]);
	});

	it("accepts every one of Core's eight kebab-case surface tokens", () => {
		const parsed = PluginManifestSchema.safeParse({
			id: "com.example.everywhere",
			name: "Everywhere",
			version: "1.0.0",
			runnables: [],
			targets: [
				"gateway",
				"core",
				"desktop",
				"island",
				"mobile",
				"extension",
				"web",
				"cli",
			],
		});

		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			return;
		}
		expect(parsed.data.targets).toHaveLength(8);
	});

	it("rejects a surface token Core's Surface enum does not define", () => {
		const parsed = PluginManifestSchema.safeParse({
			id: "com.example.bad-target",
			name: "Bad Target",
			version: "1.0.0",
			runnables: [],
			// Core's `Surface` is kebab-case and has no `tauri` variant, so serde
			// would reject the whole manifest at load. Catch it at authoring time.
			targets: ["tauri"],
		});

		expect(parsed.success).toBe(false);
	});

	it("carries requires + targets through defineApp (Ryu Apps)", () => {
		const manifest = defineApp({
			id: "com.example.dep-app",
			title: "Dep App",
			version: "1.0.0",
			slug: "dep-app",
			uiEntry: "src/dep-app.tsx",
			tools: [{ name: "render", description: "Render" }],
			requires: { apps: [{ id: "@ryu/spaces", min_version: "1.0.0" }] },
			targets: ["desktop"],
		});

		expect(manifest.requires?.apps[0]?.id).toBe("@ryu/spaces");
		expect(manifest.requires?.grants).toEqual([]);
		expect(manifest.targets).toEqual(["desktop"]);

		// An app that declares neither keeps the no-dependency / all-surface default.
		const plain = defineApp({
			id: "com.example.plain-app",
			title: "Plain App",
			version: "1.0.0",
			slug: "plain-app",
			uiEntry: "src/plain-app.tsx",
			tools: [{ name: "render", description: "Render" }],
		});
		expect(plain.requires).toBeUndefined();
		expect(plain.targets).toEqual([]);
	});
});

// ── contributes.lsp_servers (Claude Code language-server parity) ──────────────
//
// Same load-bearing property as the block above: `ryu pack` / `ryu publish`
// persist `PluginManifestSchema.safeParse(...).data`, so a contribution family
// missing from `ContributesSchema` is silently DELETED before the manifest is
// signed. These assert the declaration SURVIVES the parse — byte-for-byte, since
// the entry body is Claude Code's own camelCase vocabulary and Ryu is only its
// courier.

describe("contributes.lsp_servers", () => {
	/** The `.lsp.json` example from Claude Code's plugins reference, verbatim. */
	const claudeCodeGoServer = {
		command: "gopls",
		args: ["serve"],
		extensionToLanguage: { ".go": "go" },
	};

	it("keeps a Claude Code language server through the pack-path parse", () => {
		const parsed = PluginManifestSchema.safeParse({
			id: "com.example.go-lsp",
			name: "Go LSP",
			version: "1.0.0",
			runnables: [],
			contributes: { lsp_servers: { go: claudeCodeGoServer } },
		});

		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			return;
		}
		expect(parsed.data.contributes?.lsp_servers.go).toEqual(claudeCodeGoServer);
	});

	it("keeps an unknown entry key too (Claude Code owns the vocabulary)", () => {
		// The entry is a loose record on purpose: typing the 13 documented fields
		// here would strip a field from a newer Claude release on its way through
		// `ryu pack` — the same silent deletion, one level down.
		const parsed = PluginManifestSchema.safeParse({
			id: "com.example.future-lsp",
			name: "Future LSP",
			version: "1.0.0",
			runnables: [],
			contributes: {
				lsp_servers: {
					go: { ...claudeCodeGoServer, someFutureClaudeField: { deep: true } },
				},
			},
		});

		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			return;
		}
		expect(parsed.data.contributes?.lsp_servers.go).toMatchObject({
			someFutureClaudeField: { deep: true },
		});
	});

	it("yields an empty map, never undefined, when none is declared", () => {
		const parsed = PluginManifestSchema.safeParse({
			id: "com.example.legacy",
			name: "Legacy",
			version: "1.0.0",
			runnables: [],
			contributes: {},
		});

		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			return;
		}
		// Core's field is `#[serde(default, skip_serializing_if = "…is_empty")]`, so
		// an empty map here round-trips to a manifest with no `lsp_servers` key at
		// all — every plugin predating this surface keeps parsing on both sides.
		expect(parsed.data.contributes?.lsp_servers).toEqual({});
	});
});

describe("contributes.message_actions", () => {
	it("preserves renderer-specific action args through the pack-path parse", () => {
		const action = {
			args: {
				dispatch: "reactions.toggle",
				renderer: "reaction-picker",
			},
			capability: "reactions.toggle",
			id: "reactions.picker",
			kind: "menu",
			label: "Add reaction",
			plugin: "@ryu/reactions",
			target: "user",
		};
		const parsed = PluginManifestSchema.safeParse({
			id: "com.example.reactions",
			name: "Reactions",
			version: "1.0.0",
			runnables: [],
			contributes: { message_actions: [action] },
		});

		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			return;
		}
		expect(parsed.data.contributes?.message_actions).toEqual([action]);
	});
});

describe("contributes.selection_actions", () => {
	it("preserves host-owned selection dispatch args through the pack-path parse", () => {
		const action = {
			args: { dispatch: "side-chat.selection", intent: "explain" },
			id: "side-chats.explain-selection",
			kind: "button",
			label: "Explain",
			order: 110,
		};
		const parsed = PluginManifestSchema.safeParse({
			id: "com.example.side-chats",
			name: "Side Chats",
			version: "1.0.0",
			runnables: [],
			contributes: { selection_actions: [action] },
		});

		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			return;
		}
		expect(parsed.data.contributes?.selection_actions).toEqual([action]);
	});
});

describe("mcp_servers OAuth", () => {
	const manifest = {
		id: "com.example.mail",
		mcp_servers: {
			mail: {
				auth: { client_id: "public-client", type: "oauth" },
				type: "streamable-http",
				url: "https://mcp.example.com/mcp",
			},
		},
		name: "Mail",
		permission_grants: ["mcp:server", "identity.read"],
		runnables: [],
		version: "1.0.0",
	};

	it("preserves the public OAuth declaration through the pack-path parse", () => {
		const parsed = PluginManifestSchema.parse(manifest);
		expect(parsed.mcp_servers?.mail?.auth).toEqual({
			client_id: "public-client",
			type: "oauth",
		});
	});

	it("rejects secret auth fields and non-loopback plaintext URLs", () => {
		expect(
			PluginManifestSchema.safeParse({
				...manifest,
				mcp_servers: {
					mail: {
						...manifest.mcp_servers.mail,
						auth: { client_secret: "nope", type: "oauth" },
					},
				},
			}).success
		).toBe(false);
		expect(
			PluginManifestSchema.safeParse({
				...manifest,
				mcp_servers: {
					mail: { auth: { type: "oauth" }, url: "http://mcp.example.com" },
				},
			}).success
		).toBe(false);
	});

	it("requires both MCP and identity grants", () => {
		expect(
			PluginManifestSchema.safeParse({
				...manifest,
				permission_grants: ["mcp:server"],
			}).success
		).toBe(false);
	});
});
