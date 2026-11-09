/**
 * Working-memory transport for the SDK agent loop: the document types, Core's
 * wire shapes, and {@link createWorkingMemoryHandle} over
 * `GET/PUT /api/memory/working`. The agent-facing pieces (options, the context
 * block, the middleware, and the `update_working_memory` tool) live in
 * `working-memory.ts`, which re-exports the public types and the handle.
 */

import { z } from "zod";

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
export const jsonObject = z.record(z.string(), jsonValue);

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

/** The resolved form of `WorkingMemoryOptions`. */
export interface ResolvedWorkingMemory {
	mode: WorkingMemoryMode;
	ref: WorkingMemoryRef;
	schema?: Record<string, WorkingMemoryJson>;
	template: string;
}

/**
 * Core refused a write because `expectedVersion` was stale (HTTP 409): the
 * document changed after it was read. Nothing was saved.
 */
export class WorkingMemoryConflictError extends Error {
	/** The version the document is at now. */
	readonly currentVersion: number;
	/** The version the caller sent. */
	readonly expectedVersion: number;

	constructor(
		message: string,
		expectedVersion: number,
		currentVersion: number
	) {
		super(message);
		this.name = "WorkingMemoryConflictError";
		this.expectedVersion = expectedVersion;
		this.currentVersion = currentVersion;
	}
}

const conflictWire = z.object({ current_version: z.number() });

async function failure(
	path: string,
	res: Response,
	expectedVersion?: number
): Promise<Error> {
	const detail = await res.text().catch(() => "");
	const message = `working memory ${path} failed: ${res.status} ${res.statusText}${
		detail ? ` — ${detail}` : ""
	}`;
	if (res.status === 409 && expectedVersion !== undefined) {
		let current: z.output<typeof conflictWire> | undefined;
		try {
			current = conflictWire.parse(JSON.parse(detail));
		} catch {
			current = undefined;
		}
		if (current) {
			return new WorkingMemoryConflictError(
				message,
				expectedVersion,
				current.current_version
			);
		}
	}
	return new Error(message);
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
				throw await failure(path, res, update.expectedVersion);
			}
			const wire = envelopeWire.parse(await res.json());
			if (!wire.working_memory) {
				throw new Error("Core returned no working memory after an update");
			}
			return toDocument(wire.working_memory);
		},
	};
}
