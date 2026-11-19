/**
 * Working memory for the SDK agent loop (Mastra-style).
 *
 * Working memory is ONE small, structured scratchpad per thread or per
 * resource that the agent keeps current: the user's name, the goal of the task,
 * decisions made so far. It is stored encrypted in Core
 * (`GET/PUT /api/memory/working`), injected into the model context on every
 * model call, and updated by the model through the `update_working_memory`
 * tool.
 *
 * Two modes:
 * - **template** (default): a Markdown document seeded from `template`; an
 *   update replaces the whole document.
 * - **schema**: a JSON object described by `schema` (any Standard Schema
 *   validator or a JSON Schema); an update is a JSON merge patch that Core
 *   validates against the schema.
 *
 * Code inside tools reaches the same document through
 * `ctx.memory.working.get()` / `ctx.memory.working.update()`.
 *
 * The transport and document types live in `working-memory-client.ts`.
 */

import { z } from "zod";
import type { MemoryClient } from "../runnable/primitives.ts";
import type { RunnableContext } from "../runnable/runnable-types.ts";
import {
	defineTool,
	type JsonSchemaProperty,
	type ToolRunnable,
} from "../runnable/tool.ts";
import { type SchemaLike, toJsonSchema } from "../schema/json-schema.ts";
import type { AgentMiddleware } from "./middleware.ts";
import {
	jsonObject,
	type ResolvedWorkingMemory,
	WorkingMemoryConflictError,
	type WorkingMemoryDocument,
	type WorkingMemoryHandle,
	type WorkingMemoryScope,
	type WorkingMemoryUpdate,
} from "./working-memory-client.ts";
import {
	conflictMessage,
	parseExpectedVersion,
	versionInstructions,
} from "./working-memory-version.ts";

export type {
	ResolvedWorkingMemory,
	WorkingMemoryDocument,
	WorkingMemoryHandle,
	WorkingMemoryJson,
	WorkingMemoryMode,
	WorkingMemoryRef,
	WorkingMemoryScope,
	WorkingMemoryTransportOptions,
	WorkingMemoryUpdate,
} from "./working-memory-client.ts";
export {
	createWorkingMemoryHandle,
	WorkingMemoryConflictError,
} from "./working-memory-client.ts";

/** The model-facing name of the update tool (matches Core's built-in tool). */
export const WORKING_MEMORY_TOOL_NAME = "update_working_memory";

/** Mastra's default working-memory template, mirrored from Core. */
export const DEFAULT_WORKING_MEMORY_TEMPLATE = `# User Information
- **First Name**:
- **Last Name**:
- **Location**:
- **Occupation**:
- **Interests**:
- **Goals**:
- **Events**:
- **Facts**:
- **Projects**:
`;

/** `Agent({ workingMemory })` configuration. */
export interface WorkingMemoryOptions {
	/**
	 * The document id: the thread / conversation id for `thread` scope, the
	 * resource key (usually a user or customer id) for `resource` scope.
	 */
	id: string;
	/**
	 * JSON-object shape for schema mode: a Standard Schema validator (zod 4,
	 * valibot, arktype, …) or a JSON Schema object. Wins over `template`.
	 */
	schema?: SchemaLike;
	/** `thread` (default) or `resource`. */
	scope?: WorkingMemoryScope;
	/** Markdown template for template mode (defaults to a user profile). */
	template?: string;
}

/** Normalize `workingMemory` options once (converts a typed schema). */
export function resolveWorkingMemory(
	options: WorkingMemoryOptions
): ResolvedWorkingMemory {
	const id = options.id.trim();
	if (!id) {
		throw new Error("workingMemory.id is required");
	}
	const scope = options.scope ?? "thread";
	if (options.schema !== undefined) {
		const schema = jsonObject.parse(toJsonSchema(options.schema, "output"));
		if (schema.type !== undefined && schema.type !== "object") {
			throw new Error("workingMemory.schema must describe an object");
		}
		return {
			mode: "schema",
			ref: { id, scope },
			schema,
			template: "",
		};
	}
	return {
		mode: "template",
		ref: { id, scope },
		template: options.template ?? DEFAULT_WORKING_MEMORY_TEMPLATE,
	};
}

/** Render the context block the model sees each call. */
export function renderWorkingMemoryBlock(
	resolved: ResolvedWorkingMemory,
	doc: WorkingMemoryDocument | null
): string {
	const audience =
		resolved.ref.scope === "thread"
			? "conversation"
			: "user across conversations";
	// The version guards the stored document, so the model can send it back.
	const version = doc?.version ?? 0;
	const lines = [
		"<working_memory>",
		`This is your working memory: a persistent scratchpad for this ${audience}. Keep it current.`,
	];
	if (resolved.mode === "template") {
		lines.push(
			`When you learn something worth keeping, call \`${WORKING_MEMORY_TOOL_NAME}\` with the COMPLETE updated Markdown in \`content\` (it replaces the whole document). Do not mention the scratchpad to the user.`,
			versionInstructions(version),
			""
		);
		const content = doc?.content?.trim();
		if (content) {
			lines.push(content);
		} else {
			lines.push(
				"(empty — fill in this template)",
				(doc?.template ?? resolved.template).trimEnd()
			);
		}
	} else {
		lines.push(
			`When you learn something worth keeping, call \`${WORKING_MEMORY_TOOL_NAME}\` with \`data\` set to a JSON merge patch: only the fields that changed; \`null\` removes a field. Do not mention the scratchpad to the user.`,
			versionInstructions(version),
			"",
			"Current value:",
			JSON.stringify(doc?.data ?? {}, null, 2),
			"",
			"Schema:",
			JSON.stringify(resolved.schema ?? {})
		);
	}
	lines.push("</working_memory>");
	return lines.join("\n");
}

