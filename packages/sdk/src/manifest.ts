/**
 * Ryu SDK manifest types — TypeScript mirror of the Core `plugin_manifest` and
 * `runnable` schemas (`apps/core/src/plugin_manifest/mod.rs` and
 * `apps/core/src/runnable/mod.rs`).
 *
 * These types must stay in sync with the Rust serde shapes so that a manifest
 * authored here deserialises cleanly by `PluginManifestLoader::load()` in Core.
 *
 * Design note on engine/model fields: every field that holds an engine name,
 * model id, or provider reference is typed as `string` — never a union of
 * known provider literals.  A new provider must never require an SDK change.
 */

import { createRequire } from "node:module";
import { z } from "zod";

// ── Lazy, optional native addon ──────────────────────────────────────────────
//
// The Rust-cored validation helpers at the bottom of this file delegate to the
// `@ryuhq/sdk-native` napi addon (`crates/ryu-sdk-napi`). That addon is a
// prebuilt, platform-specific `.node` binary and is *not* always present — e.g.
// in a fresh `create-ryu-app` scaffold context, which imports this module only
// for `PluginManifestSchema` (pure-JS zod). Importing `@ryuhq/sdk/manifest`
// must therefore never hard-require the addon at module load. We load it lazily
// on first use of a helper that needs it, cache it, and throw a descriptive
// error only if a caller actually invokes those helpers without the addon.
interface NativeAddon {
	parseAndValidateManifest(manifestJson: string): string;
	pluginManifestJsonSchema(): string;
	validatePluginId(id: string): void;
}

let cachedNative: NativeAddon | null = null;
let nativeLoadError: Error | null = null;

/**
 * Load the `@ryuhq/sdk-native` addon on demand. Uses a synchronous `require`
 * (via `createRequire`) so the surrounding helpers can stay synchronous, and
 * works in both the ESM and CJS builds (tsup `shims` provides `import.meta.url`
 * in the CJS output). Throws a descriptive error when the addon is absent.
 */
function loadNative(): NativeAddon {
	if (cachedNative) {
		return cachedNative;
	}
	if (nativeLoadError) {
		throw nativeLoadError;
	}
	try {
		const req = createRequire(import.meta.url);
		cachedNative = req("@ryuhq/sdk-native") as NativeAddon;
		return cachedNative;
	} catch (cause) {
		nativeLoadError = new Error(
			"@ryuhq/sdk-native (the Rust-cored napi addon) is not available; " +
				"Core-strict manifest validation requires it. Build/install the addon, " +
				"or use PluginManifestSchema (pure-JS zod) for authoring-time validation.",
			{ cause }
		);
		throw nativeLoadError;
	}
}

// ── RunnableKind ─────────────────────────────────────────────────────────────

/**
 * The kind of a Runnable. Mirrors `RunnableKind` in
 * `apps/core/src/runnable/mod.rs`.
 */
export const RunnableKindSchema = z.enum([
	"agent",
	"workflow",
	"tool",
	"skill",
	// A companion surface (in-desktop panel). Added so a packable plugin can
	// declare a companion runnable that flows through Core's existing Companion
	// handler → app_contrib → `GET /api/plugins/contributions` → the desktop
	// `/plugin/<id>` route. Its `config.ui_entry` (see `CompanionRunnableConfigSchema`)
	// is what `ryu pack` bundles into `ui_code`.
	"companion",
]);

export type RunnableKind = z.infer<typeof RunnableKindSchema>;

// ── RunnableMeta ─────────────────────────────────────────────────────────────

/**
 * Kind-agnostic identity snapshot of a Runnable. Mirrors `RunnableMeta` in
 * `apps/core/src/runnable/mod.rs`.
 */
export const RunnableMetaSchema = z.object({
	/** Stable unique identifier (e.g. `"agent-researcher"`). */
	id: z.string().min(1),
	/** Human-readable display name. */
	name: z.string().min(1),
	/** Which kind of runnable this entry describes. */
	kind: RunnableKindSchema,
	/**
	 * Optional per-kind config blob. Mirrors Core's `RunnableEntry.config`
	 * (`Option<serde_json::Value>`) so a manifest authored here round-trips
	 * through Core-strict validation. Left opaque (a record) at this authoring
	 * layer; the per-kind shape is enforced by Core's `validate_runnable`.
	 *
	 * For a `companion` runnable, `config.ui_entry` names the plugin's UI entry
	 * module (relative to the manifest dir). `ryu pack` bundles that entry into
	 * the emitted `ui_code`; Core's `CompanionConfig.ui_entry` is the lockstep
	 * field so a packed companion validates.
	 */
	config: z.record(z.string(), z.unknown()).optional(),
});

export type RunnableMeta = z.infer<typeof RunnableMetaSchema>;

// ── CompanionSurface ─────────────────────────────────────────────────────────

/**
 * True when a companion `label` impersonates first-party Ryu/system chrome.
 *
 * Mirrors Core's `label_impersonates_system_chrome`
 * (`apps/core/src/plugin_manifest/schema.rs`) and the desktop `validatePluginRoute`
 * title gate (`apps/desktop/src/contributions/host/rpc.ts`): a plugin's visible
 * label may not contain `"ryu"` or `"system"` (case-insensitive), so a third-party
 * companion can never pose as built-in UI. The desktop host's mandatory,
 * non-removable `"Plugin ·"` attribution prefix is the primary guarantee; this is
 * defense in depth enforced at the authoring seam so a hostile label is rejected
 * before `ryu pack`/publish rather than at load.
 */
export function labelImpersonatesSystemChrome(label: string): boolean {
	const lower = label.toLowerCase();
	return lower.includes("ryu") || lower.includes("system");
}

/**
 * Optional in-desktop overlay / sidebar panel descriptor. Mirrors
 * `CompanionSurface` in `apps/core/src/plugin_manifest/mod.rs`.
 */
export const CompanionSurfaceSchema = z.object({
	/** Display label for the companion panel tab or tooltip. Anti-impersonation:
	 *  may not pose as first-party Ryu/system chrome (see
	 *  {@link labelImpersonatesSystemChrome}). */
	label: z
		.string()
		.min(1)
		.refine((value) => !labelImpersonatesSystemChrome(value), {
			message:
				"companion label must not impersonate system chrome (must not contain 'ryu' or 'system')",
		}),
	/** Icon identifier resolved by the desktop shell. */
	icon: z.string().optional(),
	/** Keyboard shortcut string (e.g. `"ctrl+shift+r"`). */
	shortcut: z.string().optional(),
});

