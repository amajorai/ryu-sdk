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
 */

import { z } from "zod";
import type { MemoryClient } from "../runnable/primitives.ts";
import type { RunnableContext } from "../runnable/runnable-types.ts";
import { defineTool, type ToolRunnable } from "../runnable/tool.ts";
import { type SchemaLike, toJsonSchema } from "../schema/json-schema.ts";
import type { AgentMiddleware } from "./middleware.ts";

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

/** Which partition a working-memory document belongs to. */
export type WorkingMemoryScope = "thread" | "resource";

/** How the scratchpad is shaped and how updates apply. */
export type WorkingMemoryMode = "template" | "schema";

/** JSON value stored in schema-mode working memory. */
export type WorkingMemoryJson =
	| null
	| boolean
	| number
	| string
	| WorkingMemoryJson[]
	| { [key: string]: WorkingMemoryJson };

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

/** One stored working-memory document. */
export interface WorkingMemoryDocument {
	content?: string;
	createdAt: number;
	data?: Record<string, WorkingMemoryJson>;
	id: string;
	mode: WorkingMemoryMode;
	schema?: Record<string, WorkingMemoryJson>;
	scope: WorkingMemoryScope;
	template?: string;
	updatedAt: number;
	version: number;
}

/** A write to a working-memory document. */
export interface WorkingMemoryUpdate {
	/** Template mode: the complete replacement Markdown. */
	content?: string;
	/** Schema mode: a JSON merge patch; `null` removes a key. */
	data?: Record<string, WorkingMemoryJson>;
	/** Fail unless the stored version matches (0 = must not exist yet). */
	expectedVersion?: number;
	/** Schema mode: replace the whole object instead of merging. */
	replace?: boolean;
}

/** Addresses one document. */
export interface WorkingMemoryRef {
	id: string;
	scope: WorkingMemoryScope;
}

/** `ctx.memory.working` — the run's working memory. */
export interface WorkingMemoryHandle {
	/** Read the document (`ref` defaults to the agent's configured one). */
	get(ref?: Partial<WorkingMemoryRef>): Promise<WorkingMemoryDocument | null>;
	/** Write the document (`ref` defaults to the agent's configured one). */
	update(
		update: WorkingMemoryUpdate,
		ref?: Partial<WorkingMemoryRef>
	): Promise<WorkingMemoryDocument>;
}

/** Transport options for {@link createWorkingMemoryHandle}. */
export interface WorkingMemoryTransportOptions {
	/** Core base URL (no trailing `/api`). */
	coreBaseUrl: string;
	/** Bearer token for Core. */
	coreToken?: string;
	/** Injectable fetch (defaults to the global). */
	fetchImpl?: typeof fetch;
}

const jsonValue: z.ZodType<WorkingMemoryJson> = z.lazy(() =>
	z.union([
		z.null(),
		z.boolean(),
		z.number(),
		z.string(),
		z.array(jsonValue),
		z.record(z.string(), jsonValue),
	])
);
const jsonObject = z.record(z.string(), jsonValue);

const documentWire = z.object({
	scope: z.enum(["thread", "resource"]),
	id: z.string(),
	mode: z.enum(["template", "schema"]),
	content: z.string().nullish(),
	data: jsonObject.nullish(),
	template: z.string().nullish(),
	schema: jsonObject.nullish(),
	version: z.number(),
	created_at: z.number(),
	updated_at: z.number(),
});
const envelopeWire = z.object({ working_memory: documentWire.nullable() });

function toDocument(
	wire: z.output<typeof documentWire>
): WorkingMemoryDocument {
	const doc: WorkingMemoryDocument = {
		scope: wire.scope,
		id: wire.id,
		mode: wire.mode,
		version: wire.version,
		createdAt: wire.created_at,
		updatedAt: wire.updated_at,
	};
	if (wire.content != null) {
		doc.content = wire.content;
	}
	if (wire.data != null) {
		doc.data = wire.data;
	}
	if (wire.template != null) {
		doc.template = wire.template;
	}
	if (wire.schema != null) {
		doc.schema = wire.schema;
	}
	return doc;
}

