/**
 * defineAgent — factory for Runnable agents.
 *
 * An agent is a Runnable that drives a multi-turn model loop. It may reference a
 * workflow as a named tool by including a Runnable with kind="workflow" in its
 * `tools` list; the agent's run() implementation calls it like any other tool.
 *
 * All model calls must go through `ctx.gateway` — no direct provider imports.
 *
 * ## Composable primitive slots (the "Pokémon card" model, program §6b)
 *
 * `defineAgent` additionally accepts swappable-provider SLOTS —
 * `defineAgent({ chat, rag, memory, tools, tts, stt })` — where each slot picks
 * a provider for one attribute of the card. They **lower** to the manifest:
 *   - `chat`  → the agent `RunnableMeta.config` (model / engine / persona);
 *   - `rag` / `memory` / `tts` / `stt` → `requires.capabilities` edges the
 *     capability broker binds to a provider (with an optional explicit override);
 *   - `tools` → the tool ids the agent exposes.
 *
 * The slots are ADDITIVE: the classic `defineAgent({ id, name, run })` signature
 * is unchanged. When `run` is omitted, a thin default run drives the `chat` slot
 * through `ctx.gateway` (never a direct provider).
 */

import { z } from "zod";
import type {
	CapabilityReq,
	PluginManifest,
	RunnableMeta,
} from "../manifest.ts";
import { PluginManifestSchema } from "../manifest.ts";
import type {
	PrimitiveJsonValue,
	PrimitiveRequestInput,
} from "./primitive-contracts.ts";
import type { Runnable, RunnableContext } from "./runnable-types.ts";

/**
 * A capability-backed slot (rag / memory / tts / stt). Written as:
 *   - `true` — require the capability; the broker/registry picks the provider;
 *   - `"com.acme.graphrag"` — bind this explicit provider app id;
 *   - `{ provider?, minVersion? }` — provider override and/or a version floor.
 */
export type CapabilitySlot =
	| boolean
	| string
	| { provider?: string; minVersion?: string };

/**
 * The chat/model slot — the agent's own, swappable model config. Written as a
 * model-id string shorthand or the full object. Every field is a `string`; no
 * provider union, so a new provider never needs an SDK change.
 */
export type ChatSlot =
	| string
	| {
			/** Model id (swappable). */
			model?: string;
			/** Engine id (e.g. `"llamacpp"`, `"openai-compat"`). */
			engine?: string;
			/** System persona / instructions. */
			persona?: string;
			/** Preference key Core resolves to a model id (swappable, not hardcoded). */
			modelPrefKey?: string;
	  };

/** The composable slots an agent card declares. All optional. */
export interface AgentSlots {
	/** The chat/model slot (model + engine + persona). */
	chat?: ChatSlot;
	/** Memory provider slot → `requires.capabilities: [{ capability: "memory" }]`. */
	memory?: CapabilitySlot;
	/** RAG provider slot → `requires.capabilities: [{ capability: "rag" }]`. */
	rag?: CapabilitySlot;
	/** STT provider slot → `requires.capabilities: [{ capability: "stt" }]`. */
	stt?: CapabilitySlot;
	/** Tools the agent exposes — Runnables (workflows/tools) or bare tool ids. */
	tools?: readonly (Runnable | string)[];
	/** TTS provider slot → `requires.capabilities: [{ capability: "tts" }]`. */
	tts?: CapabilitySlot;
}

/**
 * Whose accounts the agent works with when Ryu creates it from the manifest:
 *   - `"managed"` — acts as the user, with the accounts they connected (the
 *     default when omitted);
 *   - `"individual"` — its own identity and accounts, never the user's;
 *   - `"mixed"` — its own accounts, plus the user's accounts they allow.
 *
 * Which accounts it may use is never part of the manifest: the user chooses
 * that on their own node.
 */
export type AgentIdentityMode = "managed" | "individual" | "mixed";

const AGENT_IDENTITY_MODES = ["managed", "individual", "mixed"] as const;

/** Options accepted by `defineAgent`. */
export interface AgentOptions<TInput, TOutput> extends AgentSlots {
	/** Stable unique identifier (e.g. "agent-researcher"). */
	id: string;
	/** How the agent works; lowers to `config.identity_mode`. */
	identityMode?: AgentIdentityMode;
	/** Human-readable display name. */
	name: string;
	/**
	 * The agent's run implementation. OPTIONAL when slots are declared — a
	 * `chat`-slot default is synthesized (drives `ctx.gateway`). All model calls
	 * MUST go through `ctx.gateway`.
	 */
	run?(input: TInput, ctx: RunnableContext): Promise<TOutput>;
}

/**
 * The lowered "card": the swappable slots resolved to manifest-ready pieces —
 * the persona/model config plus the `requires.capabilities` edges. This is what
 * makes the Pokémon-card model literal in code.
 */