export type CompanionSurface = z.infer<typeof CompanionSurfaceSchema>;

// ── Contributes (turn hooks + declarative UI) ────────────────────────────────

/**
 * A server-side chat turn hook. Mirrors `TurnHookContribution` in
 * `crates/core/kernel-contracts/src/manifest.rs`. The body is a JS fragment run in
 * the plugin sandbox with `ctx` + `host` in scope; it returns a directive.
 *
 * It arrives one of two ways, and **exactly one** must be present:
 *
 * - `code_file` — the authoring form: a path to a real `hooks/<name>.js` file next
 *   to the manifest. Readable, lintable, diffable, and reviewable for what it
 *   actually does. Every first-party plugin uses this.
 * - `code` — the wire form: the body inline. `ryu pack` produces it by reading
 *   `code_file`, which is what keeps the whole hook body INSIDE the Gateway-signed
 *   surface; Core also accepts it directly for a hand-written or `defineTurnHook`
 *   generated manifest.
 */
export const TurnHookContributionSchema = z
	.object({
		/** Stable id for this hook (unique within the plugin). */
		id: z.string().min(1),
		/** Turn boundary this fires on. Today only `"post_assistant_turn"`. */
		on: z.string().min(1).default("post_assistant_turn"),
		/** The JS hook body executed in the sandbox (returns a directive). */
		code: z.string().min(1).optional(),
		/** Path to the hook body, relative to the plugin root (`hooks/<name>.js`). */
		code_file: z.string().min(1).optional(),
		/**
		 * Cheap pre-gate mirroring Core's `HookMatch` (serde name `match` on
		 * `TurnHookContribution.run_when`). MUST round-trip through this schema:
		 * `ryu pack`/`publish` persist `safeParse(...).data`, so a field missing here
		 * is silently STRIPPED before signing — a tool-gated `pre_tool_use` hook
		 * (e.g. `tools: ["bash*"]`) would lose its gate and run on EVERY tool call.
		 */
		match: z
			.object({
				/** Run only if the request set this composer flag true. */
				flag: z.string().optional(),
				/** Run if the last user message starts with any of these prefixes. */
				commands: z.array(z.string()).default([]),
				/** Run if the plugin has stored state for this conversation. */
				stateful: z.boolean().default(false),
				/** Run if `ctx.tool_name` matches any of these `*`-wildcard patterns. */
				tools: z.array(z.string()).default([]),
			})
			.optional(),
	})
	// Fail closed, mirroring Core: declaring NEITHER would have the sandbox run an
	// empty body, which no read site can tell apart from a hook that chose to do
	// nothing; declaring BOTH gives two sources of truth for what executes.
	.refine((h) => Boolean(h.code) !== Boolean(h.code_file), {
		message:
			"a turn hook must declare exactly one of 'code' (inline body) or 'code_file' (path to hooks/<name>.js)",
		path: ["code_file"],
	});

export type TurnHookContribution = z.infer<typeof TurnHookContributionSchema>;

/**
 * One **app event** this plugin declares it emits. Mirrors `HookEventContribution`
 * in `crates/core/kernel-contracts/src/manifest.rs`.
 *
 * `turn_hooks` is the *consuming* half of the hook system; this is the *providing*
 * half. Declaring an event here lets any other plugin react to it with a
 * `turn_hooks[].on` naming the event, and any workflow react to it with an `event`
 * trigger — without the emitter knowing a consumer exists. The event is raised at
 * runtime by this plugin's own sidecar calling the `events.emit` host capability.
 *
 * `id` MUST be `<this plugin's id>#<event name>`. Core validates the namespace half
 * against the owning manifest at load and re-checks it on every emit, which is both
 * what makes collisions with Core's own hook phases impossible (a Core phase never
 * contains `#`) and what stops one app emitting another's events.
 */
export const HookEventContributionSchema = z.object({
	/** Fully-qualified event id: `<plugin id>#<event name>`, e.g. `@acme/meetings#meeting.ended`. */
	id: z.string().min(1),
	/** Human-readable title for the event picker. */
	title: z.string().min(1),
	/** What the event means and when it fires. */
	description: z.string().optional(),
	/** Example of the `ctx.event` payload. Documentation, not a validated schema. */
	payload_example: z.record(z.string(), z.unknown()).optional(),
});

export type HookEventContribution = z.infer<typeof HookEventContributionSchema>;

// ── PiExtensionContribution ───────────────────────────────────────────────────

/**
 * One Pi extension the plugin ships — a TypeScript file the managed `ryu` (Pi)
 * agent loads at process start. Mirrors Rust `PiExtensionContribution`.
 *
 * Carries a PATH, never a body: unlike `turn_hooks` there is no inline `code`
 * twin, because nothing downstream reads the source as a string.
 *
 * That makes it a SIDECAR FILE, and `ryu pack` emits a single JSON bundle — so a
 * plugin installed from a packed bundle arrives without its `pi-extensions/`
 * directory and Core resolves the declaration to a visible skip. Same open gap as
 * `skills/**`, which the bundle likewise does not carry. Today the path that works
 * is a plugin whose directory is on disk (a built-in, a satellite checkout, a dev
 * tree). Do not "fix" this by inlining the source into the manifest: a 50 KB
 * TypeScript program escaped into a JSON string is the unauditable form the whole
 * `code_file` extraction exists to prevent.
 *
 * Note this is UNSANDBOXED code: it runs inside the agent process with full host
 * privilege, so Core gates it behind the operator-only `pi:extension` grant for
 * any non-built-in plugin.
 */
export const PiExtensionContributionSchema = z.object({
	/** Stable id for this extension within the plugin (`[a-z0-9][a-z0-9._-]*`). */
	id: z.string().min(1),
	/** Path to the source, relative to the plugin root: `pi-extensions/<name>.ts`. */
	file: z.string().min(1),
	/** Optional one-liner describing what the extension adds to the agent. */
	description: z.string().optional(),
});

