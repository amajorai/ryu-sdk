// packages/core-client/src/spaces.ts
//
// Typed client for Core's Spaces / RAG endpoints (`/api/spaces`). A Space is a
// named document collection backed by a sqlite-vec vector store; documents are
// ingested (chunked + embedded) and searched by whichever retrieval algorithm
// the Space is set to — vector KNN or entity-graph traversal — after which hits
// are link-expanded and neurally reranked. See {@link searchSpace}. Wire shapes
// mirror the Core handlers in `apps/core/src/server/{mod,spaces}.rs`
// (snake_case on the wire).

import { type ApiTarget, request } from "./client.ts";

/** The retrieval algorithm Core uses for a Space. */
export type RetrievalMode = "graph" | "vector";

/** A named document collection. `documentCount` is computed by Core. */
export interface Space {
	/** Unix milliseconds. */
	createdAt: number;
	description: string | null;
	documentCount: number;
	/** Notion-style glyph JSON (GlyphValue), when set. */
	icon: unknown | null;
	id: string;
	name: string;
	retrievalMode: RetrievalMode;
	/** Unix milliseconds. */
	updatedAt: number;
}

/** A document inside a Space, with its chunk count. */
export interface SpaceDocument {
	chunkCount: number;
	/** Unix milliseconds. */
	createdAt: number;
	/** Notion-style glyph JSON (GlyphValue), when set. */
	icon: unknown | null;
	id: string;
	spaceId: string;
	title: string;
	/** Unix milliseconds. */
	updatedAt: number;
}

/** A single ranked chunk returned from a Space search. */
export interface SpaceMatch {
	chunkId: string;
	content: string;
	/**
	 * **Do not rank on this field, and do not read magnitudes off it.** It used to
	 * be documented as "squared L2 distance from the query vector", which is only
	 * ever true of one of the three ways a chunk can end up in this array:
	 *
	 * - a vector-mode KNN hit carries its real `vec0` distance (smaller is closer);
	 * - a graph-mode traversal hit is assigned the constant `0.0`;
	 * - a chunk pulled in by `[[page]]`-link expansion (which runs in **both**
	 *   modes) is assigned the constant `1.0`.
	 *
	 * The last two are placeholders, not measurements. On top of that Core's bge
	 * reranker re-orders the survivors **without rewriting `distance`**, so array
	 * order — not this number — is the ranking. Sorting by `distance` un-does the
	 * rerank; averaging or thresholding it mixes a metric with two constants.
	 */
	distance: number;
	documentId: string;
}

interface SpaceWire {
	created_at: number;
	description?: string | null;
	document_count: number;
	icon?: unknown | null;
	id: string;
	name: string;
	retrieval_mode?: string;
	updated_at: number;
}

