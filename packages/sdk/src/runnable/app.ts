/**
 * Ryu App authoring factory — `defineApp`.
 *
 * A "Ryu App" bundles one or more tools whose results render an interactive
 * widget inline in chat (the ChatGPT-Apps-style surface). `defineApp` assembles a
 * complete `manifest.json` `PluginManifest` from a declarative description, deriving
 * the render-vs-companion split exactly the way Core's in-process provider does
 * (`apps/core/src/sidecar/mcp/apps/mod.rs` `tools()`):
 *
 *   - A **render** tool (`accessible` unset/false) produces the widget: it gets a
 *     `contributes.widgets[]` entry binding its id to the app's
 *     `ui://widget/<slug>.html` template, and its runnable config carries
 *     `widget:true` plus `invoking`/`invoked` status labels.
 *   - A **companion** tool (`accessible:true`) is a call target a mounted widget
 *     may invoke: it carries `widget_accessible:true` and gets no widget template.
 *
 * A tool may also attach a `ToolRunnable`. When present, its self-contained run
 * body is emitted as Core's grant-gated `inline_deno` backend, so the widget and
 * the behavior ship in one bundle. Without a runnable, the tool remains the
 * declarative pass-through form: the widget renders from
 * `window.openai.toolInput`/`toolOutput` and Core echoes the validated arguments
 * as `structuredContent`. `ryu pack` bundles the `uiEntry` source into the
 * manifest's `ui_code`.
 */

import type {
	Contributes,
	PluginManifest,
	Requires,
	RunnableMeta,
	SlashCommandContribution,
	Surface,
	ToolAppConfig,
	WidgetContribution,
} from "../manifest.ts";
import { PluginManifestSchema } from "../manifest.ts";
import { inlineToolRunnable, type ToolRunnable } from "./tool.ts";

/** The default widget MIME dialect (mirrors Core `default_widget_mime`). */
const DEFAULT_APP_WIDGET_MIME = "text/html+skybridge";
/** The default widget display mode (mirrors Core `default_widget_display_mode`). */
const DEFAULT_APP_DISPLAY_MODE = "inline";

/**
 * The grant Core requires before it will promote a tool's result into an inline
 * chat widget (mirrors Core's `WIDGET_RENDER_GRANT`).
 */
export const WIDGET_RENDER_GRANT = "widget:render";

/**
 * `grants` plus {@link WIDGET_RENDER_GRANT} when the app actually contributes a
 * widget. Order-preserving and idempotent, so an author who already declared it
 * gets no duplicate.
 */
function withWidgetRenderGrant(
	grants: readonly string[],
	widgets: readonly WidgetContribution[]
): string[] {
	const out = [...grants];
	if (widgets.length > 0 && !out.includes(WIDGET_RENDER_GRANT)) {
		out.push(WIDGET_RENDER_GRANT);
	}
	return out;
}

/** Add the grant required for any executable inline tool body. */
function withToolExecuteGrant(
	grants: readonly string[],
	tools: readonly AppToolSpec[]
): string[] {
	const out = [...grants];
	if (
		tools.some((tool) => tool.runnable !== undefined) &&
		!out.includes("tool:execute")
	) {
		out.push("tool:execute");
	}
	return out;
}

/** One tool a Ryu App declares. */
export interface AppToolSpec {
	/**
	 * True when this is a **companion** tool — a call target a mounted widget may
	 * `callTool`. False/unset makes it a **render** tool that produces the widget.
	 */
	accessible?: boolean;
	/** Human-readable description the model reads when choosing the tool. */
	description: string;
	/** JSON Schema object describing the tool's arguments. Optional. */
	inputSchema?: Record<string, unknown>;
	/** Status label shown when a render tool finishes (e.g. `"Chart ready"`). */
	invoked?: string;
	/** Status label shown while a render tool runs (e.g. `"Plotting chart…"`). */
	invoking?: string;
	/** Tool name (unqualified). The wire id is `<server>.<name>`. */
	name: string;
	/**
	 * Optional executable body for this tool. Core receives it as an
	 * `inline_deno` runnable and runs it in the deny-by-default tool sandbox.
	 * The body must be self-contained; use the injected `host` capability surface
	 * for governed model calls and other platform primitives.
	 */
	runnable?: Pick<ToolRunnable, "code" | "id" | "name" | "schema">;
}