export type PiExtensionContribution = z.infer<
	typeof PiExtensionContributionSchema
>;

// ── OutputStyleContribution ──────────────────────────────────────────────────

/**
 * One output style the plugin ships — a Markdown file (YAML frontmatter + prose)
 * that rewrites the system prompt's voice for a turn. Mirrors the Rust-side
 * `OutputStyleContribution`.
 *
 * Unlike `pi_extensions` above, this one is INLINED by `ryu pack`: `file` is the
 * source form and `source` is the wire form, exactly as `code_file` → `code`. That
 * is why both fields exist here and only `file` exists there — a style body is
 * prose nothing evaluates, so inlining it costs no auditability (the whole point of
 * keeping `pi-extensions/*.ts` out of the manifest), and it is what keeps the body
 * inside the Gateway-signed surface instead of relying on a directory the installed
 * plugin does not carry.
 *
 * Typed rather than a loose record for the same reason `pi_extensions` is: three
 * fields, all of them Ryu's own vocabulary. Deliberately NOT refined to
 * "exactly one of `file` / `source`" — Core's `Contributes::validate_output_styles`
 * is the single gate for that rule, and a second copy here is a place the two can
 * disagree about a manifest that has already been hydrated once.
 */
export const OutputStyleContributionSchema = z.object({
	/** Stable id for this style within the plugin (`[a-z0-9][a-z0-9._-]*`). It is
	 *  also the persisted selection key, so it must survive a settings key and a URL
	 *  path. */
	id: z.string().min(1),
	/** SOURCE form: path to the Markdown file, relative to the plugin root —
	 *  exactly `output-styles/<name>.md`. `ryu pack` replaces this with `source`. */
	file: z.string().min(1).optional(),
	/** WIRE form: the file's contents verbatim, frontmatter INCLUDED. The whole file
	 *  rather than a pre-split body plus mirrored `name`/`description` keys, so a
	 *  plugin style and a user's own `output-styles/*.md` go through one parser and
	 *  the frontmatter stays the single source of truth for a style's metadata. */
	source: z.string().optional(),
});

export type OutputStyleContribution = z.infer<
	typeof OutputStyleContributionSchema
>;

// ── WidgetContribution (Ryu Apps) ─────────────────────────────────────────────

/** Default widget MIME dialect. Mirrors Core `default_widget_mime`. */
const DEFAULT_WIDGET_MIME = "text/html+skybridge";
/** Default widget display mode. Mirrors Core `default_widget_display_mode`. */
const DEFAULT_WIDGET_DISPLAY_MODE = "inline";

/**
 * One app-widget contribution (Ryu Apps). Binds the render tool that produces the
 * widget to its `ui://widget/<slug>.html` template. Shape-identical to Core's
 * `WidgetContribution` (`apps/core/src/plugin_manifest/mod.rs`): built-in apps
 * serve the HTML from the in-process provider and leave `ui_entry` unset, while a
 * third-party app authored here sets `ui_entry` so `ryu pack` bundles the source
 * into the manifest's `ui_code`.
 */
export const WidgetContributionSchema = z.object({
	/** The fully-qualified tool id whose result renders this widget. */
	tool_id: z.string().min(1),
	/** `ui://widget/<slug>.html` — the widget resource uri. */
	uri: z.string().min(1),
	/** Source entry (e.g. `src/apps/checklist/index.tsx`) for `ryu pack`. */
	ui_entry: z.string().optional(),
	/** Widget MIME dialect (default `text/html+skybridge`). */
	mime: z.string().default(DEFAULT_WIDGET_MIME),
	/** Default display mode (`inline` | `fullscreen` | `pip`). */
	default_display_mode: z.string().default(DEFAULT_WIDGET_DISPLAY_MODE),
});

export type WidgetContribution = z.infer<typeof WidgetContributionSchema>;

/** Metadata-only chat affordance. The host owns rendering and dispatch; the
 * manifest carries identifiers and copy only. */
export const ChatWidgetTemplateSchema = z
	.object({
		id: z.string().regex(/^[a-z0-9][a-z0-9._:-]*$/),
		title: z.string().min(1),
		description: z.string().optional(),
		triggers: z.array(z.string()).default([]),
		examples: z.array(z.string()).default([]),
		backing: z.object({
			tool_id: z
				.string()
				.regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
				.optional(),
			view_id: z
				.string()
				.regex(/^[a-z0-9][a-z0-9._:-]*$/)
				.optional(),
		}),
		display_mode: z.string().min(1),
		safe_action_ids: z
			.array(z.string().regex(/^[a-z0-9][a-z0-9._-]*$/))
			.default([]),
		availability: z.string().default("available"),
	})
	.superRefine((value, ctx) => {
		const count =
			Number(Boolean(value.backing.tool_id)) +
			Number(Boolean(value.backing.view_id));
		if (count !== 1 && value.availability === "available") {
			ctx.addIssue({
				code: "custom",
				path: ["backing"],
				message:
					"available templates need exactly one backing tool_id or view_id",
			});
		}
		if (count > 1) {
			ctx.addIssue({
				code: "custom",
				path: ["backing"],
				message: "backing must declare at most one of tool_id or view_id",
			});
		}
	});

export type ChatWidgetTemplate = z.infer<typeof ChatWidgetTemplateSchema>;

// ── ToolAppConfig (Ryu Apps per-tool config) ─────────────────────────────────

/**
 * The `config` blob carried by a Ryu App's `kind:"tool"` runnable. Core's strict
 * `ToolConfig` (`apps/core/src/plugin_manifest/schema.rs`) requires `slug` and
 * ignores unknown fields on the current shape; the widget flags below are read by
 * Core's `register_app_tool_with_widget` synthesis path (a separate Core unit) to
 * rebuild the `_meta` binding, mirroring how the in-process `apps::tools()`
 * derives `outputTemplate` / `toolInvocation` / `widgetAccessible`.
 */