interface DocumentWire {
	chunk_count: number;
	created_at: number;
	icon?: unknown | null;
	id: string;
	space_id: string;
	title: string;
	updated_at?: number;
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

function toSpace(s: SpaceWire): Space {
	return {
		id: s.id,
		name: s.name,
		description: s.description ?? null,
		createdAt: s.created_at,
		updatedAt: s.updated_at,
		documentCount: s.document_count,
		icon: s.icon ?? null,
		retrievalMode: toRetrievalMode(s.retrieval_mode),
	};
}

function toDocument(d: DocumentWire): SpaceDocument {
	return {
		id: d.id,
		spaceId: d.space_id,
		title: d.title,
		createdAt: d.created_at,
		updatedAt: d.updated_at ?? d.created_at,
		chunkCount: d.chunk_count,
		icon: d.icon ?? null,
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
	return new Error(`Core returned an invalid ${endpoint} response`);
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

/** List all Spaces, most-recently-updated first. */
export async function fetchSpaces(target: ApiTarget): Promise<Space[]> {
	const json = requireRecord(
		await request<unknown>(target, "/api/spaces"),
		"spaces list"
	);
	if (!Array.isArray(json.spaces)) {
		throw invalidResponse("spaces list");
	}
	return (json.spaces as SpaceWire[]).map(toSpace);
}

/** Create a new Space and return its id. */
export async function createSpace(
	target: ApiTarget,
	name: string,
	description: string | null,
	retrievalMode?: RetrievalMode
): Promise<string> {
	const body: Record<string, unknown> = { name, description };
	if (retrievalMode !== undefined) {
		body.retrieval_mode = retrievalMode;
	}
	const json = requireRecord(
		await request<unknown>(target, "/api/spaces", {
			method: "POST",
			body,
		}),
		"create-space"
	);
	return requireString(json, "id", "create-space");
}

/** Start a retrieval-mode rebuild. Core accepts this operation with HTTP 202. */
export async function startSpaceRetrievalModeChange(
	target: ApiTarget,
	id: string,
	mode: RetrievalMode
): Promise<RetrievalModeJob> {
	const json = await request<unknown>(
		target,
		`/api/spaces/${encodeURIComponent(id)}/retrieval-mode`,
		{ method: "POST", body: { retrieval_mode: mode } }
	);
	const job = parseRetrievalModeJob(json);
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
export async function fetchSpaceRetrievalModeStatus(
	target: ApiTarget,
	id: string,
	jobId: string
): Promise<RetrievalModeStatus> {
	const json = await request<unknown>(
		target,
		`/api/spaces/${encodeURIComponent(id)}/retrieval-mode/status?job_id=${encodeURIComponent(jobId)}`
	);
	const status = parseRetrievalModeStatus(json);
	if (status.spaceId !== id || status.jobId !== jobId) {
		throw invalidResponse("retrieval-mode status");
	}
	return status;
}

/** Request cooperative cancellation of a mode-change job. */
export async function cancelSpaceRetrievalModeChange(
	target: ApiTarget,
	id: string,
	jobId: string
): Promise<RetrievalModeCancellation> {
	const json = await request<unknown>(
		target,
		`/api/spaces/${encodeURIComponent(id)}/retrieval-mode/cancel`,
		{ method: "POST", body: { job_id: jobId } }
	);
	return parseRetrievalModeCancellation(json);
}

/** Delete a Space and everything in it. Returns whether a row was removed. */
export async function deleteSpace(
	target: ApiTarget,
	id: string
): Promise<boolean> {
	const json = await request<{ removed?: boolean }>(
		target,
		`/api/spaces/${id}`,
		{
			method: "DELETE",
		}
	);
	return json?.removed ?? false;
}

/** Set or clear a Space glyph (`POST /api/spaces/:id/icon`). */
export async function setSpaceIcon(
	target: ApiTarget,
	id: string,
	icon: unknown | null
): Promise<void> {
	await request(target, `/api/spaces/${id}/icon`, {
		method: "POST",
		body: { icon },
	});
}

/** Set or clear a document glyph without re-embedding. */
export async function setDocumentIcon(
	target: ApiTarget,
	spaceId: string,
	documentId: string,
	icon: unknown | null
): Promise<void> {
	await request(target, `/api/spaces/${spaceId}/documents/${documentId}/icon`, {
		method: "POST",
		body: { icon },
	});
}

/** List the documents in a Space. */
export async function fetchDocuments(
	target: ApiTarget,
	spaceId: string
): Promise<SpaceDocument[]> {
	const json = await request<{ documents?: DocumentWire[] }>(
		target,
		`/api/spaces/${spaceId}/documents`
	);
	return (json.documents ?? []).map(toDocument);
}

/** Ingest a document into a Space. Returns the new document id. */
export async function ingestDocument(
	target: ApiTarget,
	spaceId: string,
	title: string,
	content: string
): Promise<string> {
	const json = await request<{ document_id: string }>(
		target,
		`/api/spaces/${spaceId}/documents`,
		{
			method: "POST",
			body: { title, content },
		}
	);
	return json.document_id;
}

/** Full editable content of a document (Notion-like page). */
export interface SpaceDocumentContent {
	chunkCount: number;
	/** Unix milliseconds. */
	createdAt: number;
	/** Notion-style glyph JSON (GlyphValue), when set. */
	icon: unknown | null;
	id: string;
	/** Canonical markdown source of the page. */
	source: string;
	spaceId: string;
	title: string;
	/** Unix milliseconds. */
	updatedAt: number;
}

interface DocumentContentWire {
	chunk_count: number;
	created_at: number;
	icon?: unknown | null;
	id: string;
	source: string;
	space_id: string;
	title: string;
	updated_at: number;
}

function toDocumentContent(d: DocumentContentWire): SpaceDocumentContent {
	return {
		id: d.id,
		spaceId: d.space_id,
		title: d.title,
		source: d.source,
		createdAt: d.created_at,
		updatedAt: d.updated_at,
		chunkCount: d.chunk_count,
		icon: d.icon ?? null,
	};
}

/** Create a new blank markdown page in a Space. Returns the new document id. */
export async function createPage(
	target: ApiTarget,
	spaceId: string,
	title: string
): Promise<string> {
	const json = await request<{ id: string }>(
		target,
		`/api/spaces/${spaceId}/pages`,
		{ method: "POST", body: { title } }
	);
	return json.id;
}

/** Fetch a single document's full markdown source for editing. */
export async function fetchDocument(
	target: ApiTarget,
	spaceId: string,
	documentId: string
): Promise<SpaceDocumentContent> {
	const json = await request<DocumentContentWire>(
		target,
		`/api/spaces/${spaceId}/documents/${documentId}`
	);
	return toDocumentContent(json);
}

/**
 * Save a document's markdown source. Core re-chunks + re-embeds on save, so this
 * is the persistence + index trigger. Callers should debounce.
 */
export async function updateDocument(
	target: ApiTarget,
	spaceId: string,
	documentId: string,
	title: string,
	source: string
): Promise<void> {
	await request(target, `/api/spaces/${spaceId}/documents/${documentId}`, {
		method: "PUT",
		body: { title, source },
	});
}

/** Delete a single document (page) and its chunks/vectors. */
export async function deleteDocument(
	target: ApiTarget,
	spaceId: string,
	documentId: string
): Promise<boolean> {
	const json = await request<{ removed?: boolean }>(
		target,
		`/api/spaces/${spaceId}/documents/${documentId}`,
		{ method: "DELETE" }
	);
	return json?.removed ?? false;
}

/** Reindex progress reported by Core. */
export interface ReindexStatus {
	currentDims: number;
	currentModel: string;
	pendingChunks: number;
	running: boolean;
	totalChunks: number;
}

interface ReindexStatusWire {
	current_dims: number;
	current_model: string;
	pending_chunks: number;
	running: boolean;
	total_chunks: number;
}

/** Get the current embedding-reindex status (how many chunks are stale). */
export async function fetchReindexStatus(
	target: ApiTarget
): Promise<ReindexStatus> {
	const json = await request<ReindexStatusWire>(
		target,
		"/api/embeddings/reindex/status"
	);
	return {
		currentModel: json.current_model,
		currentDims: json.current_dims,
		totalChunks: json.total_chunks,
		pendingChunks: json.pending_chunks,
		running: json.running,
	};
}

/** Kick off a background reindex of all stale chunks. Returns immediately. */
export async function triggerReindex(target: ApiTarget): Promise<void> {
	await request(target, "/api/embeddings/reindex", { method: "POST" });
}

/** The embedding model Spaces currently uses. */
export interface EmbeddingModel {
	baseUrl: string;
	dims: number;
	modelId: string;
}

interface EmbeddingModelWire {
	base_url: string;
	dims: number;
	model_id: string;
}

/** Read the active embedding model. */
export async function fetchEmbeddingModel(
	target: ApiTarget
): Promise<EmbeddingModel> {
	const json = await request<EmbeddingModelWire>(
		target,
		"/api/embeddings/model"
	);
	return { modelId: json.model_id, baseUrl: json.base_url, dims: json.dims };
}

/**
 * Change the default embedding model. Core persists it and auto-triggers a
 * background reindex of every existing chunk (old vectors live in an
 * incomparable space and must be re-embedded).
 */
export async function setEmbeddingModel(
	target: ApiTarget,
	modelId: string,
	baseUrl?: string,
	dims?: number,
	provider?: string
): Promise<void> {
	const body: Record<string, unknown> = { model_id: modelId };
	if (baseUrl !== undefined) {
		body.base_url = baseUrl;
	}
	if (dims !== undefined) {
		body.dims = dims;
	}
	if (provider !== undefined) {
		body.provider = provider;
	}
	await request(target, "/api/embeddings/model", { method: "POST", body });
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
 * {@link SpaceMatch.distance} for what that does to the score field.
 */
export async function searchSpace(
	target: ApiTarget,
	spaceId: string,
	query: string,
	limit?: number
): Promise<SpaceMatch[]> {
	const body: Record<string, unknown> = { query };
	if (limit !== undefined) {
		body.limit = limit;
	}
	const json = await request<{ matches?: MatchWire[] }>(
		target,
		`/api/spaces/${spaceId}/search`,
		{ method: "POST", body }
	);
	return (json.matches ?? []).map(toMatch);
}
