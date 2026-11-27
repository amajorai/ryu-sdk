/**
 * `@ryuhq/sdk/rag` — retrieval helpers that run anywhere, with Core's
 * semantics: text splitters (recursive, markdown-header, token, semantic),
 * the metadata filter language, and weighted reciprocal rank fusion.
 */

export type {
	FieldOperators,
	FilterValue,
	MetadataFilter,
} from "./filter.ts";
export {
	MAX_FILTER_DEPTH,
	MAX_FILTER_NODES,
	MAX_IN_VALUES,
	matchesFilter,
	validateFilter,
} from "./filter.ts";
export type { FusedItem, WeightedList } from "./fusion.ts";
export { RRF_K, weightedRrf } from "./fusion.ts";
export type {
	ChunkingStrategy,
	ChunkMetadata,
	EmbedBatch,
	TextChunk,
} from "./splitters.ts";
export {
	approxTokenCount,
	DEFAULT_CHUNK_CHARS,
	DEFAULT_SEPARATORS,
	legacyWordChunks,
	MAX_CHUNK_SIZE,
	MAX_SEMANTIC_SENTENCES,
	splitRecursive,
	splitSentences,
	splitText,
	splitTextWithEmbedder,
	validateStrategy,
} from "./splitters.ts";
