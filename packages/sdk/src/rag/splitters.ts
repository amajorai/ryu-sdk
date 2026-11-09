/**
 * Text splitters, a TypeScript port of Core's `ryu_rag::splitter`.
 *
 * The strategy objects use the same snake_case wire shape Core accepts on
 * `PUT /api/spaces/:id/chunking`, so a strategy tested locally with
 * {@link splitText} can be sent to a Space unchanged and produces the same
 * chunks there (character counts are Unicode code points on both sides).
 */

/** Chunk size of the historical (default) splitter, in characters. */
export const DEFAULT_CHUNK_CHARS = 1000;
/** Upper bound on any configured chunk size (characters or tokens). */
export const MAX_CHUNK_SIZE = 32_000;
/** Most sentences the semantic splitter embeds for one document. */
export const MAX_SEMANTIC_SENTENCES = 2048;
/** Separators the recursive splitter tries, coarsest first. `""` splits characters. */
export const DEFAULT_SEPARATORS: readonly string[] = [
	"\n\n",
	"\n",
	". ",
	"? ",
	"! ",
	"; ",
	", ",
	" ",
	"",
];
const MARKDOWN_SEPARATORS: readonly string[] = [
	"\n```",
	"\n~~~",
	"\n---\n",
	...DEFAULT_SEPARATORS,
];

/** How a document is cut into chunks. Matches Core's `ChunkingStrategy` JSON. */
export type ChunkingStrategy =
	| { strategy: "default" }
	| {
			strategy: "recursive";
			chunk_size?: number;
			chunk_overlap?: number;
			separators?: string[];
	  }
	| {
			strategy: "markdown";
			chunk_size?: number;
			chunk_overlap?: number;
			include_header_path?: boolean;
	  }
	| { strategy: "token"; chunk_size?: number; chunk_overlap?: number }
	| {
			strategy: "semantic";
			breakpoint_percentile?: number;
			buffer_size?: number;
			max_chunk_size?: number;
	  };

/** Metadata attached to one chunk. */
export interface ChunkMetadata {
	/** Markdown headers above the chunk, outermost first (markdown strategy). */
	headerPath: string[];
	/** Position of the chunk in its document, 0-based. */
	index: number;
	/** Approximate token count ({@link approxTokenCount}). */
	tokenCount: number;
}

/** One chunk produced by a splitter. */
export interface TextChunk {
	content: string;
	metadata: ChunkMetadata;
}

/** Embeds a batch of texts, one vector per input in input order. */
export type EmbedBatch = (texts: string[]) => Promise<number[][]>;

type LengthFn = (text: string) => number;

const charLength: LengthFn = (text) => Array.from(text).length;
const ALNUM = /[\p{L}\p{N}]/u;
const WHITESPACE = /\s/u;
const WHITESPACE_RUN = /\s+/u;

/**
 * Reject configurations that cannot produce sensible chunks (Core applies the
 * same rules). Throws a `RangeError` describing the first problem.
 */
export function validateStrategy(strategy: ChunkingStrategy): void {
	const checkSize = (size: number, overlap: number) => {
		if (!Number.isInteger(size) || size < 1 || size > MAX_CHUNK_SIZE) {
			throw new RangeError(
				`chunk_size must be between 1 and ${MAX_CHUNK_SIZE}`
			);
		}
		if (!Number.isInteger(overlap) || overlap < 0 || overlap >= size) {
			throw new RangeError(
				`chunk_overlap (${overlap}) must be smaller than chunk_size (${size})`
			);
		}
	};
	switch (strategy.strategy) {
		case "default":
			return;
		case "recursive": {
			const r = resolved(strategy);
			checkSize(r.size, r.overlap);
			if (
				strategy.separators !== undefined &&
				(strategy.separators.length === 0 || strategy.separators.length > 32)
			) {
				throw new RangeError("separators must list between 1 and 32 entries");
			}
			return;
		}
		case "markdown":
		case "token": {
			const r = resolved(strategy);
			checkSize(r.size, r.overlap);
			return;
		}
		case "semantic": {
			const percentile = strategy.breakpoint_percentile ?? 95;
			if (!Number.isFinite(percentile) || percentile < 0 || percentile > 100) {
				throw new RangeError("breakpoint_percentile must be between 0 and 100");
			}
			if ((strategy.buffer_size ?? 1) > 8) {
				throw new RangeError("buffer_size must be at most 8");
			}
			checkSize(strategy.max_chunk_size ?? 2000, 0);
			return;
		}
		default:
			throw new RangeError("unknown chunking strategy");
	}
}

