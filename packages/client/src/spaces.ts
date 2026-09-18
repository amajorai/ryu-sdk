// packages/client/src/spaces.ts
//
// SpacesAPI: typed client for Core's Spaces / RAG endpoints (/api/spaces).
// A Space is a named document collection backed by sqlite-vec; documents are
// ingested (chunked + embedded) and searched by whichever retrieval algorithm
// the Space is set to — vector KNN or entity-graph traversal — after which hits
// are link-expanded and neurally reranked. See `SpacesAPI.search`.

import { request } from "./request.ts";
import type {
	RetrievalMode,
	RyuClientOptions,
	Space,
	SpaceMatch,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Wire shapes (snake_case from Core)
// ---------------------------------------------------------------------------

interface SpaceWire {
	created_at: number;
	description?: string | null;
	document_count: number;
	id: string;
	name: string;
	retrieval_mode?: string;
	updated_at: number;
}

interface MatchWire {
	chunk_id: string;
	content: string;
	distance: number;
	document_id: string;
}

export interface RetrievalModeChange {
	changed: boolean;
	chunksScanned: number;
	graphEdges: number;
	graphNodes: number;
	graphRebuilt: boolean;
	mode: RetrievalMode;
	previous: RetrievalMode;
}

export interface RetrievalModeJob {
	cancelPath: string;
	jobId: string;
	retrievalMode: RetrievalMode;
	spaceId: string;
	statusPath: string;
}

interface RetrievalModeStatusBase {
	graphEdges: number;
	graphNodes: number;
	jobId: string;
	previousMode: RetrievalMode | null;
	processedChunks: number;
	requestedMode: RetrievalMode;
	spaceId: string;
	totalChunks: number;
}

export type RetrievalModeStatus =
	| (RetrievalModeStatusBase & {
			change: null;
			error: null;
			state: "cancelling" | "running";
	  })
	| (RetrievalModeStatusBase & {
			change: RetrievalModeChange;
			error: null;
			state: "completed";
	  })
	| (RetrievalModeStatusBase & {
			change: null;
			error: string | null;
			state: "cancelled";
	  })
	| (RetrievalModeStatusBase & {
			change: null;
			error: string;
			state: "failed";
	  });

export interface RetrievalModeCancellation {
	cancelled: boolean;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function toSpace(s: SpaceWire): Space {
	return {
		id: s.id,
		name: s.name,
		description: s.description ?? null,
		createdAt: s.created_at,
		updatedAt: s.updated_at,
		documentCount: s.document_count,
		retrievalMode: toRetrievalMode(s.retrieval_mode),
	};
}

function toMatch(m: MatchWire): SpaceMatch {
	return {
		chunkId: m.chunk_id,
		documentId: m.document_id,
		content: m.content,
		distance: m.distance,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(endpoint: string): Error {
	return new Error(`RyuClient: Core returned an invalid ${endpoint} response`);
}

function requireRecord(
	value: unknown,
	endpoint: string
): Record<string, unknown> {
	if (!isRecord(value)) {
		throw invalidResponse(endpoint);
	}
	return value;
}

function requireString(
	record: Record<string, unknown>,
	key: string,
	endpoint: string
): string {
	const value = record[key];
	if (typeof value !== "string" || value.trim() === "") {
		throw invalidResponse(endpoint);
	}
	return value;
}

function requireCount(
	record: Record<string, unknown>,
	key: string,
	endpoint: string
): number {
	const value = record[key];
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw invalidResponse(endpoint);
	}
	return value;
}

function requireBoolean(
	record: Record<string, unknown>,
	key: string,
	endpoint: string
): boolean {
	const value = record[key];
	if (typeof value !== "boolean") {
		throw invalidResponse(endpoint);
	}
	return value;
}

function parseRetrievalMode(value: unknown, endpoint: string): RetrievalMode {
	if (value === "graph" || value === "vector") {
		return value;
	}
	throw invalidResponse(endpoint);
}

function toRetrievalMode(value: unknown): RetrievalMode {
	if (value === undefined) {
		return "vector";
	}
	return parseRetrievalMode(value, "space");
}

function parseNullableMode(
	value: unknown,
	endpoint: string
): RetrievalMode | null {
	if (value === null) {
		return null;
	}
	return parseRetrievalMode(value, endpoint);
}

function parseRetrievalModeChange(
	value: unknown,
	endpoint: string
): RetrievalModeChange {
	const record = requireRecord(value, endpoint);
	return {
		previous: parseRetrievalMode(record.previous, endpoint),
		mode: parseRetrievalMode(record.mode, endpoint),
		changed: requireBoolean(record, "changed", endpoint),
		graphRebuilt: requireBoolean(record, "graph_rebuilt", endpoint),
		chunksScanned: requireCount(record, "chunks_scanned", endpoint),
		graphNodes: requireCount(record, "graph_nodes", endpoint),
		graphEdges: requireCount(record, "graph_edges", endpoint),
	};
}

function parseRetrievalModeJob(value: unknown): RetrievalModeJob {
	const endpoint = "retrieval-mode job";
	const record = requireRecord(value, endpoint);
	if (record.success !== true) {
		throw invalidResponse(endpoint);
	}
	return {
		jobId: requireString(record, "job_id", endpoint),
		spaceId: requireString(record, "space_id", endpoint),
		retrievalMode: parseRetrievalMode(record.retrieval_mode, endpoint),
		statusPath: requireString(record, "status", endpoint),
		cancelPath: requireString(record, "cancel", endpoint),
	};
}

function parseRetrievalModeStatus(value: unknown): RetrievalModeStatus {
	const endpoint = "retrieval-mode status";
	const record = requireRecord(value, endpoint);
	const base: RetrievalModeStatusBase = {
		jobId: requireString(record, "job_id", endpoint),
		spaceId: requireString(record, "space_id", endpoint),
		requestedMode: parseRetrievalMode(record.requested_mode, endpoint),
		previousMode: parseNullableMode(record.previous_mode, endpoint),
		totalChunks: requireCount(record, "total_chunks", endpoint),
		processedChunks: requireCount(record, "processed_chunks", endpoint),
		graphNodes: requireCount(record, "graph_nodes", endpoint),
		graphEdges: requireCount(record, "graph_edges", endpoint),
	};
	if (base.processedChunks > base.totalChunks) {
		throw invalidResponse(endpoint);
	}
	const state = record.state;
	if (state === "running" || state === "cancelling") {
		if (record.change !== null || record.error !== null) {
			throw invalidResponse(endpoint);
		}
		return { ...base, state, change: null, error: null };
	}
	if (state === "completed") {
		if (record.error !== null || base.previousMode === null) {
			throw invalidResponse(endpoint);
		}
		const change = parseRetrievalModeChange(record.change, endpoint);
		if (
			base.processedChunks !== base.totalChunks ||
			change.previous !== base.previousMode ||
			change.mode !== base.requestedMode ||
			change.changed !== (change.previous !== change.mode) ||
			change.graphRebuilt !== (change.mode === "graph") ||
			change.chunksScanned !== base.processedChunks ||
			change.graphNodes !== base.graphNodes ||
			change.graphEdges !== base.graphEdges
		) {
			throw invalidResponse(endpoint);
		}
		return {
			...base,
			state,
			change,
			error: null,
		};
	}
	if (state === "cancelled") {
		if (record.change !== null || record.error !== null) {
			throw invalidResponse(endpoint);
		}
		return {
			...base,
			state,
			change: null,
			error: null,
		};
	}
	if (state === "failed") {
		if (
			record.change !== null ||
			typeof record.error !== "string" ||
			record.error.trim() === ""
		) {
			throw invalidResponse(endpoint);
		}
		return { ...base, state, change: null, error: record.error };
	}
	throw invalidResponse(endpoint);
}

function parseRetrievalModeCancellation(
	value: unknown
): RetrievalModeCancellation {
	const endpoint = "retrieval-mode cancellation";
	const record = requireRecord(value, endpoint);
	return { cancelled: requireBoolean(record, "cancelled", endpoint) };
}

// ---------------------------------------------------------------------------
// API class
// ---------------------------------------------------------------------------

export class SpacesAPI {
	private readonly options: RyuClientOptions;

	constructor(options: RyuClientOptions) {
		this.options = options;
	}

	/** List all Spaces, most-recently-updated first. */
	async list(): Promise<Space[]> {
		const data = await request<unknown>(this.options, "/api/spaces");
		const record = requireRecord(data, "spaces list");
		if (!Array.isArray(record.spaces)) {
			throw invalidResponse("spaces list");
		}
		return (record.spaces as SpaceWire[]).map(toSpace);
	}

	/** Create a Space. Omit `retrievalMode` to use Core's configured default. */
	async create(
		name: string,
		description: string | null = null,
		retrievalMode?: RetrievalMode
	): Promise<string> {
		const body: Record<string, unknown> = { name, description };
		if (retrievalMode !== undefined) {
			body.retrieval_mode = retrievalMode;
		}
		const data = requireRecord(
			await request<unknown>(this.options, "/api/spaces", {
				method: "POST",
				body: JSON.stringify(body),
			}),
			"create-space"
		);
		return requireString(data, "id", "create-space");
	}

	/** Start a retrieval-mode rebuild. Core accepts this operation with HTTP 202. */
	async startRetrievalModeChange(
		id: string,
		mode: RetrievalMode
	): Promise<RetrievalModeJob> {
		const data = await request<unknown>(
			this.options,
			`/api/spaces/${encodeURIComponent(id)}/retrieval-mode`,
			{
				method: "POST",
				body: JSON.stringify({ retrieval_mode: mode }),
			}
		);
		const job = parseRetrievalModeJob(data);
		const encodedId = encodeURIComponent(id);
		if (job.spaceId !== id || job.retrievalMode !== mode) {
			throw invalidResponse("retrieval-mode job");
		}
		return {
			...job,
			statusPath: `/api/spaces/${encodedId}/retrieval-mode/status?job_id=${encodeURIComponent(job.jobId)}`,
			cancelPath: `/api/spaces/${encodedId}/retrieval-mode/cancel`,
		};
	}

	/** Read the latest progress or terminal outcome for a mode-change job. */
	async getRetrievalModeStatus(
		id: string,
		jobId: string
	): Promise<RetrievalModeStatus> {
		const data = await request<unknown>(
			this.options,
			`/api/spaces/${encodeURIComponent(id)}/retrieval-mode/status?job_id=${encodeURIComponent(jobId)}`
		);
		const status = parseRetrievalModeStatus(data);
		if (status.spaceId !== id || status.jobId !== jobId) {
			throw invalidResponse("retrieval-mode status");
		}
		return status;
	}

	/** Request cooperative cancellation of a mode-change job. */
	async cancelRetrievalModeChange(
		id: string,
		jobId: string
	): Promise<RetrievalModeCancellation> {
		const data = await request<unknown>(
			this.options,
			`/api/spaces/${encodeURIComponent(id)}/retrieval-mode/cancel`,
			{
				method: "POST",
				body: JSON.stringify({ job_id: jobId }),
			}
		);
		return parseRetrievalModeCancellation(data);
	}

	/**
	 * Search a single Space, returning ranked chunk matches.
	 *
	 * **Not necessarily a KNN search** — as this comment used to say. Core's
	 * `search_ext` (`crates/core/spaces/src/lib.rs`) reads the Space's stored
	 * `retrieval_mode` and branches: `vector` runs a nearest-neighbour search over
	 * the `vec0` index, `graph` runs entity-matching plus a BFS traversal of the
	 * Space's co-occurrence graph. A graph Space can therefore answer a multi-hop
	 * question ("who at Acme is in Paris") that no single nearest-neighbour lookup
	 * answers. Anything that describes this call to a user — or to a model, via an
	 * MCP tool description — must not promise vector semantics.
	 *
	 * **The graph branch is bounded, and the bounds are lossy.** It walks at most 3
	 * hops and caps each hop's frontier at 512 entities, because the edges are
	 * co-occurrence (every pair of entities in a chunk is joined), so an unbounded
	 * hop-2 frontier is most of the Space. Core's own doc states that a chunk whose
	 * only path runs through a truncated frontier entity stops being reachable, and
	 * traversal also stops as soon as `limit` chunks are collected. Graph results
	 * are therefore neither a superset of vector results nor exhaustive: never
	 * present an empty result as "this Space contains nothing about X".
	 *
	 * **Both branches are then post-processed**, so the returned chunks are not only
	 * the retrieval hits: `[[page]]`-link expansion pulls in chunks from linked
	 * documents (fail-open), a tenancy filter drops documents the caller may not
	 * read, and a bge cross-encoder reranker re-orders what survives. See
	 * `SpaceMatch.distance` for what that does to the score field.
	 *
	 * Read the active mode from `Space.retrievalMode`; change it with
	 * `startRetrievalModeChange`, then poll `getRetrievalModeStatus` until the
	 * rebuild reaches a terminal state.
	 *
	 * @param id - Space id to search
	 * @param query - Natural language query string
	 * @param limit - Maximum number of chunks to return (default: Core decides)
	 */
	async search(
		id: string,
		query: string,
		limit?: number
	): Promise<SpaceMatch[]> {
		const body: Record<string, unknown> = { query };
		if (limit !== undefined) {
			body.limit = limit;
		}
		const data = await request<{ matches?: MatchWire[] }>(
			this.options,
			`/api/spaces/${id}/search`,
			{
				method: "POST",
				body: JSON.stringify(body),
			}
		);
		return (data.matches ?? []).map(toMatch);
	}
}
