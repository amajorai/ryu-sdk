/**
 * The create-ryu-app template registry and the `--help` text derived from it.
 *
 * Each entry names a template TREE under `template/<name>/` and says which
 * extension shape it produces (app, plugin or service). The scaffolder in
 * `index.ts` reads it to pick the tree and to write the generated package.json.
 */

/**
 * Which of the two extension shapes a template produces. This is not cosmetic: it
 * decides what the generated `package.json` says. A `plugin` is authored against
 * `@ryuhq/sdk` and packed with `ryu pack` (which bundles its widget code and
 * rewrites the manifest); an `app` is a satellite whose `sidecar/` must build and
 * ship from its own tree, so it depends on nothing of ours and has no bundle to
 * pack — giving it an SDK dependency would quietly break the one property
 * (self-containment) that makes it a satellite.
 */
export type TemplateKind = "app" | "plugin" | "service";

/** Per-template scaffolding config: which shape it produces, the `dev` entry file,
 *  and any extra deps/scripts the generated project needs. The template TREE lives
 *  in `template/<name>/`; the default (`agent`) preserves the original layout. */
export interface TemplateSpec {
	/** The file `bun dev` runs (relative to the project root). */
	devEntry: string;
	/** Extra runtime deps merged into the generated package.json. */
	extraDependencies?: Record<string, string>;
	/** Dev deps of the generated package.json (`service` templates only). */
	extraDevDependencies?: Record<string, string>;
	/** Extra scripts merged over the per-kind defaults in the generated package.json. */
	extraScripts?: Record<string, string>;
	/** APP (satellite + sidecar), PLUGIN (in-process contributions), or SERVICE
	 *  (a standalone server on `@ryuhq/services`: no manifest, no pack). */
	kind: TemplateKind;
	/** One-line description, printed in `--help` under its shape's heading. */
	summary: string;
}

/** Scripts for templates whose entry is a `createRyuServer` project module. */
const STUDIO_SCRIPTS = {
	dev: "bunx ryu dev --studio src/ryu.ts",
	build: "bunx ryu build src/ryu.ts --target node",
};

export const TEMPLATES = {
	agent: {
		kind: "plugin",
		summary:
			"a loop-owning agent with a local tool — runs against your node, no keys (Agent + defineTool)",
		devEntry: "src/agent.ts",
	},
	"expense-agent": {
		kind: "plugin",
		summary:
			"an agent that calls existing Ryu tools (Gmail via Composio; needs a Composio key and Gmail sign-in)",
		devEntry: "src/agent.ts",
	},
	workflow: {
		kind: "plugin",
		summary:
			"a typed workflow with an agent step and a human approval gate, served by the dev studio (createWorkflow + ryu dev --studio)",
		devEntry: "src/ryu.ts",
		extraDependencies: { zod: "^4.1.13" },
		extraScripts: STUDIO_SCRIPTS,
	},
	"multi-agent": {
		kind: "plugin",
		summary:
			"a supervisor routing between agents, with an approval-gated tool, served by the dev studio (createSupervisor + ryu dev --studio)",
		devEntry: "src/ryu.ts",
		extraDependencies: { zod: "^4.1.13" },
		extraScripts: STUDIO_SCRIPTS,
	},
	action: {
		kind: "plugin",
		summary: "a governed business action (defineAction)",
		devEntry: "src/action.ts",
	},
	"hook-plugin": {
		kind: "plugin",
		summary: "a post-assistant-turn hook (definePlugin + defineTurnHook)",
		devEntry: "src/plugin.ts",
	},
	"ryu-app": {
		kind: "plugin",
		summary: "an interactive in-chat widget (defineApp + a sandboxed widget)",
		devEntry: "src/app.ts",
		extraDependencies: { react: "^19.2.0", "react-dom": "^19.2.0" },
	},
	"companion-plugin": {
		kind: "plugin",
		summary: "a widget that calls a companion tool, plus a panel surface",
		devEntry: "src/app.ts",
		extraDependencies: { react: "^19.2.0", "react-dom": "^19.2.0" },
	},
	adapter: {
		kind: "plugin",
		summary:
			"a capability adapter (provider tool + provides binding + adapters/<verb>.js)",
		devEntry: "src/harness.ts",
		extraScripts: { test: "bun test" },
	},
	app: {
		kind: "app",
		summary:
			"an apps-store satellite: manifest + a loopback HTTP sidecar, driven through the ext-proxy",
		devEntry: "sidecar/src/main/index.ts",
		extraScripts: {
			build: "bun run --cwd sidecar build",
			"check-types": "bun run --cwd sidecar check-types",
		},
	},
	services: {
		kind: "service",
		summary:
			"a Hono server that publishes with Notify, sends with Mail and verifies their webhooks (@ryuhq/services)",
		devEntry: "src/index.ts",
		extraDependencies: { "@ryuhq/services": "^0.1.0", hono: "^4.8.2" },
		// Track the root catalog (`@types/bun`) and root `typescript`; the test checks.
		extraDevDependencies: { "@types/bun": "^1.4.4", typescript: "^5" },
		extraScripts: {
			dev: "bun --hot src/index.ts",
			start: "bun src/index.ts",
			test: "bun test",
			"check-types": "tsc --noEmit",
		},
	},
} satisfies Record<string, TemplateSpec>;

export function templateSpec(name: string): TemplateSpec | undefined {
	return Object.entries(TEMPLATES).find(([template]) => template === name)?.[1];
}

export const DEFAULT_TEMPLATE = "agent";

/** The `--template` block: one `name — summary` line per template, grouped under
 *  its shape so the app/plugin distinction is visible without reading the docs. */
function templateLines(kind: TemplateKind): string[] {
	const width = Math.max(...Object.keys(TEMPLATES).map((n) => n.length));
	return Object.entries(TEMPLATES)
		.filter(([, spec]) => spec.kind === kind)
		.map(
			([name, spec]) =>
				`    ${name.padEnd(width)}  ${spec.summary}${name === DEFAULT_TEMPLATE ? " (default)" : ""}`
		);
}

export function printUsage(): void {
	process.stderr.write(
		[
			"create-ryu-app — scaffold a starter Ryu app or plugin",
			"",
			"Usage:",
			"  bunx create-ryu-app <name> [--template <template>]",
			"",
			"Arguments:",
			"  <name>       Project directory name (also used as the app id slug)",
			"",
			"Options:",
			"  --template   Which starter to emit. Two shapes:",
			"",
			"  APP — a self-contained satellite: manifest.json + an out-of-process",
			"  sidecar/, reached through the generic ext-proxy (/api/ext/<id>/*).",
			"  Ships without any change to Ryu Core or the Gateway.",
			...templateLines("app"),
			"",
			"  PLUGIN — manifest contributions Ryu renders in-process: runnables,",
			"  turn hooks, widgets, composer controls, a companion panel. No sidecar,",
			"  no port.",
			...templateLines("plugin"),
			"",
			"  SERVICE — a standalone server on Ryu's standalone services (@ryuhq/services).",
			"  No manifest; not installed into Ryu.",
			...templateLines("service"),
			"",
		].join("\n")
	);
}