export interface AgentCard {
	/** Lowered capability edges for `requires.capabilities`. */
	capabilities: CapabilityReq[];
	/** Engine id from the `chat` slot. */
	engine?: string;
	/** Declared identity mode (omitted: Ryu's default, `"managed"`). */
	identityMode?: AgentIdentityMode;
	/** Model id from the `chat` slot. */
	model?: string;
	/** Preference key from the `chat` slot. */
	modelPrefKey?: string;
	/** Persona/instructions from the `chat` slot. */
	persona?: string;
	/** Explicit provider bindings by capability (a slot that named a provider). */
	providers: Record<string, string>;
	/** Tool ids the agent exposes. */
	tools: string[];
}

/** A defined agent: a Runnable plus its lowered card + a manifest lowering. */
export interface AgentRunnable<TInput = unknown, TOutput = unknown>
	extends Runnable<TInput, TOutput> {
	/** The lowered slot card (empty edges when no slots were declared). */
	readonly card: AgentCard;
	/**
	 * Lower this agent (card + run identity) to a single-agent `manifest.json`
	 * `PluginManifest`: the agent `RunnableMeta` carries the persona/model
	 * config; `requires.capabilities` carries the slot edges. Throws if the
	 * assembled manifest is invalid.
	 */
	toManifest(options: AgentManifestOptions): PluginManifest;
}

/** Options for {@link AgentRunnable.toManifest}. */
export interface AgentManifestOptions {
	/** Extra permission grants beyond those implied by slots. */
	grants?: string[];
	/** Reverse-domain plugin id (e.g. `"com.acme.researcher"`). */
	id: string;
	/** Display name (defaults to the agent's name). */
	name?: string;
	/** Semver version (e.g. `"1.0.0"`). */
	version: string;
}

const CAPABILITY_SLOTS = ["rag", "memory", "tts", "stt"] as const;

/** Normalize a chat slot to the card's model fields. */
function lowerChatSlot(
	chat: ChatSlot | undefined
): Pick<AgentCard, "model" | "engine" | "persona" | "modelPrefKey"> {
	if (chat === undefined) {
		return {};
	}
	const model = z.string().safeParse(chat);
	if (model.success) {
		return { model: model.data };
	}
	const config = z
		.object({
			model: z.string().optional(),
			engine: z.string().optional(),
			persona: z.string().optional(),
			modelPrefKey: z.string().optional(),
		})
		.parse(chat);
	return {
		model: config.model,
		engine: config.engine,
		persona: config.persona,
		modelPrefKey: config.modelPrefKey,
	};
}

/** Lower one capability slot to an edge + optional provider override. */
function lowerCapabilitySlot(
	capability: string,
	slot: CapabilitySlot | undefined,
	card: AgentCard
): void {
	if (slot === undefined || slot === false) {
		return;
	}
	if (slot === true) {
		card.capabilities.push({ capability });
		return;
	}
	const provider = z.string().safeParse(slot);
	if (provider.success) {
		card.capabilities.push({ capability });
		card.providers[capability] = provider.data;
		return;
	}
	const config = z
		.object({
			provider: z.string().optional(),
			minVersion: z.string().optional(),
		})
		.parse(slot);
	card.capabilities.push(
		config.minVersion
			? { capability, min_version: config.minVersion }
			: { capability }
	);
	if (config.provider) {
		card.providers[capability] = config.provider;
	}
}

/** Build the lowered {@link AgentCard} from an agent's slots. */
function lowerSlots(options: AgentSlots): AgentCard {
	const card: AgentCard = {
		...lowerChatSlot(options.chat),
		capabilities: [],
		providers: {},
		tools: [],
	};
	for (const capability of CAPABILITY_SLOTS) {
		lowerCapabilitySlot(capability, options[capability], card);
	}
	for (const t of options.tools ?? []) {
		const reference = z.string().safeParse(t);
		card.tools.push(
			reference.success
				? reference.data
				: z.object({ id: z.string() }).parse(t).id
		);
	}
	return card;
}

/** Synthesize a default run that drives the `chat` slot through `ctx.gateway`. */
function defaultRun(card: AgentCard) {
	return async (
		input: PrimitiveRequestInput,
		ctx: RunnableContext
	): Promise<string> => {
		const text = z.string().safeParse(input);
		const content = text.success ? text.data : JSON.stringify(input ?? "");
		const messages = card.persona
			? [
					{ role: "system" as const, content: card.persona },
					{ role: "user" as const, content },
				]
			: [{ role: "user" as const, content }];
		const result = await ctx.gateway.chat(messages);
		return result.content;
	};
}