export const ToolAppConfigSchema = z.object({
	/** MCP tool slug this runnable wraps — the fully-qualified `<server>.<name>` id. */
	slug: z.string().min(1),
	/** The tool description the model reads when choosing it. Carried here because a
	 *  packed app's manifest is the only channel (there is no `generated.rs`); Core's
	 *  app-tool synthesis reads it back onto the `RegistryTool`. */
	description: z.string(),
	/** JSON Schema for the tool's arguments (used for validation + the LLM tool
	 *  surface). Snake_case to match `widget_accessible`. Absent = no arguments. */
	input_schema: z.record(z.string(), z.unknown()).optional(),
	/** True when calling this tool renders the app's widget (carries the template). */
	widget: z.boolean().default(false),
	/** True when a mounted widget may `callTool` this tool (a companion), or when a
	 *  render tool's widget may call any companion the app declares. */
	widget_accessible: z.boolean().default(false),
	/** Optional status label shown while the render tool runs. */
	invoking: z.string().optional(),
	/** Optional status label shown when the render tool finishes. */
	invoked: z.string().optional(),
});

export type ToolAppConfig = z.infer<typeof ToolAppConfigSchema>;

/** One selectable value for a plugin/app slash-command argument. */
export const SlashCommandOptionSchema = z
	.object({
		description: z.string().optional(),
		label: z.string().min(1),
		value: z.string().min(1),
	})
	.passthrough();

export type SlashCommandOption = z.infer<typeof SlashCommandOptionSchema>;

/** A registered free-form option shown alongside an argument's choices. */
export const SlashCommandCustomOptionSchema = z.union([
	z.literal(true),
	z
		.object({
			description: z.string().optional(),
			label: z.string().min(1).optional(),
		})
		.passthrough(),
]);

export type SlashCommandCustomOption = z.infer<
	typeof SlashCommandCustomOptionSchema
>;

/** One sequential argument in a plugin/app slash command. */
export const SlashCommandArgumentSchema = z
	.object({
		allow_custom: z.boolean().optional(),
		custom: SlashCommandCustomOptionSchema.optional(),
		description: z.string().optional(),
		name: z.string().min(1),
		options: z.array(SlashCommandOptionSchema).optional(),
	})
	.passthrough();

export type SlashCommandArgument = z.infer<typeof SlashCommandArgumentSchema>;

/**
 * A command registered by a plugin or Ryu App. `args` is the preferred key;
 * `parameters` is accepted as a readable alias for hand-authored manifests.
 * Each argument's options are plugin-owned, so the shell never needs a closed
 * enum for app-specific values.
 */
export const SlashCommandContributionSchema = z
	.object({
		args: z.array(SlashCommandArgumentSchema).optional(),
		body: z.string().optional(),
		command: z.string().min(1),
		description: z.string().optional(),
		id: z.string().optional(),
		parameters: z.array(SlashCommandArgumentSchema).optional(),
	})
	.passthrough();

export type SlashCommandContribution = z.infer<
	typeof SlashCommandContributionSchema
>;

/**
 * The `contributes` block. Mirrors `Contributes` in
 * `apps/core/src/plugin_manifest/mod.rs`. The declarative UI surfaces
 * (`composer_controls` / `chat_features` / `settings_tabs`) are passed verbatim
 * to the desktop renderer, so they are typed loosely here (records).
 */
export const ContributesSchema = z.object({
	turn_hooks: z.array(TurnHookContributionSchema).default([]),
	/** App events this plugin EMITS — the provider half of the hook system, whose
	 *  consumer half is `turn_hooks`. Mirrors the Rust `Contributes.hook_events`;
	 *  omitting it here would have `ryu pack` strip every declared event before
	 *  signing, leaving an app that emits events nothing is allowed to subscribe to. */
	hook_events: z.array(HookEventContributionSchema).default([]),
	composer_controls: z.array(z.record(z.string(), z.unknown())).default([]),
	/** Chat feature descriptors whose behavior is implemented by the host shell.
	 * Mirrors the Rust-side `Contributes.chat_features`; keeping this field in the
	 * authoring schema prevents `ryu pack` from silently deleting a plugin's chat
	 * feature declaration before signing. */
	chat_features: z.array(z.record(z.string(), z.unknown())).default([]),
	settings_tabs: z.array(z.record(z.string(), z.unknown())).default([]),
	slash_commands: z.array(SlashCommandContributionSchema).default([]),
	/** App widgets (Ryu Apps). Each binds a render tool id to its
	 *  `ui://widget/<slug>.html` template. Mirrors the Rust-side
	 *  `Contributes.widgets` field, without which the CLI's zod parse would strip
	 *  every widget an app authored here declares. */
	widgets: z.array(WidgetContributionSchema).default([]),
	/** Metadata-only chat widget templates. */
	chat_widget_templates: z.array(ChatWidgetTemplateSchema).optional(),
	/** App-registered sidebar sections (header + live list) and buttons (single nav
	 *  rows). Loosely typed here — the shell owns the spec vocabulary — matching how
	 *  `composer_controls`/`settings_tabs` are declared. Mirrors the Rust-side
	 *  `Contributes.sidebar_sections` / `Contributes.sidebar_buttons`. */
	sidebar_sections: z.array(z.record(z.string(), z.unknown())).default([]),
	sidebar_buttons: z.array(z.record(z.string(), z.unknown())).default([]),
	/** App-registered workspace dock panels (a tab in the desktop's bottom/right
	 *  dock). Loosely typed for the same reason as the surfaces above — the shell
	 *  owns the `panel` render-mode vocabulary and the `spec` payload. Mirrors the
	 *  Rust-side `Contributes.dock_panels`; without it the CLI's zod parse would
	 *  strip the dock panel an app declares here. */
	dock_panels: z.array(z.record(z.string(), z.unknown())).default([]),
	/** App-registered live activities (the desktop "Dynamic Island" cards). Loosely
	 *  typed for the same reason as the surfaces above — the shell owns the
	 *  `spec` vocabulary. Mirrors the Rust-side `Contributes.live_activities`;
	 *  without it the CLI's zod parse would strip every live activity an app
	 *  declares here, so a packed bundle would ship a dock that silently stays
	 *  empty. */
	live_activities: z.array(z.record(z.string(), z.unknown())).default([]),
	/** Deletable data categories the app owns — one "Delete all X" row in Settings
	 *  → Danger Zone. Mirrors the Rust-side `Contributes.data_categories`; without
	 *  it the CLI's zod parse would strip the declaration before signing, and the
	 *  app's danger-zone row would simply never appear on any node that installed
	 *  the packed bundle. Loosely typed here for the same reason as the surfaces
	 *  above — Core is the layer that types it, because Core is the layer that has
	 *  to resolve the id to something that can actually delete the rows. */
	data_categories: z.array(z.record(z.string(), z.unknown())).default([]),
	/** Language servers the plugin declares, keyed by server name — the mirror of
	 *  Claude Code's `.lsp.json` / `lspServers`, so a config written for either host
	 *  loads in the other. Mirrors the Rust-side `Contributes.lsp_servers`; without
	 *  it the CLI's zod parse would strip every language server a plugin declares,
	 *  before the manifest is signed.
	 *
	 *  The ENTRY is deliberately a loose record and not a 13-field `z.object()`
	 *  mirroring `LspServerContribution`. Claude Code owns this field vocabulary,
	 *  not Ryu: a typed object here would strip a field from a newer Claude release
	 *  on its way through `ryu pack` — the same silent-deletion bug this field
	 *  exists to fix, one level down. Core is the layer that types it, because Core
	 *  is the layer that acts on it. */
	lsp_servers: z
		.record(z.string(), z.record(z.string(), z.unknown()))
		.default({}),
	/** Pi extensions the plugin ships — TypeScript the managed `ryu` (Pi) agent
	 *  loads at process start. Mirrors the Rust-side `Contributes.pi_extensions`;
	 *  without it the CLI's zod parse would strip the declaration before signing,
	 *  and the packed plugin would ship a `pi-extensions/` folder nothing loads.
	 *
	 *  Typed (not a loose record) because Ryu owns this vocabulary — three fields,
	 *  all of them Core-interpreted — unlike `lsp_servers`, whose entry shape is
	 *  Claude Code's to extend. */
	pi_extensions: z.array(PiExtensionContributionSchema).default([]),
	/** Output styles the plugin ships — Markdown files that rewrite the system
	 *  prompt's voice. Mirrors the Rust-side `Contributes.output_styles`; without it
	 *  the CLI's zod parse would strip the declaration, and `ryu pack` would sign a
	 *  bundle whose styles simply do not exist. Worse than the usual case of that
	 *  bug: the styles' `.md` files are not carried by the bundle either, so there
	 *  would be no residue to notice — the plugin would install clean and contribute
	 *  nothing. */
	output_styles: z.array(OutputStyleContributionSchema).default([]),
	/** Per-message actions contributed by an enabled plugin. Kept as loose records
	 *  so renderer-specific `kind`/`args` payloads survive `ryu pack` unchanged. */
	message_actions: z.array(z.record(z.string(), z.unknown())).default([]),
	/** Buttons contributed to the floating text-selection toolbar. Kept as loose
	 *  records so host-owned dispatch args survive `ryu pack` unchanged. */
	selection_actions: z.array(z.record(z.string(), z.unknown())).default([]),
});