function resolved(
	strategy: Exclude<
		ChunkingStrategy,
		{ strategy: "default" } | { strategy: "semantic" }
	>
): { size: number; overlap: number } {
	if (strategy.strategy === "token") {
		return {
			size: strategy.chunk_size ?? 256,
			overlap: strategy.chunk_overlap ?? 32,
		};
	}
	return {
		size: strategy.chunk_size ?? DEFAULT_CHUNK_CHARS,
		overlap: strategy.chunk_overlap ?? 200,
	};
}

/**
 * Deterministic approximation of a GPT-style BPE token count: each run of
 * letters/digits costs `ceil(chars / 4)` tokens, every other non-whitespace
 * character one token, whitespace nothing.
 */
export function approxTokenCount(text: string): number {
	let tokens = 0;
	let run = 0;
	for (const ch of text) {
		if (ALNUM.test(ch)) {
			run += 1;
			continue;
		}
		if (run > 0) {
			tokens += Math.ceil(run / 4);
			run = 0;
		}
		if (!WHITESPACE.test(ch)) {
			tokens += 1;
		}
	}
	if (run > 0) {
		tokens += Math.ceil(run / 4);
	}
	return tokens;
}

/** The historical splitter: paragraphs packed word by word up to `size` characters. */
export function legacyWordChunks(content: string, size: number): string[] {
	const trimmed = content.trim();
	if (trimmed === "") {
		return [""];
	}
	const chunks: string[] = [];
	let current = "";
	let currentLength = 0;
	for (const paragraph of trimmed.split("\n\n")) {
		for (const word of paragraph.split(WHITESPACE_RUN)) {
			if (word === "") {
				continue;
			}
			const characters = Array.from(word);
			if (characters.length > size) {
				if (current !== "") {
					chunks.push(current);
					current = "";
					currentLength = 0;
				}
				let piece: string[] = [];
				for (const character of characters) {
					piece.push(character);
					if (piece.length === size) {
						chunks.push(piece.join(""));
						piece = [];
					}
				}
				if (piece.length > 0) {
					current = piece.join("");
					currentLength = piece.length;
				}
				continue;
			}
			if (currentLength + characters.length + 1 > size && current !== "") {
				chunks.push(current);
				current = "";
				currentLength = 0;
			}
			if (current !== "") {
				current += " ";
				currentLength += 1;
			}
			current += word;
			currentLength += characters.length;
		}
		if (current !== "") {
			chunks.push(current);
			current = "";
			currentLength = 0;
		}
	}
	if (chunks.length === 0) {
		chunks.push(trimmed);
	}
	return chunks;
}

/**
 * Recursive splitter: cut on the first separator present, recurse into pieces
 * still longer than `chunkSize`, and pack the rest into windows overlapping by
 * `chunkOverlap`. `length` measures a piece (characters by default).
 */
export function splitRecursive(
	text: string,
	options: {
		chunkSize: number;
		chunkOverlap?: number;
		separators?: readonly string[];
		length?: LengthFn;
	}
): string[] {
	const chunkSize = Math.max(1, options.chunkSize);
	const chunkOverlap = Math.min(
		Math.max(0, options.chunkOverlap ?? 0),
		chunkSize - 1
	);
	const out: string[] = [];
	recurse(
		text,
		options.separators ?? DEFAULT_SEPARATORS,
		chunkSize,
		chunkOverlap,
		options.length ?? charLength,
		out
	);
	return out;
}

function recurse(
	text: string,
	separators: readonly string[],
	chunkSize: number,
	chunkOverlap: number,
	length: LengthFn,
	out: string[]
): void {
	if (text.trim() === "") {
		return;
	}
	let separator = "";
	let rest: readonly string[] = [];
	for (const [index, candidate] of separators.entries()) {
		if (candidate === "") {
			break;
		}
		if (text.includes(candidate)) {
			separator = candidate;
			rest = separators.slice(index + 1);
			break;
		}
	}
	const good: string[] = [];
	for (const piece of splitKeepSeparator(text, separator)) {
		if (length(piece) <= chunkSize) {
			good.push(piece);
			continue;
		}
		if (good.length > 0) {
			mergeSplits(good, chunkSize, chunkOverlap, length, out);
			good.length = 0;
		}
		if (separator === "") {
			const trimmed = piece.trim();
			if (trimmed !== "") {
				out.push(trimmed);
			}
		} else if (rest.length === 0) {
			recurse(piece, [""], chunkSize, chunkOverlap, length, out);
		} else {
			recurse(piece, rest, chunkSize, chunkOverlap, length, out);
		}
	}
	if (good.length > 0) {
		mergeSplits(good, chunkSize, chunkOverlap, length, out);
	}
}

function splitKeepSeparator(text: string, separator: string): string[] {
	if (separator === "") {
		return Array.from(text);
	}
	const pieces: string[] = [];
	let start = 0;
	let at = text.indexOf(separator, start);
	while (at !== -1) {
		const end = at + separator.length;
		pieces.push(text.slice(start, end));
		start = end;
		at = text.indexOf(separator, start);
	}
	if (start < text.length) {
		pieces.push(text.slice(start));
	}
	return pieces;
}

