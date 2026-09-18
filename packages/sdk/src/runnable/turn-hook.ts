/**
 * Turn-hook + plugin authoring factories.
 *
 * A turn hook is plugin-authored logic that runs after each assistant turn in
 * Ryu's Core plugin sandbox (`apps/core/src/plugin_host/`). The hook reaches Core
 * only through capability-gated `host` functions and returns a directive. This is
 * what makes features like double-check and goal real, installable plugins.
 *
 * `defineTurnHook` serializes your typed `run(ctx, host)` function to the `code`
 * string the sandbox executes. `defineFunctionHook` adds the Ryu-native,
 * middleware-shaped variant: `run(ctx, host, next)` can short-circuit, pass a
 * rewritten context downstream, or inspect the downstream directive. Both forms
 * remain self-contained sandbox bodies — they cannot capture outer variables,
 * imports, or closures.
 */

import type {
	HookEventContribution,
	PluginManifest,
	RunnableMeta,
	SlashCommandContribution,
	Surface,
	TurnHookContribution,
} from "../manifest.ts";
import { ContributesSchema } from "../manifest.ts";
import type { DefineAppRequires } from "./app.ts";
import { inlineToolRunnable, type ToolRunnable } from "./tool.ts";

/** The context a hook receives. Fields not relevant to its phase are omitted. */
export interface HookContext {
	/** The normalized action for an `action` hook. */
	action?: {
		id: string;
		input?: unknown;
		kind: string;
		name: string;
		sequence: number;
		status: string;
	};
	/** The agent that produced the turn. */
	agent_id?: string;
	/** The conversation id (also the natural per-conversation storage key). */
	conversation_id?: string;
	/** The context records about to be dropped by compaction. */
	dropped?: Array<{ role: string; content: string }>;
	/** The event payload for observation and app-event hooks. */
	event?: unknown;
	/** Per-request plugin flags (e.g. a composer toggle): `{ "<pluginId>": true }`. */
	flags: Record<string, boolean>;
	/** The pending user message for `pre_user_turn` or flattened ACP context. */
	input?: string;
	/** The raw outbound message array on the message-array `context` plane. */
	messages?: unknown[];
	/** The final sub-agent output for `subagent_stop`. */
	output?: string;
	/** The exact project instruction block assembled for a context hook. */
	project_instructions?: string;
	/** Normalized project rule records assembled for a context hook. */
	project_rules?: unknown[];
	/** The tool arguments supplied to a tool hook. */
	tool_input?: unknown;
	/** The tool being called by a tool hook. */
	tool_name?: string;
	/** The tool result supplied to a `tool_result` or `post_tool_use` hook. */
	tool_output?: unknown;
	/** Recent transcript (oldest → newest). */
	transcript: Array<{ role: string; content: string }>;
}

/** Arguments to a `host.sideModel` call. */
export interface SideModelArgs {
	/** Reasoning effort, forwarded when non-empty. */
	effort?: string;
	/** Explicit model id (wins over `model_pref_key`). */
	model?: string;
	/** A preference key Core resolves to a model id (swappable, not hardcoded). */
	model_pref_key?: string;
	/** The user prompt for the side model. Required. */
	prompt: string;
	/** Optional system prompt. */
	system?: string;
}

/** The capability bridge available to a hook (gated by manifest grants). */
export interface HostApi {
	/** Captured logging. */
	log(...args: unknown[]): void;
	/** One non-streaming gateway completion. Grant: `hook:side-model`. */
	sideModel(args: SideModelArgs): Promise<string>;
	/** The plugin's own namespaced KV store. Grant: `storage:kv`. */
	storage: {
		get(key: string): Promise<string | null>;
		set(key: string, value: unknown): Promise<boolean>;
		delete(key: string): Promise<boolean>;
		keys(): Promise<string[]>;
	};
}