/**
 * The `requires` block as an AUTHOR writes it: both members optional. Distinct
 * from the parsed {@link Requires} (where zod has applied its `[]` defaults, so
 * both are present).
 */
export interface DefineAppRequires {
	/** Plugins that must be installed + enabled before this app enables. */
	apps?: Requires["apps"];
	/**
	 * Abstract capability edges the broker binds to a provider at enable time
	 * (`[{ capability: "rag" }]`). This is what composable agent slots lower to.
	 */
	capabilities?: Requires["capabilities"];
	/** Grants implied by those dependencies (declaration only). */
	grants?: string[];
}

/** Options for {@link defineApp}. */
export interface DefineAppOptions {
	/** VS-Code-style activation events. Empty = eager (default `["*"]`). */
	activationEvents?: string[];
	/** Default widget display mode (`inline` | `fullscreen` | `pip`). */
	displayMode?: string;
	/** Permission grants the app declares it needs (e.g. `["mcp:web_search"]`). */
	grants?: string[];
	/** Reverse-domain plugin id (e.g. `"com.example.checklist"`). */
	id: string;
	/** Widget MIME dialect. Defaults to `text/html+skybridge`. */
	mime?: string;
	/**
	 * Plugin-to-plugin dependencies. Core auto-enables them (in dependency order)
	 * before this app, and refuses to disable one while this app still needs it.
	 * Omit for the common case (no dependencies) — the key is then absent from the
	 * emitted manifest entirely.
	 */
	requires?: DefineAppRequires;
	/** MCP server namespace for the tool ids. Defaults to `slug`. */
	server?: string;
	/** Slash commands this app exposes in the chat composer. */
	slashCommands?: SlashCommandContribution[];
	/**
	 * App slug — used to build the widget uri (`ui://widget/<slug>.html`) and, when
	 * `server` is omitted, the MCP server namespace that qualifies each tool id.
	 */
	slug: string;
	/**
	 * Host surfaces this app runs on. **Omitted/empty = every surface** (the
	 * backward-compatible default); it never means "hidden".
	 */
	targets?: Surface[];
	/** Human-readable display name shown in the app store / launcher. */
	title: string;
	/** The tools this app exposes (at least one render tool is expected). */
	tools: AppToolSpec[];
	/**
	 * Source entry (relative to the manifest dir) for the widget UI. `ryu pack`
	 * bundles it into the manifest's `ui_code` so Core can serve the widget HTML.
	 */
	uiEntry: string;
	/** Semver version string (e.g. `"1.0.0"`). */
	version: string;
}

/** Build a fully-qualified tool id from a server namespace and tool name. */
export function appToolId(server: string, name: string): string {
	return `${server}.${name}`;
}

/**
 * Assemble a `manifest.json` manifest for a Ryu App. The result matches Core's
 * `PluginManifest` serde shape (validated through `PluginManifestSchema`) and can
 * be written to disk, packed with `ryu pack`, or published with `ryu publish`.
 *
 * @example
 * ```ts
 * import { defineApp } from "@ryuhq/sdk"
 *
 * const manifest = defineApp({
 *   id: "com.example.checklist",
 *   title: "Checklist",
 *   version: "1.0.0",
 *   slug: "checklist",
 *   uiEntry: "src/checklist.tsx",
 *   tools: [
 *     { name: "render", description: "Render a checklist", invoking: "Building…", invoked: "Ready" },
 *     { name: "toggle", description: "Toggle an item", accessible: true },
 *   ],
 * })
 * ```
 */
