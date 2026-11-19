/**
 * defineTool — factory for Runnable tools.
 *
 * A tool is a stateless function invoked by an agent or workflow step.
 * Its input schema is either:
 *
 *  - a **typed schema**: any Standard Schema validator (zod 4, valibot,
 *    arktype, …). `run()`'s argument type is inferred from it, input is parsed
 *    by it (defaults/transforms applied), and it is converted to JSON Schema for
 *    the wire; or
 *  - a hand-written JSON Schema `ToolSchema`, checked shallowly (required keys,
 *    top-level property types) as before.
 *
 * Either way the exposed `schema` is a JSON Schema object compatible with
 * Core's `ToolInfo.schema` shape (apps/core/src/sidecar/adapters/mod.rs:66-71),
 * and invalid input throws a descriptive Error before the tool body executes.
 *
 * Tools do NOT require model calls and therefore do not need `ctx.gateway`
 * to be present, but the context is still injected so tools can optionally
 * call gateway.chat() when they need model assistance.
 */

import type { JSONSchema7 } from "json-schema";
import { z } from "zod";
import type { RunnableMeta } from "../manifest.ts";
import {
	formatSchemaIssues,
	SchemaConversionError,
	toJsonSchema,
	validateWithSchema,
} from "../schema/json-schema.ts";
import {
	type InferSchemaInput,
	type InferSchemaOutput,
	isStandardSchema,
	type StandardSchemaV1,
} from "../schema/standard-schema.ts";
import type { PrimitiveJsonValue } from "./primitive-contracts.ts";
import { primitiveJsonObjectSchema as appToolJsonObjectSchema } from "./primitive-contracts.ts";
import type { Runnable, RunnableContext } from "./runnable-types.ts";