export type Contributes = z.infer<typeof ContributesSchema>;

// ── SetupStep (listing companion/config card) ────────────────────────────────

/**
 * One optional post-install setup/companion card step surfaced on the
 * marketplace detail dialog (Phase 1.5 Ryu extension). All fields optional so a
 * card can be a bare call-to-action or a labelled instruction. `ryu publish`
 * forwards this into the publish body's `setup` field.
 */
export const SetupStepSchema = z.object({
	/** Card heading (e.g. the companion app name). */
	title: z.string().optional(),
	/** Instruction body shown under the title. */
	description: z.string().optional(),
	/** Label for the optional action button. */
	actionLabel: z.string().optional(),
	/** URL the action button opens (validated server-side on publish). */
	actionUrl: z.string().optional(),
});

export type SetupStep = z.infer<typeof SetupStepSchema>;

// ── Requires (plugin-to-plugin dependencies) ─────────────────────────────────

/**
 * A single plugin-to-plugin dependency edge. Mirrors `AppDependency` in
 * `apps/core/src/plugin_manifest/mod.rs`.
 *
 * `min_version` is snake_case on the wire (Core declares no serde rename) and is
 * a **minimum**, not a caret range: a bare `"1.2.0"` means `">=1.2.0"`, so an
 * installed `2.0.0` satisfies it. Explicit comparator syntax (`">=1.2, <2"`,
 * `"^1.2"`, `"~1.2"`) is honoured verbatim by Core's `parse_min_version`.
 */
export const AppDependencySchema = z.object({
	/** The `id` of the plugin this one depends on. */
	id: z.string().min(1, "dependency id is required"),
	/** Optional MINIMUM version the dependency must satisfy (`"1.2.0"` = `">=1.2.0"`). */
	min_version: z.string().min(1).optional(),
});

export type AppDependency = z.infer<typeof AppDependencySchema>;

/**
 * A single **capability** edge — the layered, provider-agnostic dependency
 * (`requires: [{ capability: "rag" }]`) the capability broker resolves to a
 * concrete provider app at bind time. Mirrors `CapabilityReq` in
 * `crates/ryu-kernel-contracts/src/manifest.rs` (the canonical contract):
 * `{ capability, min_version? }`. Distinct from an `apps` edge (which names a
 * specific plugin id); a `capabilities` edge names an abstract capability and
 * lets the binding registry pick — or the user override — which enabled provider
 * serves it. This is the field the composable `defineAgent` slots lower to.
 */
export const CapabilityReqSchema = z.object({
	/** Capability name (e.g. `"rag"`, `"memory"`, `"tts"`). Matched against a
	 *  provider's `provides[].capability`. */
	capability: z.string().min(1, "capability name is required"),
	/** Optional MINIMUM capability version the bound provider must satisfy
	 *  (`"1.2.0"` = `">=1.2.0"`). Absent = any version. */
	min_version: z.string().min(1).optional(),
});

export type CapabilityReq = z.infer<typeof CapabilityReqSchema>;

/**
 * The `requires` block — this plugin's dependencies. Mirrors `Requires` in
 * `apps/core/src/plugin_manifest/mod.rs`.
 *
 * Core resolves `apps` into a topological enable order (`plugins::graph`):
 * enabling this plugin auto-enables its dependencies first, and disabling a
 * dependency is REFUSED (409) while an enabled dependent still needs it.
 *
 * **Absent = no dependencies** — the backward-compatible default every manifest
 * predating this field carries.
 */
