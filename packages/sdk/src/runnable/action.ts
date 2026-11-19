/**
 * Canonical Ryu Action authoring API.
 *
 * An Action is the semantic contract for a business operation: one description,
 * input schema, output schema, implementation, and effect declaration. It lowers
 * to Ryu's existing governed `inline_js` Tool backend, so this adds a coherent
 * authoring seam without introducing a second Core execution runtime.
 */

import type { z } from "zod";
import {
	type PluginManifest,
	PluginManifestSchema,
	type RunnableMeta,
	type Surface,
} from "../manifest.ts";
import type { SdkRunnable } from "../mcp/server.ts";
import {
	primitiveJsonObjectSchema as appToolJsonObjectSchema,
	primitiveJsonSchema,
} from "./primitive-contracts.ts";
import type { RunnableContext } from "./runnable-types.ts";
import {
	defineTool,
	type InlineToolManifestOptions,
	inlineToolRunnable,
	type ToolInput,
	type ToolRunnable,
	type ToolSchema,
} from "./tool.ts";

/** The two effects Core can enforce from tool annotations. */
export type ActionEffect = "mutate" | "read";

/** MCP-compatible effect hints plus any future provider-neutral boolean hints. */
export interface ActionAnnotations {
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
	readOnlyHint?: boolean;
	[key: string]: boolean | undefined;
}

/** Options for defining a canonical Action. */
export interface ActionOptions<TInput extends ToolInput, TOutput> {
	/** Additional MCP-compatible effect hints. */
	annotations?: ActionAnnotations;
	/** Description the agent reads when deciding whether to call the action. */
	description: string;
	/** Explicit effect used by read-only and approval enforcement. */
	effect: ActionEffect;
	/** Stable action id, also used as the generated Core tool slug. */
	id: string;
	/** Human-readable action name. */
	name: string;
	/** Require human approval even when global smart mode would not classify it. */
	needsApproval?: boolean;
	/** JSON Schema for the structured action result. */
	outputSchema?: z.output<typeof appToolJsonObjectSchema>;
	/** The one implementation used by local callers and the packaged tool body. */
	run(input: TInput, ctx: RunnableContext): Promise<TOutput>;
	/** JSON Schema for all action inputs. */
	schema: ToolSchema;
}

/** Options for lowering one Action into a standalone Ryu plugin manifest. */
export interface ActionManifestOptions {
	/** Plugin activation events; defaults to eager activation. */
	activationEvents?: readonly string[];
	/** Extra Gateway grants required by the action body. */
	grants?: readonly string[];
	/** Reverse-domain plugin id (for example `com.acme.support`). */
	id: string;
	/** Display name; defaults to the Action name. */
	name?: string;
	/** Host surfaces this plugin targets. */
	targets?: readonly Surface[];
	/** Plugin semver. */
	version: string;
}

/** A ToolRunnable with Action semantics and manifest/MCP adapters. */
export interface ActionRunnable<
	TInput extends ToolInput = ToolInput,
	TOutput = unknown,
> extends ToolRunnable<TInput, TOutput> {
	/** Discriminates this semantic contract from an ordinary ToolRunnable. */
	readonly action: true;
	/** Effect hints lowered into Core's existing tool metadata. */
	readonly annotations: ActionAnnotations;
	/** Required action description. */
	readonly description: string;
	/** Declared effect. */
	readonly effect: ActionEffect;
	/** Whether Core must queue approval before execution. */
	readonly needsApproval: boolean;
	/** Structured result schema, when the action returns one. */
	readonly outputSchema?: z.output<typeof appToolJsonObjectSchema>;
	/** Lower this Action to a validated, installable plugin manifest. */
	toManifest(options: ActionManifestOptions): PluginManifest;
	/** Adapt this Action to the SDK MCP server using the same implementation. */
	toMcpTool(context: RunnableContext): SdkRunnable;
}

function deriveAnnotations(
	effect: ActionEffect,
	annotations: ActionAnnotations | undefined
): ActionAnnotations {
	const resolved = {
		...annotations,
		readOnlyHint: annotations?.readOnlyHint ?? effect === "read",
		destructiveHint: annotations?.destructiveHint ?? effect === "mutate",
	};

	if (effect === "read" && resolved.destructiveHint) {
		throw new Error(
			"[ryu-sdk] read actions cannot set annotations.destructiveHint=true"
		);
	}
	if (effect === "mutate" && resolved.readOnlyHint) {
		throw new Error(
			"[ryu-sdk] mutate actions cannot set annotations.readOnlyHint=true"
		);
	}

	return resolved;
}

function actionManifestEntry(action: ActionRunnable): RunnableMeta {
	const options: InlineToolManifestOptions = {
		action: true,
		annotations: action.annotations,
		description: action.description,
		needsApproval: action.needsApproval,
	};
	if (action.outputSchema) {
		options.outputSchema = appToolJsonObjectSchema.parse(action.outputSchema);
	}
	return inlineToolRunnable(action, options);
}

function actionToManifest(
	action: ActionRunnable,
	options: ActionManifestOptions
): PluginManifest {
	const grants = [...new Set([...(options.grants ?? []), "tool:execute"])];
	const raw = {
		id: options.id,
		name: options.name ?? action.name,
		version: options.version,
		runnables: [actionManifestEntry(action)],
		permission_grants: grants,
		activation_events: [...(options.activationEvents ?? ["*"])],
		targets: [...(options.targets ?? [])],
	};
	const result = PluginManifestSchema.safeParse(raw);
	if (!result.success) {
		const first = result.error.issues[0];
		const field = first?.path.join(".") ?? "unknown";
		const message = first?.message ?? "validation failed";
		throw new Error(
			`[ryu-sdk] action manifest validation failed at '${field}': ${message}`
		);
	}
	return result.data;
}

/**
 * Define one business operation that can be run locally, packaged as a Core
 * tool, or registered on an SDK MCP server without rewriting its implementation.
 */
export function defineAction<
	TInput extends ToolInput = ToolInput,
	TOutput = unknown,
>(options: ActionOptions<TInput, TOutput>): ActionRunnable<TInput, TOutput> {
	const annotations = deriveAnnotations(options.effect, options.annotations);
	const tool = defineTool({
		description: options.description,
		id: options.id,
		name: options.name,
		run: options.run,
		schema: options.schema,
	});

	const action: ActionRunnable<TInput, TOutput> = {
		...tool,
		action: true,
		annotations,
		description: options.description,
		effect: options.effect,
		needsApproval: options.needsApproval ?? false,
		toManifest(manifestOptions) {
			return actionToManifest(action, manifestOptions);
		},
		toMcpTool(context) {
			return {
				name: action.id,
				description: action.description,
				inputSchema: action.schema,
				run: async (input) => {
					// SAFETY: action.run applies its input schema before the implementation receives this generic input.
					const output = await action.run(input as TInput, context);
					const text = JSON.stringify(output);
					return text === undefined
						? undefined
						: primitiveJsonSchema.parse(JSON.parse(text));
				},
			};
		},
	};

	return options.outputSchema
		? Object.assign(action, {
				outputSchema: appToolJsonObjectSchema.parse(options.outputSchema),
			})
		: action;
}