/**
 * Middleware that injects the current working memory into every model call,
 * as a system message right after the agent's own instructions. A read
 * failure degrades to "no working memory this call" rather than failing the
 * run.
 */
export function workingMemoryMiddleware(
	resolved: ResolvedWorkingMemory,
	handle: WorkingMemoryHandle
): AgentMiddleware {
	return {
		name: "working-memory",
		async wrapModelCall(request, next) {
			let doc: WorkingMemoryDocument | null = null;
			try {
				doc = await handle.get();
			} catch {
				return next(request);
			}
			const block = renderWorkingMemoryBlock(resolved, doc);
			const messages = [...request.messages];
			let insertAt = 0;
			while (messages[insertAt]?.role === "system") {
				insertAt += 1;
			}
			messages.splice(insertAt, 0, { role: "system", content: block });
			return next({ ...request, messages });
		},
	};
}

const updateArgs = z.object({
	content: z.string().optional(),
	data: z.union([jsonObject, z.string()]).optional(),
	expected_version: z.unknown().optional(),
});

const EXPECTED_VERSION_PROPERTY: JsonSchemaProperty = {
	type: "integer",
	description:
		"The working-memory version you read (0 when it is empty). The update is refused if the document changed since.",
};

const VERSION_DESCRIPTION =
	" Pass `expected_version`: the version shown in your working memory, or the `version` your last update returned. If it is stale the update is refused with the current document; merge your change into it and retry.";

/**
 * Write through the handle; a stale `expectedVersion` becomes the same
 * actionable conflict error Core's built-in tool returns, with the current
 * document re-read so the model can merge and retry in the same turn.
 */
async function writeChecked(
	handle: WorkingMemoryHandle,
	update: WorkingMemoryUpdate
): Promise<{ ok: true; version: number }> {
	try {
		const doc = await handle.update(update);
		return { ok: true, version: doc.version };
	} catch (error) {
		if (!(error instanceof WorkingMemoryConflictError)) {
			throw error;
		}
		const latest = await handle.get().catch(() => null);
		throw new Error(
			conflictMessage(
				WORKING_MEMORY_TOOL_NAME,
				error.expectedVersion,
				error.currentVersion,
				latest
			)
		);
	}
}

/** The `update_working_memory` tool the model calls to keep its scratchpad. */
export function workingMemoryTool(
	resolved: ResolvedWorkingMemory,
	handle: WorkingMemoryHandle
): ToolRunnable {
	const schemaMode = resolved.mode === "schema";
	return defineTool({
		id: WORKING_MEMORY_TOOL_NAME,
		name: "Update working memory",
		description:
			(schemaMode
				? "Update your working memory with a JSON merge patch in `data`: only the fields that changed; `null` removes a field."
				: "Replace your working memory with the COMPLETE updated Markdown in `content`.") +
			VERSION_DESCRIPTION,
		schema: schemaMode
			? {
					type: "object",
					properties: {
						data: {
							type: "object",
							description:
								"JSON merge patch applied to the stored working memory.",
						},
						expected_version: EXPECTED_VERSION_PROPERTY,
					},
					required: ["data"],
				}
			: {
					type: "object",
					properties: {
						content: {
							type: "string",
							description: "The complete updated Markdown document.",
						},
						expected_version: EXPECTED_VERSION_PROPERTY,
					},
					required: ["content"],
				},
		async run(input) {
			const args = updateArgs.parse(input);
			const expectedVersion = parseExpectedVersion(args.expected_version);
			if (schemaMode) {
				const patch =
					typeof args.data === "string"
						? jsonObject.parse(JSON.parse(args.data))
						: args.data;
				if (!patch) {
					throw new Error("`data` (a JSON merge patch) is required");
				}
				return await writeChecked(handle, { data: patch, expectedVersion });
			}
			if (args.content === undefined) {
				throw new Error("`content` (the complete Markdown) is required");
			}
			return await writeChecked(handle, {
				content: args.content,
				expectedVersion,
			});
		},
	});
}

function primitivesUnavailable(verb: string): Promise<never> {
	return Promise.reject(
		new Error(
			`ctx.memory.${verb} needs Agent({ pluginId }) so the memory primitives are mounted`
		)
	);
}

/**
 * Mount `ctx.memory.working` on a run context, keeping any memory primitives
 * already there (`recall` / `store` reject with a clear error when the agent
 * has no `pluginId`).
 */
export function mountWorkingMemory(
	context: RunnableContext,
	handle: WorkingMemoryHandle
): void {
	const memory: MemoryClient = context.memory ?? {
		recall: () => primitivesUnavailable("recall"),
		store: () => primitivesUnavailable("store"),
	};
	context.memory = { ...memory, working: handle };
}