/** The manifest `config` block a card lowers to (kept opaque by Core). */
interface AgentCardConfig {
	capability_providers?: AgentCard["providers"];
	engine?: AgentCard["engine"];
	identity_mode?: AgentCard["identityMode"];
	model?: AgentCard["model"];
	model_pref_key?: AgentCard["modelPrefKey"];
	persona?: AgentCard["persona"];
	tools?: AgentCard["tools"];
	[key: string]: PrimitiveJsonValue | undefined;
}
function cardConfig(card: AgentCard): AgentCardConfig {
	const config: AgentCardConfig = {};
	if (card.model) {
		config.model = card.model;
	}
	if (card.engine) {
		config.engine = card.engine;
	}
	if (card.identityMode) {
		config.identity_mode = card.identityMode;
	}
	if (card.persona) {
		config.persona = card.persona;
	}
	if (card.modelPrefKey) {
		config.model_pref_key = card.modelPrefKey;
	}
	if (Object.keys(card.providers).length > 0) {
		config.capability_providers = card.providers;
	}
	if (card.tools.length > 0) {
		config.tools = card.tools;
	}
	return config;
}

/** Lower an agent to a single-agent `manifest.json` `PluginManifest`. */
function agentToManifest(
	agent: Runnable & { card: AgentCard },
	options: AgentManifestOptions
): PluginManifest {
	const config = cardConfig(agent.card);
	const meta: RunnableMeta = {
		id: agent.id,
		name: agent.name,
		kind: "agent",
	};
	if (Object.keys(config).length > 0) {
		meta.config = config;
	}
	const hasRequires =
		agent.card.capabilities.length > 0 || (options.grants?.length ?? 0) > 0;
	const raw: Pick<PluginManifest, "id" | "name" | "version" | "runnables"> &
		Partial<Pick<PluginManifest, "requires">> = {
		id: options.id,
		name: options.name ?? agent.name,
		version: options.version,
		runnables: [meta],
	};
	if (hasRequires) {
		raw.requires = {
			apps: [],
			capabilities: agent.card.capabilities,
			grants: options.grants ?? [],
		};
	}
	const result = PluginManifestSchema.safeParse(raw);
	if (!result.success) {
		const first = result.error.issues[0];
		const field = first?.path.join(".") ?? "unknown";
		const message = first?.message ?? "validation failed";
		throw new Error(
			`agent manifest validation failed at '${field}': ${message}`
		);
	}
	return result.data;
}

/**
 * Create a Runnable agent.
 *
 * The returned value satisfies `Runnable<TInput, TOutput>` with `kind = "agent"`
 * and additionally exposes the lowered {@link AgentCard} + a `toManifest()`
 * lowering, so a slot-composed agent round-trips to a valid `manifest.json`.
 *
 * @example Classic (unchanged, back-compat):
 * ```ts
 * const a = defineAgent({
 *   id: "agent-researcher",
 *   name: "Researcher",
 *   async run({ query }, ctx) {
 *     const r = await ctx.gateway.chat([{ role: "user", content: query }]);
 *     return { answer: r.content };
 *   },
 * });
 * ```
 *
 * @example Composable slots (the Pokémon card):
 * ```ts
 * const cmo = defineAgent({
 *   id: "agent-cmo",
 *   name: "CMO",
 *   chat: { model: "gpt-4o", persona: "You are a CMO." },
 *   rag: true,                    // requires.capabilities: [{ capability: "rag" }]
 *   memory: { minVersion: "1.2" },
 *   tts: "com.acme.elevenlabs",   // explicit provider override
 * });
 * const manifest = cmo.toManifest({ id: "com.acme.cmo", version: "1.0.0" });
 * ```
 */
export function defineAgent<TInput = unknown, TOutput = unknown>(
	options: AgentOptions<TInput, TOutput> &
		Required<Pick<AgentOptions<TInput, TOutput>, "run">>
): AgentRunnable<TInput, TOutput>;
export function defineAgent(
	options: Omit<AgentOptions<PrimitiveRequestInput, string>, "run"> & {
		run?: undefined;
	}
): AgentRunnable<PrimitiveRequestInput, string>;
export function defineAgent<TInput = unknown, TOutput = unknown>(
	options: AgentOptions<TInput, TOutput>
): AgentRunnable<TInput, TOutput | string>;
export function defineAgent<TInput, TOutput>(
	options: AgentOptions<TInput, TOutput>
) {
	const { id, name } = options;
	const card = lowerSlots(options);
	if (options.identityMode !== undefined) {
		// Checked at runtime too: an unknown mode must fail here, not be dropped
		// and leave Ryu to create the agent acting as the user.
		card.identityMode = z
			.enum(AGENT_IDENTITY_MODES)
			.parse(options.identityMode);
	}
	const run = options.run ?? defaultRun(card);
	return {
		id,
		name,
		kind: "agent" as const,
		run,
		card,
		toManifest(manifestOptions: AgentManifestOptions): PluginManifest {
			return agentToManifest(this, manifestOptions);
		},
	};
}