export const RequiresSchema = z.object({
	/** Other plugins that must be installed + enabled before this one enables. */
	apps: z.array(AppDependencySchema).default([]),
	/**
	 * Abstract capability edges the broker resolves to a bound provider at
	 * enable time. Mirrors `Requires::capabilities` in
	 * `crates/ryu-kernel-contracts` — an `apps` edge names a specific plugin; a
	 * `capabilities` edge names a capability and lets the binding registry choose
	 * the provider. Each is lowered to an app-id graph edge once bound, so the
	 * enable/disable/cycle machinery is shared. Empty for the common case.
	 */
	capabilities: z.array(CapabilityReqSchema).default([]),
	/**
	 * Permission grants implied by the dependencies. Declaration only — the
	 * Gateway remains the sole authority on what a grant *allows*, and Core's
	 * dependency graph resolves `apps` only.
	 */
	grants: z.array(z.string()).default([]),
});

export type Requires = z.infer<typeof RequiresSchema>;

// ── Surface (targets) ────────────────────────────────────────────────────────

/**
 * A host surface a plugin can declare support for via `targets`. Mirrors Core's
 * `Surface` enum (`#[serde(rename_all = "kebab-case")]`), so these eight tokens
 * are the exact wire values — also the vocabulary of the `x-ryu-surface` request
 * header Core filters listings on.
 */
export const SurfaceSchema = z.enum([
	/** The Ryu Gateway. */
	"gateway",
	/** A headless Core node (no UI). */
	"core",
	/** The Tauri desktop app. */
	"desktop",
	/** The Electron dynamic-island companion. */
	"island",
	/** The Expo/React-Native mobile app. */
	"mobile",
	/** The browser extension. */
	"extension",
	/** The Next.js web app. */
	"web",
	/** The terminal client. */
	"cli",
]);

export type Surface = z.infer<typeof SurfaceSchema>;

// ── engines (host version floors) ────────────────────────────────────────────

/**
 * The `engines` block: a semver **requirement** per host surface, mirroring
 * VS-Code's `engines.vscode`. Mirrors Core's `EnginesReq`.
 *
 * `ryu` is the Core floor, named that way for backwards compatibility — every
 * manifest written before per-surface floors existed spells it `ryu`, and Core's
 * `EnginesReq::floor_for` maps the `core` surface onto it. The remaining keys are
 * optional floors for the surfaces a plugin actually touches.
 *
 * Values are NOT validated as semver ranges here: Core is the authority and
 * rejects an unparseable requirement at manifest load with a precise message.
 * Duplicating a range parser in the SDK would only create a second, drifting
 * opinion about what `">=1.2, <2"` means.
 */
export const EnginesReqSchema = z.object({
	/** Floor for the terminal (`cli`) surface. */
	cli: z.string().optional(),
	/** Floor for the Tauri desktop app. */
	desktop: z.string().optional(),
	/** Floor for the browser extension. */
	extension: z.string().optional(),
	/** Floor for the Ryu Gateway. */
	gateway: z.string().optional(),
	/** Floor for the dynamic-island companion. */
	island: z.string().optional(),
	/** Floor for the mobile app. */
	mobile: z.string().optional(),
	/** Floor for the running **Core** (e.g. `">=0.3.0"`). Required. */
	ryu: z.string().min(1, "engines.ryu is required when engines is present"),
	/** Floor for the Next.js web app. */
	web: z.string().optional(),
});

export type EnginesReq = z.infer<typeof EnginesReqSchema>;

export const McpServerAuthSchema = z
	.object({
		client_id: z.string().min(1).optional(),
		type: z.literal("oauth"),
	})
	.strict();

export const McpServerDeclSchema = z
	.object({
		args: z.array(z.string()).default([]),
		auth: McpServerAuthSchema.optional(),
		command: z.string().optional(),
		command_env: z.string().optional(),
		description: z.string().optional(),
		enabled: z.boolean().default(true),
		env: z.record(z.string(), z.string()).default({}),
		headers: z.record(z.string(), z.string()).default({}),
		type: z
			.enum(["stdio", "http", "streamable-http", "streamable_http", "sse"])
			.optional(),
		url: z.url().optional(),
	})
	.superRefine((server, context) => {
		if (!(server.command || server.url)) {
			context.addIssue({
				code: "custom",
				message: "an MCP server requires command or url",
			});
		}
		if (!server.auth) {
			return;
		}
		if (server.command || server.type === "stdio" || !server.url) {
			context.addIssue({
				code: "custom",
				message: "OAuth is supported only for remote HTTP MCP servers",
			});
			return;
		}
		if (
			Object.keys(server.headers).some(
				(name) => name.toLowerCase() === "authorization"
			)
		) {
			context.addIssue({
				code: "custom",
				message: "OAuth cannot be combined with a static Authorization header",
			});
		}
		const url = new URL(server.url);
		const loopback =
			url.hostname === "localhost" ||
			url.hostname.startsWith("127.") ||
			url.hostname === "[::1]" ||
			url.hostname === "::1";
		if (url.username || url.password || url.hash) {
			context.addIssue({
				code: "custom",
				message: "OAuth MCP URLs cannot contain credentials or fragments",
			});
		}
		if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
			context.addIssue({
				code: "custom",
				message: "OAuth MCP URLs must use HTTPS except on loopback",
			});
		}
	});

export type McpServerAuth = z.infer<typeof McpServerAuthSchema>;
export type McpServerDecl = z.infer<typeof McpServerDeclSchema>;

// ── PluginManifest ───────────────────────────────────────────────────────────

/**
 * Full schema for a `manifest.json` Plugin manifest. Mirrors `PluginManifest` in
 * `apps/core/src/plugin_manifest/mod.rs`.
 *
 * Validation rules (matching Core's `PluginManifestLoader`):
 * - `id` must be non-empty
 * - `version` must be a valid semver string (MAJOR.MINOR.PATCH)
 * - `runnables` may be empty for a "surface-only" plugin, but each entry must be
 *   a valid `RunnableMeta`
 */