/** What a hook asks the chat path to do after the assistant turn. */
export type HookDirective =
	| { kind: "none" }
	| { kind: "note"; text: string }
	| { kind: "continue"; text: string }
	| { kind: "tool_approval"; question: string; summary: string }
	| { kind: "replace"; text: string; fresh_session?: boolean }
	| { kind: "inject"; text: string }
	| { kind: "deny"; reason: string }
	| { kind: "transform"; output: unknown }
	| { kind: "rewrite"; messages: unknown[] }
	| { kind: "handled"; text: string }
	| {
			kind: "select_model";
			model: string;
			effort?: string;
			acp_config?: Record<string, string>;
			reason?: string;
	  };

/** A typed hook implementation: `(ctx, host) => directive`. */
export type HookRun = (
	ctx: Readonly<HookContext>,
	host: HostApi
) => HookDirective | Promise<HookDirective>;

/** The continuation passed to a middleware-style function hook. */
export type HookNext = (ctx?: Readonly<HookContext>) => Promise<HookDirective>;

/** A typed middleware hook implementation: `(ctx, host, next) => directive`. */
export type FunctionHookRun = (
	ctx: Readonly<HookContext>,
	host: HostApi,
	next: HookNext
) => HookDirective | Promise<HookDirective>;

/** The cheap, declarative gate evaluated before Core starts the sandbox. */
export interface HookMatch {
	commands?: string[];
	flag?: string;
	stateful?: boolean;
	tools?: string[];
}

interface DefineHookOptions {
	/** Stable id for this hook, unique within the plugin. */
	id: string;
	/** Skip the sandbox when this phase clearly cannot match. */
	match?: HookMatch;
	/** Turn boundary (default `"post_assistant_turn"`). */
	on?: string;
	/** Higher-priority hooks run first within a phase. */
	priority?: number;
}

export interface DefineTurnHookOptions extends DefineHookOptions {
	/** The hook body. Must be self-contained (no captured variables). */
	run: HookRun;
}

export interface DefineFunctionHookOptions extends DefineHookOptions {
	/** The middleware body. Must be self-contained (no captured variables). */
	run: FunctionHookRun;
}

function hookMetadata(options: DefineHookOptions) {
	const match = options.match
		? {
				commands: options.match.commands ?? [],
				stateful: options.match.stateful ?? false,
				tools: options.match.tools ?? [],
				...(options.match.flag === undefined
					? {}
					: { flag: options.match.flag }),
			}
		: undefined;
	return {
		id: options.id,
		on: options.on ?? "post_assistant_turn",
		...(options.priority === undefined ? {} : { priority: options.priority }),
		...(match === undefined ? {} : { match }),
	};
}

/**
 * Build a turn-hook contribution from a typed `run` function. The function source
 * is serialized into the sandbox `code` string and invoked with `ctx`/`host` at
 * run time.
 */
// `code` is optional on `TurnHookContribution` because a hand-authored manifest may
// carry `code_file` instead. This builder always produces the inline form, so it
// narrows the return type — callers get a `code` they need not null-check.
export function defineTurnHook(
	options: DefineTurnHookOptions
): TurnHookContribution & { code: string } {
	const source = options.run.toString();
	// The sandbox wraps `code` in an async IIFE where `ctx`/`host` are in scope
	// and a bare `return` reports the directive — so call the serialized function
	// with them and return its result.
	const code = `return await (${source})(ctx, host);`;
	return {
		...hookMetadata(options),
		code,
	};
}

/**
 * Build an opt-in middleware hook. Core invokes middleware hooks in priority
 * order and passes a `next(ctx)` continuation that reaches the remaining hooks.
 * The continuation is sandbox-mediated, so a plugin never receives another
 * plugin's host capabilities or code.
 */
export function defineFunctionHook(
	options: DefineFunctionHookOptions
): TurnHookContribution & { code: string; mode: "middleware" } {
	const source = options.run.toString();
	const code = `return await (${source})(ctx, host, next);`;
	return {
		...hookMetadata(options),
		mode: "middleware",
		code,
	};
}