export function defineApp(options: DefineAppOptions): PluginManifest {
	const server = options.server ?? options.slug;
	const uri = `ui://widget/${options.slug}.html`;
	const mime = options.mime ?? DEFAULT_APP_WIDGET_MIME;
	const displayMode = options.displayMode ?? DEFAULT_APP_DISPLAY_MODE;
	// Whether the app declares any companion tool. A render tool's widget may call
	// tools only when the app has at least one companion — mirrors `has_companions`
	// in Core's `apps::tools()`.
	const hasCompanions = options.tools.some((t) => t.accessible === true);

	const runnables: RunnableMeta[] = [];
	const widgets: WidgetContribution[] = [];

	for (const spec of options.tools) {
		const isRender = spec.accessible !== true;
		const id = appToolId(server, spec.name);
		const executable = spec.runnable
			? inlineToolRunnable(spec.runnable)
			: undefined;

		const config: ToolAppConfig & Record<string, unknown> = {
			...(executable?.config ?? {}),
			slug: id,
			description: spec.description,
			widget: isRender,
			widget_accessible: isRender ? hasCompanions : true,
			...(spec.inputSchema ? { input_schema: spec.inputSchema } : {}),
			...(spec.invoking ? { invoking: spec.invoking } : {}),
			...(spec.invoked ? { invoked: spec.invoked } : {}),
		};

		runnables.push({
			id,
			name: spec.name,
			kind: "tool",
			config,
		});

		if (isRender) {
			widgets.push({
				tool_id: id,
				uri,
				ui_entry: options.uiEntry,
				mime,
				default_display_mode: displayMode,
			});
		}
	}

	const contributes: Contributes = {
		turn_hooks: [],
		chat_features: [],
		// This builder synthesises an app from its runnables; an app that emits
		// events declares them in a hand-authored `manifest.json`, same as
		// `lsp_servers` below.
		hook_events: [],
		composer_controls: [],
		settings_tabs: [],
		slash_commands: options.slashCommands ?? [],
		sidebar_sections: [],
		sidebar_buttons: [],
		dock_panels: [],
		live_activities: [],
		// Empty for the same reason as every sibling family above: this builder
		// synthesises `widgets` from the app's own runnables and nothing else, and
		// takes no `contributes` passthrough. An app that wants to declare language
		// servers writes them in a hand-authored `manifest.json`.
		lsp_servers: {},
		// Same reason again: a danger-zone category, a Pi extension and an output
		// style are all hand-authored declarations, not something derivable from
		// runnables. An output style in particular points at a Markdown file next
		// to the manifest, which this builder never writes.
		data_categories: [],
		pi_extensions: [],
		output_styles: [],
		message_actions: [],
		selection_actions: [],
		widgets,
	};

	const raw = {
		id: options.id,
		name: options.title,
		version: options.version,
		runnables,
		// An app that synthesises widgets MUST hold `widget:render`, so this
		// builder declares it rather than leaving the author to discover it.
		//
		// Core gates widget promotion on declared-AND-enabled-AND-granted, and a
		// missing grant fails as `DeniedNoGrant` — which is an `info!` log and
		// nothing else. The widget silently renders as plain text, with no error
		// in the UI and nothing pointing at the manifest.
		//
		// Added only when there is a widget to render, and unioned rather than
		// overwritten so an author's own `grants` list survives and re-declaring
		// it is not an error.
		permission_grants: withToolExecuteGrant(
			withWidgetRenderGrant(options.grants ?? [], widgets),
			options.tools
		),
		activation_events: options.activationEvents ?? ["*"],
		contributes,
		// `targets: []` means EVERY surface, so an app that declares none is
		// unrestricted — the backward-compatible default.
		targets: options.targets ?? [],
		// `requires` stays ABSENT (not `{apps:[],grants:[]}`) when undeclared, so the
		// emitted manifest carries no key at all — matching Core's
		// `Option<Requires>` + `skip_serializing_if = "Option::is_none"`.
		...(options.requires
			? {
					requires: {
						apps: options.requires.apps ?? [],
						capabilities: options.requires.capabilities ?? [],
						grants: options.requires.grants ?? [],
					},
				}
			: {}),
	};

	const result = PluginManifestSchema.safeParse(raw);
	if (!result.success) {
		const first = result.error.issues[0];
		const field = first?.path.join(".") ?? "unknown";
		const message = first?.message ?? "validation failed";
		throw new Error(
			`manifest.json validation failed at '${field}': ${message}`
		);
	}
	return result.data;
}