export const PluginManifestSchema = z
	.object({
		/** Reverse-domain unique identifier (e.g. `"com.example.my-plugin"`). */
		id: z.string().min(1, "id is required"),

		/** Human-readable display name shown in the plugin store / launcher. */
		name: z.string().min(1, "name is required"),

		/**
		 * Semver version string (e.g. `"1.0.0"`). Core's loader rejects any manifest
		 * whose version is not valid semver; the regex here enforces the same rule at
		 * SDK-build time.
		 */
		version: z
			.string()
			.regex(
				/^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/,
				"version must be a valid semver string (e.g. 1.0.0)"
			),

		/** Core-owned release maturity metadata. The Rust contract validates the
		 *  richer shape; the SDK authoring parser must preserve it for pack/publish. */
		stability: z.unknown().optional(),

		/**
		 * Lower-case hex `sha256(utf8_bytes(ui_code))` binding the plugin's bundled
		 * sandboxed-UI code to this manifest. `ryu pack` / `ryu publish` compute it and
		 * write it here BEFORE the manifest is signed, so the hash rides INSIDE the
		 * Gateway-signed surface while the `ui_code` blob rides OUTSIDE it as payload;
		 * Core's install path recomputes the hash over the fetched code and rejects a
		 * mismatch fail-closed. Absent for a manifest-only plugin (no bundled UI).
		 * Mirrors Core's `PluginManifest.ui_code_sha256`.
		 */
		ui_code_sha256: z.string().nullish(),

		/** The Runnables this plugin bundles. */
		runnables: z.array(RunnableMetaSchema).default([]),

		/**
		 * Permission grants this plugin declares it needs (e.g. `"mcp:web_search"`).
		 * Declarations only — grant enforcement is the Gateway's responsibility.
		 */
		permission_grants: z.array(z.string()).default([]),

		/** Deny-by-default sandbox permissions. Core remains authoritative; this
		 *  schema mirrors the fields so `ryu pack` cannot strip them. */
		permissions: z
			.object({
				fs: z
					.object({
						read: z.array(z.string()).default([]),
						write: z.array(z.string()).default([]),
					})
					.optional(),
				child_process: z.boolean().optional(),
				run: z.array(z.string()).default([]),
				network: z.union([z.boolean(), z.array(z.string())]).optional(),
				tool: z.array(z.string()).default([]),
			})
			.optional(),

		/** Core-owned permission presentation levels. Preserved verbatim here and
		 *  validated by Core's authoritative manifest contract. */
		permission_levels: z.unknown().optional(),

		/** Remote or stdio MCP servers registered by this plugin. */
		mcp_servers: z.record(z.string(), McpServerDeclSchema).optional(),

		/** Core-owned sidecar declarations. Their full process/HTTP schema stays in
		 *  the Rust contract; this authoring layer must never strip them. */
		sidecars: z.unknown().optional(),

		/**
		 * Optional Companion surface (an in-desktop overlay or sidebar panel).
		 * Absent when the plugin has no Companion surface.
		 */
		companion: CompanionSurfaceSchema.optional(),

		/**
		 * VS-Code-style activation events (`"*"`, `"onStartup"`, `"onChat"`,
		 * `"onCommand:<id>"`). Empty = eager. Turn-hook plugins are driven by their
		 * enabled flag, so `["*"]` is the usual value.
		 */
		activation_events: z.array(z.string()).default([]),

		/**
		 * Contribution points: server-side turn hooks + declarative UI widgets.
		 * Absent for a plugin that contributes nothing here.
		 */
		contributes: ContributesSchema.optional(),

		/**
		 * **Plugin-to-plugin dependencies** — the other plugins this one needs. Core
		 * resolves them into a topological enable order (dependencies enable first;
		 * disabling one is refused while an enabled dependent needs it).
		 *
		 * Absent = **no dependencies**, the backward-compatible default. Kept
		 * `.optional()` (never defaulted) so a manifest that declares none serialises
		 * with no `requires` key at all, exactly like Core's
		 * `#[serde(skip_serializing_if = "Option::is_none")]`.
		 */
		requires: RequiresSchema.optional(),

		/**
		 * Host surfaces this plugin runs on. **Empty or absent = runs on EVERY
		 * surface** — the backward-compatible default, which must never be read as
		 * "runs nowhere". Core filters only when the list is explicitly non-empty, and
		 * only at the read boundary (`GET /api/plugins`, keyed on `x-ryu-surface`), so
		 * an unsupported-target plugin stays installable and inspectable.
		 */
		targets: z.array(SurfaceSchema).default([]),

		/** Rich per-surface declarations (`support`, UI, contributed commands, …).
		 *  Core owns and validates the nested vocabulary. */
		surfaces: z.unknown().optional(),

		/**
		 * Host version floors — the semver requirement each surface must satisfy for
		 * this plugin to install. Mirrors Core's `EnginesReq`
		 * (`crates/core/kernel-contracts/src/manifest.rs`).
		 *
		 * `ryu` is the **Core** floor and the only required key (it is the legacy
		 * spelling; every manifest in the wild carries just that one). The rest are
		 * optional per-surface floors.
		 *
		 * REGRESSION THIS FIXES: `engines` was absent from this schema entirely, and
		 * zod strips unlisted keys — so `ryu pack` silently dropped the whole block
		 * from every bundle it produced. A plugin could declare a Core floor, publish,
		 * and ship a bundle that declared none. Any new host floor MUST be added here
		 * as well as in the Rust contract, or it does not survive packing.
		 */
		engines: EnginesReqSchema.optional(),

		/**
		 * Optional per-item AFFILIATE terms: the commission paid to a referrer when a
		 * referred user buys this (paid) item. `value` is basis points for `percent`
		 * (2000 = 20%) or minor units (cents) for `flat`. Absent (or `enabled:false`)
		 * falls back to the seller org owner's default affiliate terms. This is the
		 * authoring surface for the marketplace publish body's `affiliate` field (the
		 * server re-validates it); it only takes effect on a paid item.
		 */
		affiliate: z
			.object({
				enabled: z.boolean().default(false),
				rule: z
					.object({
						type: z.enum(["percent", "flat"]),
						value: z.number().nonnegative(),
						recurring: z.boolean().default(false),
						durationMonths: z.number().int().positive().nullish(),
						fundedBy: z.enum(["platform", "seller"]).default("platform"),
					})
					.optional(),
			})
			.optional(),

		// ── Rich listing metadata (Phase 1.5) ──────────────────────────────────────
		// Optional store-listing fields a plugin author declares so the marketplace
		// detail dialog renders a richer App-Store-style preview. Field names align
		// with the Claude `.claude-plugin/marketplace.json` plugin-entry standard where
		// one exists (`author`, `homepage`, `keywords`, `category`, `license`); the
		// rest are Ryu extensions. `ryu publish` forwards these FLAT into the publish
		// body (not inside the signed manifest blob) so the control plane stores them.
		// All optional + additive: a manifest omitting them still validates.

		/** Longer plain/markdown description shown in the detail dialog. */
		description: z.string().optional(),
		/** Short one-line pitch shown under the name (Ryu extension). */
		tagline: z.string().optional(),
		/**
		 * Publisher identity. A bare string OR a Claude-style object; `ryu publish`
		 * resolves it to the display `developer` (`author.name` when an object).
		 */
		author: z
			.union([
				z.string(),
				z.object({
					name: z.string(),
					email: z.string().optional(),
					url: z.string().optional(),
				}),
			])
			.optional(),
		/** Public source repository URL (Claude/Codex `repository`). */
		repository: z.string().url().optional(),
		/** True when the provider operates outside the local Ryu runtime. */
		external: z.boolean().optional(),
		/** Project/marketing homepage — maps to the listing `website` (Claude field). */
		homepage: z.string().optional(),
		/** Free-text search keywords (Claude field). */
		keywords: z.array(z.string()).optional(),
		/** Stable Marketplace filter labels (Ryu extension). */
		tags: z.array(z.string()).optional(),
		/** Taxonomy category beyond the runnable kinds (Claude field). */
		category: z.string().optional(),
		/** SPDX-ish license identifier (Claude field). */
		license: z.string().optional(),
		/** Square logo/icon URL for the listing card + detail header. */
		iconUrl: z.string().optional(),
		/**
		 * Icon-primitive id for the listing card (Ryu extension): an Iconify/icons0
		 * `prefix:name`, a bare Hugeicons name, or a URL, resolved by the shared `Icon`
		 * primitive. A monochrome GLYPH masked with the current text colour — distinct
		 * from `iconUrl` (a raster logo). Falls back to `iconUrl` when omitted.
		 */
		icon: z.string().optional(),
		/** Optional detail-page hero banner metadata forwarded to the marketplace. */
		banner: z.record(z.string(), z.unknown()).optional(),
		/**
		 * Dithered-gradient background for the card's icon square (Ryu extension),
		 * mirroring dither-kit's `DitherGradient` props. `from`/`to` are a palette-colour
		 * name (`green`, `blue`, `purple`, `pink`, `orange`, `red`, `grey`) or a hue
		 * number (0–360); `direction` is where `to` ends up. Renders behind the glyph in
		 * place of a flat `iconBackground`; the render layer validates + falls back.
		 */
		iconDither: z
			.object({
				from: z.union([z.string(), z.number()]),
				to: z.union([z.string(), z.number()]).optional(),
				direction: z.enum(["up", "down", "left", "right"]).optional(),
			})
			.optional(),
		/** Ordered App-Store-style screenshot gallery URLs (Ryu extension). */
		screenshots: z.array(z.string()).optional(),
		/** Privacy policy URL surfaced on detail (Ryu extension). */
		privacyPolicyUrl: z.string().optional(),
		/** Terms-of-service URL surfaced on detail (Ryu extension). */
		termsOfServiceUrl: z.string().optional(),
		/**
		 * Human-readable capability strings (Ryu extension). When omitted the control
		 * plane derives a default from `permission_grants`, so declaring this is only
		 * needed to override the derived labels.
		 */
		capabilities: z.array(z.string()).optional(),
		/** Example prompt chips shown on detail (Ryu extension). */
		examplePrompts: z.array(z.string()).optional(),
		/**
		 * Optional companion/config card (Ryu extension): a single setup step or an
		 * array of steps guiding the user through post-install configuration.
		 */
		setup: z.union([SetupStepSchema, z.array(SetupStepSchema)]).optional(),
	})
	// Core's Rust-derived schema is the full wire authority. Keep this deliberately
	// forward-compatible so a newly-added Core field survives SDK pack/publish even
	// before the simpler authoring schema grows first-class validation for it.
	.passthrough()
	.superRefine((manifest, context) => {
		const hasOAuthServer = Object.values(manifest.mcp_servers ?? {}).some(
			(server) => server.auth?.type === "oauth"
		);
		if (!hasOAuthServer) {
			return;
		}
		for (const grant of ["mcp:server", "identity.read"] as const) {
			if (!manifest.permission_grants.includes(grant)) {
				context.addIssue({
					code: "custom",
					message: `OAuth MCP servers require the ${grant} permission grant`,
					path: ["permission_grants"],
				});
			}
		}
	});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