function mergeSplits(
	pieces: readonly string[],
	chunkSize: number,
	chunkOverlap: number,
	length: LengthFn,
	out: string[]
): void {
	const window: string[] = [];
	let total = 0;
	const emit = () => {
		const trimmed = window.join("").trim();
		if (trimmed !== "") {
			out.push(trimmed);
		}
	};
	for (const piece of pieces) {
		const pieceLength = length(piece);
		if (total + pieceLength > chunkSize && window.length > 0) {
			emit();
			while (window.length > 0) {
				if (
					total > chunkOverlap ||
					(total + pieceLength > chunkSize && total > 0)
				) {
					total -= length(window[0] ?? "");
					window.shift();
				} else {
					break;
				}
			}
		}
		window.push(piece);
		total += pieceLength;
	}
	if (window.length > 0) {
		emit();
	}
}

interface MarkdownSection {
	body: string;
	headerPath: string[];
}

function rustLines(text: string): string[] {
	const lines = text.split("\n");
	if (lines.at(-1) === "") {
		lines.pop();
	}
	return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function parseAtxHeader(line: string): [number, string] | undefined {
	const indent = line.length - line.replace(/^ +/u, "").length;
	if (indent > 3) {
		return;
	}
	const rest = line.slice(indent);
	const level = rest.length - rest.replace(/^#+/u, "").length;
	if (level < 1 || level > 6) {
		return;
	}
	const after = rest.slice(level);
	if (after !== "" && !(after.startsWith(" ") || after.startsWith("\t"))) {
		return;
	}
	const title = after.trim().replace(/#+$/u, "").trim();
	return title === "" ? undefined : [level, title];
}

function markdownSections(text: string): MarkdownSection[] {
	const sections: MarkdownSection[] = [];
	const stack: [number, string][] = [];
	let body = "";
	let fence: string | undefined;
	const flush = () => {
		if (body.trim() !== "") {
			sections.push({ headerPath: stack.map(([, title]) => title), body });
		}
		body = "";
	};
	for (const line of rustLines(text)) {
		const trimmed = line.trimStart();
		if (fence !== undefined) {
			if (trimmed.startsWith(fence)) {
				fence = undefined;
			}
			body += `${line}\n`;
			continue;
		}
		if (trimmed.startsWith("```")) {
			fence = "```";
		} else if (trimmed.startsWith("~~~")) {
			fence = "~~~";
		} else {
			const header = parseAtxHeader(line);
			if (header !== undefined) {
				flush();
				const [level, title] = header;
				while (stack.length > 0 && (stack.at(-1)?.[0] ?? 0) >= level) {
					stack.pop();
				}
				stack.push([level, title]);
				continue;
			}
		}
		body += `${line}\n`;
	}
	flush();
	return sections;
}

function splitMarkdown(
	text: string,
	chunkSize: number,
	chunkOverlap: number,
	includeHeaderPath: boolean
): [string, string[]][] {
	const out: [string, string[]][] = [];
	for (const section of markdownSections(text)) {
		const prefix =
			includeHeaderPath && section.headerPath.length > 0
				? `${section.headerPath.join(" > ")}\n\n`
				: "";
		const budget = Math.max(
			Math.max(chunkSize - charLength(prefix), 0),
			Math.floor(chunkSize / 2),
			1
		);
		const overlap = Math.min(chunkOverlap, budget - 1);
		for (const piece of splitRecursive(section.body, {
			chunkSize: budget,
			chunkOverlap: overlap,
			separators: MARKDOWN_SEPARATORS,
		})) {
			out.push([`${prefix}${piece}`, section.headerPath]);
		}
	}
	return out;
}

function finish(pieces: [string, string[]][]): TextChunk[] {
	const chunks = pieces
		.filter(([content]) => content.trim() !== "")
		.map(([content, headerPath], index) => ({
			content,
			metadata: { index, headerPath, tokenCount: approxTokenCount(content) },
		}));
	if (chunks.length === 0) {
		chunks.push({
			content: "",
			metadata: { index: 0, headerPath: [], tokenCount: 0 },
		});
	}
	return chunks;
}

const plain = (pieces: string[]): [string, string[]][] =>
	pieces.map((piece) => [piece, []]);

/**
 * Split `text` with a synchronous strategy. The semantic strategy needs an
 * embedder; here it degrades to recursive splitting at its `max_chunk_size`
 * (use {@link splitTextWithEmbedder}). Always returns at least one chunk.
 */
export function splitText(
	text: string,
	strategy: ChunkingStrategy = { strategy: "default" }
): TextChunk[] {
	validateStrategy(strategy);
	switch (strategy.strategy) {
		case "default":
			return finish(plain(legacyWordChunks(text, DEFAULT_CHUNK_CHARS)));
		case "recursive": {
			const { size, overlap } = resolved(strategy);
			return finish(
				plain(
					splitRecursive(text, {
						chunkSize: size,
						chunkOverlap: overlap,
						separators: strategy.separators ?? DEFAULT_SEPARATORS,
					})
				)
			);
		}
		case "markdown": {
			const { size, overlap } = resolved(strategy);
			return finish(
				splitMarkdown(text, size, overlap, strategy.include_header_path ?? true)
			);
		}
		case "token": {
			const { size, overlap } = resolved(strategy);
			return finish(
				plain(
					splitRecursive(text, {
						chunkSize: size,
						chunkOverlap: overlap,
						length: approxTokenCount,
					})
				)
			);
		}
		default:
			return finish(
				plain(
					splitRecursive(text, { chunkSize: strategy.max_chunk_size ?? 2000 })
				)
			);
	}
}

/** Split prose into sentences on `.`, `!`, `?` followed by whitespace, and on blank lines. */
export function splitSentences(text: string): string[] {
	const sentences: string[] = [];
	const push = (raw: string) => {
		const sentence = raw.trim();
		if (sentence !== "") {
			sentences.push(sentence.split(WHITESPACE_RUN).join(" "));
		}
	};
	for (const paragraph of text.split("\n\n")) {
		const chars = Array.from(paragraph);
		let current = "";
		for (const [index, ch] of chars.entries()) {
			current += ch;
			const next = chars[index + 1];
			if (
				(ch === "." || ch === "!" || ch === "?") &&
				(next === undefined || WHITESPACE.test(next))
			) {
				push(current);
				current = "";
			}
		}
		push(current);
	}
	return sentences;
}

function cosine(a: readonly number[], b: readonly number[]): number {
	if (a.length !== b.length || a.length === 0) {
		return 0;
	}
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (const [i, x] of a.entries()) {
		const y = b[i] ?? 0;
		dot += x * y;
		normA += x * x;
		normB += y * y;
	}
	return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

function percentile(values: number[], pct: number): number {
	if (values.length === 0) {
		return Number.POSITIVE_INFINITY;
	}
	const sorted = [...values].sort((a, b) => a - b);
	const rank = (Math.min(Math.max(pct, 0), 100) / 100) * (sorted.length - 1);
	const lower = sorted[Math.floor(rank)] ?? 0;
	const upper = sorted[Math.ceil(rank)] ?? lower;
	return lower + (upper - lower) * (rank - Math.floor(rank));
}

/**
 * Split `text` with any strategy. For `semantic`, sentences (with
 * `buffer_size` neighbours) are embedded through `embed` and a chunk boundary
 * is placed wherever the cosine distance between consecutive sentences exceeds
 * the `breakpoint_percentile` of all such distances.
 */
export async function splitTextWithEmbedder(
	text: string,
	strategy: ChunkingStrategy,
	embed: EmbedBatch
): Promise<TextChunk[]> {
	if (strategy.strategy !== "semantic") {
		return splitText(text, strategy);
	}
	validateStrategy(strategy);
	const bufferSize = strategy.buffer_size ?? 1;
	const maxChunkSize = strategy.max_chunk_size ?? 2000;
	const sentences = splitSentences(text);
	if (sentences.length <= 1 || sentences.length > MAX_SEMANTIC_SENTENCES) {
		return splitText(text, strategy);
	}
	const windows = sentences.map((_, i) =>
		sentences
			.slice(
				Math.max(0, i - bufferSize),
				Math.min(sentences.length, i + bufferSize + 1)
			)
			.join(" ")
	);
	const vectors: number[][] = [];
	for (let start = 0; start < windows.length; start += 256) {
		vectors.push(...(await embed(windows.slice(start, start + 256))));
	}
	if (vectors.length !== sentences.length) {
		throw new Error(
			`embedder returned ${vectors.length} vectors for ${sentences.length} sentences`
		);
	}
	const distances = vectors
		.slice(1)
		.map((vector, i) => 1 - cosine(vectors[i] ?? [], vector));
	const threshold = percentile(distances, strategy.breakpoint_percentile ?? 95);
	const groups: string[] = [];
	let current: string[] = [sentences[0] ?? ""];
	for (const [i, distance] of distances.entries()) {
		if (distance > threshold) {
			groups.push(current.join(" "));
			current = [];
		}
		current.push(sentences[i + 1] ?? "");
	}
	if (current.length > 0) {
		groups.push(current.join(" "));
	}
	const pieces: [string, string[]][] = [];
	for (const group of groups) {
		if (charLength(group) <= maxChunkSize) {
			pieces.push([group, []]);
		} else {
			pieces.push(...plain(splitRecursive(group, { chunkSize: maxChunkSize })));
		}
	}
	return finish(pieces);
}