export interface DefinePluginOptions {
	/** Activation events (default `["*"]` — driven by the enabled flag). */
	activationEvents?: string[];
	/** Declarative composer widgets (toggle/chip), passed verbatim to the desktop. */
	composerControls?: Record<string, unknown>[];
	/** Capability grants the hooks need (e.g. `["hook:side-model", "storage:kv"]`). */
	grants?: string[];
	/**
	 * App events this plugin EMITS — the provider half of the hook system whose
	 * consumer half is {@link DefinePluginOptions.turnHooks}. Each `id` must be
	 * namespaced to this plugin's own `id`; Core validates that at load and again
	 * on every emit.
	 */
	hookEvents?: HookEventContribution[];
	/** Reverse-domain id (e.g. `"com.example.my-plugin"`). */
	id: string;
	/**
	 * Language servers the plugin declares, keyed by server name — the same shape
	 * as Claude Code's `lspServers` / `.lsp.json`, passed verbatim. Loose records
	 * rather than a typed entry on purpose: Claude Code owns this field
	 * vocabulary, so typing it here would strip a field from a newer Claude
	 * release on its way through `ryu pack`. Core types it, because Core acts on
	 * it.
	 */
	lspServers?: Record<string, Record<string, unknown>>;
	/** Display name. */
	name: string;
	/**
	 * Plugin-to-plugin dependencies. Core auto-enables them (in dependency order)
	 * before this plugin, and refuses to disable one while this plugin needs it.
	 * Omit for the common case — the key is then absent from the emitted manifest.
	 */
	requires?: DefineAppRequires;
	/** Declarative settings tabs (model pickers, fields), passed verbatim. */
	settingsTabs?: Record<string, unknown>[];
	/** Declarative slash commands, including sequential argument choices. */
	slashCommands?: SlashCommandContribution[];
	/**
	 * Host surfaces this plugin runs on. **Omitted/empty = every surface** (the
	 * backward-compatible default); it never means "hidden".
	 */
	targets?: Surface[];
	/**
	 * Inline tools the plugin ships — each a {@link ToolRunnable} from `defineTool`
	 * whose `run` body is bundled as Core's `inline_deno` backend (registered as
	 * `app.<tool.id>`). Shipping any tool auto-adds the `tool:execute` grant.
	 */
	tools?: ToolRunnable[];
	/** Turn hooks the plugin contributes. */
	turnHooks?: TurnHookContribution[];
	/** Semver version (e.g. `"1.0.0"`). */
	version: string;
}

/**
 * Assemble a `manifest.json` manifest for a turn-hook plugin. The result matches
 * Core's `PluginManifest` serde shape and can be written to disk or validated via
 * `validateManifestStrict`.
 */
export function definePlugin(options: DefinePluginOptions): PluginManifest {
	const contributes = ContributesSchema.parse({
		turn_hooks: options.turnHooks ?? [],
		hook_events: options.hookEvents ?? [],
		composer_controls: options.composerControls ?? [],
		settings_tabs: options.settingsTabs ?? [],
		slash_commands: options.slashCommands ?? [],
		lsp_servers: options.lspServers ?? {},
	});
	// Ship each inline tool as a `kind:"tool"` runnable (Core's `inline_deno`
	// backend). Shipping tools requires the `tool:execute` grant; add it once.
	const tools = options.tools ?? [];
	const runnables: RunnableMeta[] = tools.map((t) => inlineToolRunnable(t));
	const grants = new Set(options.grants ?? []);
	if (tools.length > 0) {
		grants.add("tool:execute");
	}
	return {
		id: options.id,
		name: options.name,
		version: options.version,
		runnables,
		permission_grants: [...grants],
		activation_events: options.activationEvents ?? ["*"],
		contributes,
		// Empty = EVERY surface (Core's backward-compatible default), never "hidden".
		targets: options.targets ?? [],
		// Absent (not `{apps:[],grants:[]}`) when undeclared, matching Core's
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
}