// ── Rust-cored validation helpers (via @ryuhq/sdk-native) ───────────────────────
//
// These delegate to the `crates/ryu-sdk` Rust core through the native addon, so
// they apply the *exact same* rules Core enforces on load. Note: Core's manifest
// model uses richer per-kind `RunnableEntry` configs, while the zod
// `PluginManifestSchema` above models the SDK's simpler authoring shape
// (runnables = identity metadata only). Until those shapes are reconciled
// (follow-up), use the zod schema for SDK authoring and these helpers when you
// need Core-strict validation of a full `manifest.json`.

/**
 * Validate a plugin id with Core's strict reverse-domain, path-traversal-safe
 * rules. Throws a descriptive `Error` when invalid.
 */
export function validatePluginId(id: string): void {
	loadNative().validatePluginId(id);
}

/**
 * Validate a full `manifest.json` string against Core's authoritative rules
 * (id, semver, per-kind runnable config contracts). Returns the normalized
 * manifest JSON string, or throws.
 */
export function validateManifestStrict(manifestJson: string): string {
	return loadNative().parseAndValidateManifest(manifestJson);
}

/**
 * The Core-derived JSON Schema for a `manifest.json`, as a parsed object. Stays in
 * lockstep with the Rust types because it is emitted from them.
 */
export function coreManifestJsonSchema(): unknown {
	return JSON.parse(loadNative().pluginManifestJsonSchema());
}