/** The resolved form of {@link WorkingMemoryOptions}. */
export interface ResolvedWorkingMemory {
	mode: WorkingMemoryMode;
	ref: WorkingMemoryRef;
	schema?: Record<string, WorkingMemoryJson>;
	template: string;
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

async function failure(path: string, res: Response): Promise<Error> {
	const detail = await res.text().catch(() => "");
	return new Error(
		`working memory ${path} failed: ${res.status} ${res.statusText}${
			detail ? ` — ${detail}` : ""
		}`
	);
}

/**
 * Build a {@link WorkingMemoryHandle} over Core's working-memory routes. The
 * resolved config's mode, template, and schema are recorded on every write so
 * Core validates schema-mode patches.
 */
export function createWorkingMemoryHandle(
	resolved: ResolvedWorkingMemory,
	transport: WorkingMemoryTransportOptions
): WorkingMemoryHandle {
	const base = transport.coreBaseUrl.replace(/\/+$/, "");
	const doFetch = transport.fetchImpl ?? fetch;
	const headers = (): Record<string, string> => ({
		"content-type": "application/json",
		...(transport.coreToken
			? { authorization: `Bearer ${transport.coreToken}` }
			: {}),
	});
	const pathFor = (ref?: Partial<WorkingMemoryRef>): string => {
		const params = new URLSearchParams({
			scope: ref?.scope ?? resolved.ref.scope,
			id: ref?.id ?? resolved.ref.id,
		});
		return `/api/memory/working?${params.toString()}`;
	};
	return {
		async get(ref) {
			const path = pathFor(ref);
			const res = await doFetch(`${base}${path}`, {
				method: "GET",
				headers: headers(),
			});
			if (!res.ok) {
				throw await failure(path, res);
			}
			const wire = envelopeWire.parse(await res.json());
			return wire.working_memory ? toDocument(wire.working_memory) : null;
		},
		async update(update, ref) {
			const path = pathFor(ref);
			const body =
				resolved.mode === "schema"
					? {
							mode: "schema",
							data: update.data,
							schema: resolved.schema,
							replace: update.replace ?? false,
							expected_version: update.expectedVersion,
						}
					: {
							mode: "template",
							content: update.content,
							template: resolved.template,
							expected_version: update.expectedVersion,
						};
			const res = await doFetch(`${base}${path}`, {
				method: "PUT",
				headers: headers(),
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				throw await failure(path, res);
			}
			const wire = envelopeWire.parse(await res.json());
			if (!wire.working_memory) {
				throw new Error("Core returned no working memory after an update");
			}
			return toDocument(wire.working_memory);
		},
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
	const lines = [
		"<working_memory>",
		`This is your working memory: a persistent scratchpad for this ${audience}. Keep it current.`,
	];
	if (resolved.mode === "template") {
		lines.push(
			`When you learn something worth keeping, call \`${WORKING_MEMORY_TOOL_NAME}\` with the COMPLETE updated Markdown in \`content\` (it replaces the whole document). Do not mention the scratchpad to the user.`,
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
});

/** The `update_working_memory` tool the model calls to keep its scratchpad. */
export function workingMemoryTool(
	resolved: ResolvedWorkingMemory,
	handle: WorkingMemoryHandle
): ToolRunnable {
	const schemaMode = resolved.mode === "schema";
	return defineTool({
		id: WORKING_MEMORY_TOOL_NAME,
		name: "Update working memory",
		description: schemaMode
			? "Update your working memory with a JSON merge patch in `data`: only the fields that changed; `null` removes a field."
			: "Replace your working memory with the COMPLETE updated Markdown in `content`.",
		schema: schemaMode
			? {
					type: "object",
					properties: {
						data: {
							type: "object",
							description:
								"JSON merge patch applied to the stored working memory.",
						},
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
					},
					required: ["content"],
				},
		async run(input) {
			const args = updateArgs.parse(input);
			if (schemaMode) {
				const patch =
					typeof args.data === "string"
						? jsonObject.parse(JSON.parse(args.data))
						: args.data;
				if (!patch) {
					throw new Error("`data` (a JSON merge patch) is required");
				}
				const doc = await handle.update({ data: patch });
				return { ok: true, version: doc.version };
			}
			if (args.content === undefined) {
				throw new Error("`content` (the complete Markdown) is required");
			}
			const doc = await handle.update({ content: args.content });
			return { ok: true, version: doc.version };
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