const toolInputContract = z.record(z.string(), z.unknown());
const toolInputSchema = z.custom<z.output<typeof toolInputContract>>(
	(value) => toolInputContract.safeParse(value).success
);
export type ToolInput = z.output<typeof toolInputSchema>;
const numericInputSchema = z.union([
	z.number(),
	z.nan(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);

// ── JSON Schema types ─────────────────────────────────────────────────────────

/**
 * A single JSON Schema property descriptor — the subset required by Core's
 * `ToolInfo.schema` field and the OpenAI function-calling format.
 */
export interface JsonSchemaProperty {
	/** Human-readable description surfaced to the model. */
	description?: string;
	/** Allowed enum values. */
	enum?: PrimitiveJsonValue[];
	/** Array item schema (required when type is "array"). */
	items?: JsonSchemaProperty;
	/** Nested object properties (used when type is "object"). */
	properties?: Record<string, JsonSchemaProperty>;
	/** Required keys list (used when type is "object"). */
	required?: string[];
	/** JSON Schema type string. */
	type: "string" | "number" | "integer" | "boolean" | "array" | "object";
}

/**
 * Zod-style schema descriptor for a tool's input.
 *
 * Keys are field names; values describe their JSON Schema shape.  Required
 * fields are listed separately under `required`.
 *
 * This intentionally mirrors the shape that `ToolInfo.schema` expects in
 * `apps/core/src/sidecar/adapters/mod.rs` so a `defineTool` output can be
 * forwarded to Core without transformation.
 */
export interface ToolSchema {
	/** Field definitions. */
	properties: Record<string, JsonSchemaProperty>;
	/** Names of fields that must be present in the input. */
	required?: string[];
	/** Type is always "object" for a tool's top-level input schema. */
	type: "object";
	/** Preserve additional JSON Schema keywords for Core/MCP consumers. */
	[key: string]: JSONSchema7[keyof JSONSchema7] | PrimitiveJsonValue;
}

// ── Options ───────────────────────────────────────────────────────────────────

/** Options accepted by `defineTool`. */
export interface ToolOptions<TInput extends ToolInput, TOutput> {
	/** Optional description surfaced to models and tool discovery. */
	description?: string;
	/** Stable unique identifier (e.g. "tool-web-search"). */
	id: string;
	/** Human-readable display name. */
	name: string;
	/** Pause before execution when the Agent is configured with an approval handler. */
	needsApproval?: boolean;
	/**
	 * The tool's run implementation.
	 *
	 * Called only after input validation passes.  Model calls are optional but
	 * must go through `ctx.gateway` if used.
	 */
	run(input: TInput, ctx: RunnableContext): Promise<TOutput>;
	/** JSON Schema describing the tool's input — used for input validation and Core ToolInfo. */
	schema: ToolSchema;
}

/** A Standard Schema whose accepted and parsed values are tool-input objects. */
export type TypedToolInputSchema = StandardSchemaV1<ToolInput, ToolInput>;

/**
 * Options accepted by `defineTool` with a typed (Standard Schema) input schema.
 * `run()` receives the schema's parsed output type.
 */
export interface TypedToolOptions<TSchema extends TypedToolInputSchema, TOutput>
	extends Omit<ToolOptions<ToolInput, TOutput>, "run" | "schema"> {
	/**
	 * Called with the input after `schema` parsed it (defaults and transforms
	 * applied).
	 */
	run(
		input: InferSchemaOutput<TSchema>,
		ctx: RunnableContext
	): Promise<TOutput>;
	/** A zod / valibot / arktype (any Standard Schema) object schema. */
	schema: TSchema;
}

// ── Internal: input validation ────────────────────────────────────────────────

/**
 * Validate `input` against `schema`.
 *
 * Throws a descriptive `Error` naming the first failing field.  This mirrors
 * the validation behaviour of `PluginManifestSchema.safeParse` used elsewhere in
 * the SDK — consistent error handling, no silent fallback.
 */
function validateInput(
	input: Parameters<typeof toolInputSchema.parse>[0],
	schema: ToolSchema,
	toolId: string
): void {
	if (!toolInputSchema.safeParse(input).success) {
		throw new Error(
			`[ryu-sdk] Tool "${toolId}" input must be an object, got ${JSON.stringify(input)}`
		);
	}

	const record = toolInputSchema.parse(input);

	for (const requiredKey of schema.required ?? []) {
		if (!(requiredKey in record)) {
			throw new Error(
				`[ryu-sdk] Tool "${toolId}" input missing required field "${requiredKey}"`
			);
		}
	}

	for (const [key, prop] of Object.entries(schema.properties)) {
		if (!(key in record)) {
			continue; // optional field — skip
		}
		const value = record[key];
		if (!checkType(value, prop.type)) {
			throw new Error(
				`[ryu-sdk] Tool "${toolId}" input field "${key}" expected type "${prop.type}", ` +
					`got ${JSON.stringify(value)}`
			);
		}
	}
}

/** Check that `value` matches the expected JSON Schema primitive type. */
function checkType(
	value: Parameters<typeof toolInputSchema.parse>[0],
	type: JsonSchemaProperty["type"]
): boolean {
	switch (type) {
		case "string":
			return z.string().safeParse(value).success;
		case "number":
		case "integer":
			return numericInputSchema.safeParse(value).success;
		case "boolean":
			return z.boolean().safeParse(value).success;
		case "array":
			return Array.isArray(value);
		case "object":
			return toolInputSchema.safeParse(value).success;
		default:
			return false;
	}
}

// ── ToolRunnable ──────────────────────────────────────────────────────────────

/**
 * A `Runnable` with an extra `schema` field exposing the tool's JSON Schema.
 *
 * The `schema` is compatible with Core's `ToolInfo.schema` shape so it can
 * be forwarded verbatim to Core's MCP/ACP layer.
 */
export interface ToolRunnable<
	TInput extends ToolInput = ToolInput,
	TOutput = unknown,
> extends Runnable<TInput, TOutput> {
	/**
	 * The `run` body serialized for Core's `inline_js` tool backend — the exact
	 * same technique `defineTurnHook` uses for its `code`. This is what makes a
	 * `defineTool` **shippable**: bundled into a plugin manifest (see
	 * {@link inlineToolRunnable} / `definePlugin({ tools })`), Core runs it in the
	 * JS sandbox, so the tool ships NEW behavior instead of only aliasing an
	 * existing tool.
	 *
	 * IMPORTANT: like a hook body, the serialized function is **self-contained** —
	 * it runs in a fresh sandbox with only `input` (the call arguments) and `host`
	 * (the capability bridge: `host.sideModel` / `host.storage` / `host.log`, each
	 * gated by the plugin's grants) in scope. It cannot capture outer variables,
	 * imports, or closures, and `ctx.gateway` is **not** available in the sandbox
	 * — a shipped tool reaches models through `host.sideModel`. When run in-process
	 * via {@link ToolRunnable.run} the normal `(input, ctx)` contract still holds;
	 * the sandbox form is the second parameter aliased to `host`.
	 */
	readonly code: string;
	/** Optional description surfaced to models and tool discovery. */
	readonly description?: string;
	readonly kind: "tool";
	/** Whether the loop must obtain human approval before executing this tool. */
	readonly needsApproval?: boolean;
	/** JSON Schema for this tool's input — compatible with Core's ToolInfo.schema. */
	readonly schema: ToolSchema;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create a Runnable tool with input validation.
 *
 * The returned value satisfies `ToolRunnable<TInput, TOutput>` (which extends
 * `Runnable`) with `kind = "tool"`.  The `schema` property is the JSON Schema
 * descriptor passed in options — forwarding it to Core's `ToolInfo.schema`
 * requires no transformation.
 *
 * Input is validated at `run()` time: missing required fields or type
 * mismatches throw before the tool body executes.
 *
 * @example Typed schema (zod 4 shown; any Standard Schema works)
 * ```ts
 * const weather = defineTool({
 *   id: "tool-weather",
 *   name: "Weather",
 *   schema: z.object({ city: z.string(), units: z.enum(["c", "f"]).default("c") }),
 *   async run({ city, units }) {   // inferred: { city: string; units: "c" | "f" }
 *     return { city, units, tempC: 21 };
 *   },
 * });
 * ```
 *
 * @example Hand-written JSON Schema
 * ```ts
 * const searchTool = defineTool({
 *   id: "tool-web-search",
 *   name: "Web Search",
 *   schema: {
 *     type: "object",
 *     properties: { query: { type: "string", description: "Search query" } },
 *     required: ["query"],
 *   },
 *   async run({ query }, _ctx) {
 *     return { results: [`Result for: ${query}`] };
 *   },
 * });
 * // schema is Core-compatible:
 * console.log(searchTool.schema); // { type: "object", properties: { query: ... }, required: [...] }
 * ```
 */
export function defineTool<
	TSchema extends TypedToolInputSchema,
	TOutput = unknown,
>(
	options: TypedToolOptions<TSchema, TOutput>
): ToolRunnable<InferSchemaInput<TSchema>, TOutput>;
export function defineTool<
	TInput extends ToolInput = ToolInput,
	TOutput = unknown,
>(options: ToolOptions<TInput, TOutput>): ToolRunnable<TInput, TOutput>;
export function defineTool(
	options:
		| ToolOptions<ToolInput, unknown>
		| TypedToolOptions<TypedToolInputSchema, unknown>
): ToolRunnable<ToolInput, unknown> {
	const { description, id, name, needsApproval, run } = options;
	let schema: ToolSchema;
	let typedSchema: TypedToolInputSchema | undefined;
	if (isStandardSchema(options.schema)) {
		typedSchema = options.schema;
		schema = typedToolJsonSchema(options.schema, id);
	} else {
		schema = options.schema;
	}

	// Serialize the run body for Core's `inline_js` backend — the same approach
	// `defineTurnHook` uses: the sandbox wraps this in an async IIFE where `input`
	// and `host` are in scope and a bare `return` reports the tool result.
	const code = `return await (${run.toString()})(input, host);`;

	const metadata: Pick<
		ToolOptions<ToolInput, unknown>,
		"description" | "needsApproval"
	> = {};
	if (description !== undefined) {
		metadata.description = description;
	}
	if (needsApproval !== undefined) {
		metadata.needsApproval = needsApproval;
	}
	const tool: ToolRunnable<ToolInput, unknown> = {
		id,
		name,
		kind: "tool",
		schema,
		...metadata,
		code,
		async run(input: ToolInput, ctx: RunnableContext): Promise<unknown> {
			if (!typedSchema) {
				validateInput(input, schema, id);
				return await run(input, ctx);
			}
			const parsed = await validateWithSchema(typedSchema, input);
			if (!parsed.ok) {
				throw new Error(
					`[ryu-sdk] Tool "${id}" input is invalid:\n${formatSchemaIssues(parsed.issues)}`
				);
			}
			return await run(parsed.value, ctx);
		},
	};
	return tool;
}

/**
 * Convert a typed tool schema into the Core-compatible `ToolSchema`. A tool's
 * arguments are always a JSON object, so the root must describe one.
 */
function typedToolJsonSchema(
	schema: TypedToolInputSchema,
	toolId: string
): ToolSchema {
	const jsonSchema = toJsonSchema(schema, "input");
	if (jsonSchema.type !== "object") {
		throw new SchemaConversionError(
			`Tool "${toolId}" input schema must describe an object, got type ${JSON.stringify(jsonSchema.type ?? null)}`
		);
	}
	// SAFETY: the converter produced a JSON object whose root `type` is
	// "object"; `properties` is defaulted so the Core `ToolInfo.schema` shape
	// (type + properties [+ required]) always holds.
	return { properties: {}, ...jsonSchema } as ToolSchema;
}

/** Optional metadata lowered alongside a tool's executable backend. */
export interface InlineToolManifestOptions {
	/** Marks the entry as a semantic Ryu Action. */
	action?: boolean;
	/** MCP-style effect annotations, for example `readOnlyHint`. */
	annotations?: Record<string, boolean | undefined>;
	/** Description shown in Core's unified tool catalog. */
	description?: string;
	/** Force the human approval gate before the tool runs. */
	needsApproval?: boolean;
	/** JSON Schema for the structured result. */
	outputSchema?: z.output<typeof appToolJsonObjectSchema>;
}

/**
 * Convert a {@link ToolRunnable} into a `manifest.json` `kind:"tool"` runnable that
 * ships its `run` body as Core's `inline_js` backend. The emitted config
 * mirrors Core's `ToolConfig` (`apps/core/src/plugin_manifest/schema.rs`):
 * `{ slug, backend:"inline_js", code, description?, input_schema }`. Core
 * registers it as `app.<slug>` — discoverable via `/api/tools/search` and
 * executed in the grant-gated sandbox.
 *
 * The plugin must declare the `tool:execute` grant (see `definePlugin`).
 */
export function inlineToolRunnable(
	tool: Pick<
		ToolRunnable,
		"code" | "description" | "id" | "name" | "needsApproval" | "schema"
	>,
	options?: InlineToolManifestOptions
): RunnableMeta {
	const config: NonNullable<RunnableMeta["config"]> = {
		slug: tool.id,
		backend: "inline_js",
		code: tool.code,
		input_schema: tool.schema,
	};
	const description =
		options?.description === undefined ? tool.description : options.description;
	if (description !== undefined) {
		config.description = description;
	}
	if (options?.outputSchema) {
		config.output_schema = appToolJsonObjectSchema.parse(options.outputSchema);
	}
	if (options?.annotations) {
		config.annotations = options.annotations;
	}
	if (options?.action !== undefined) {
		config.action = options.action;
	}
	const needsApproval = options?.needsApproval ?? tool.needsApproval;
	if (needsApproval !== undefined) {
		config.needs_approval = needsApproval;
	}
	return { id: tool.id, name: tool.name, kind: "tool", config };
}
