import { describe, expect, test } from "bun:test";
import {
	approxTokenCount,
	DEFAULT_CHUNK_CHARS,
	legacyWordChunks,
	type MetadataFilter,
	matchesFilter,
	splitRecursive,
	splitSentences,
	splitText,
	splitTextWithEmbedder,
	validateFilter,
	validateStrategy,
	weightedRrf,
} from "./index.ts";

const contents = (chunks: { content: string }[]) =>
	chunks.map((c) => c.content);

/** Bag-of-words embedder: one dimension per distinct lowercased word. */
function bagOfWords(texts: string[]): Promise<number[][]> {
	const vocabulary = new Map<string, number>();
	const tokenized = texts.map((text) =>
		text
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter((word) => word !== "")
	);
	for (const words of tokenized) {
		for (const word of words) {
			if (!vocabulary.has(word)) {
				vocabulary.set(word, vocabulary.size);
			}
		}
	}
	return Promise.resolve(
		tokenized.map((words) => {
			const vector = new Array<number>(vocabulary.size).fill(0);
			for (const word of words) {
				const index = vocabulary.get(word) ?? 0;
				vector[index] = (vector[index] ?? 0) + 1;
			}
			return vector;
		})
	);
}

describe("splitters", () => {
	test("default strategy is the historical word splitter", () => {
		const text = `${"word ".repeat(400)}\n\nshort tail`;
		const chunks = splitText(text);
		expect(contents(chunks)).toEqual(
			legacyWordChunks(text, DEFAULT_CHUNK_CHARS)
		);
		for (const chunk of chunks) {
			expect(Array.from(chunk.content).length).toBeLessThanOrEqual(
				DEFAULT_CHUNK_CHARS
			);
		}
	});

	test("blank input yields one empty chunk", () => {
		for (const strategy of [
			{ strategy: "default" } as const,
			{ strategy: "recursive", chunk_size: 10, chunk_overlap: 2 } as const,
			{ strategy: "markdown", chunk_size: 10, chunk_overlap: 2 } as const,
		]) {
			expect(contents(splitText("   \n", strategy))).toEqual([""]);
		}
	});

	test("recursive prefers paragraph boundaries", () => {
		const chunks = splitText(
			"Alpha paragraph one.\n\nBeta paragraph two.\n\nGamma paragraph three.",
			{ strategy: "recursive", chunk_size: 25, chunk_overlap: 0 }
		);
		expect(contents(chunks)).toEqual([
			"Alpha paragraph one.",
			"Beta paragraph two.",
			"Gamma paragraph three.",
		]);
	});

	test("recursive overlap repeats trailing context", () => {
		const chunks = splitRecursive(
			"one two three four five six seven eight nine ten",
			{
				chunkSize: 20,
				chunkOverlap: 10,
			}
		);
		expect(chunks.length).toBeGreaterThan(2);
		for (const [i, chunk] of chunks.entries()) {
			expect(chunk.length).toBeLessThanOrEqual(20);
			const previous = chunks[i - 1];
			if (previous !== undefined) {
				expect(chunk).toContain(previous.split(" ").at(-1) ?? "");
			}
		}
	});

	test("recursive falls back to characters and honours custom separators", () => {
		expect(splitRecursive("x".repeat(25), { chunkSize: 10 })).toEqual([
			"x".repeat(10),
			"x".repeat(10),
			"x".repeat(5),
		]);
		expect(
			contents(
				splitText("a|b|c|d", {
					strategy: "recursive",
					chunk_size: 2,
					chunk_overlap: 0,
					separators: ["|"],
				})
			)
		).toEqual(["a|", "b|", "c|", "d"]);
	});

	test("markdown chunks carry their header path", () => {
		const text =
			"Intro text.\n\n# Guide\n\nGuide body.\n\n## Install\n\nRun the installer.\n\n```sh\n# not a header\nmake\n```\n\n## Usage\n\nUse it.\n\n# Reference\n\nAPI list.";
		const chunks = splitText(text, {
			strategy: "markdown",
			chunk_size: 500,
			chunk_overlap: 0,
			include_header_path: false,
		});
		expect(chunks.map((c) => c.metadata.headerPath)).toEqual([
			[],
			["Guide"],
			["Guide", "Install"],
			["Guide", "Usage"],
			["Reference"],
		]);
		expect(chunks[2]?.content).toContain("# not a header");
		expect(chunks[3]?.content).toBe("Use it.");
		expect(chunks.map((c) => c.metadata.index)).toEqual([0, 1, 2, 3, 4]);
	});

	test("markdown breadcrumb prefix fits the budget", () => {
		const chunks = splitText(`# Top\n## Sub\n\n${"lorem ipsum ".repeat(30)}`, {
			strategy: "markdown",
			chunk_size: 80,
			chunk_overlap: 0,
		});
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.content.startsWith("Top > Sub\n\n")).toBe(true);
			expect(chunk.content.length).toBeLessThanOrEqual(80);
		}
	});

	test("token strategy bounds chunks by approximate tokens", () => {
		const chunks = splitText(
			"The quick brown fox jumps over the lazy dog. ".repeat(40),
			{
				strategy: "token",
				chunk_size: 30,
				chunk_overlap: 5,
			}
		);
		expect(chunks.length).toBeGreaterThan(5);
		for (const chunk of chunks) {
			expect(chunk.metadata.tokenCount).toBeLessThanOrEqual(30);
		}
	});

	test("approximate token counts match Core", () => {
		expect(approxTokenCount("")).toBe(0);
		expect(approxTokenCount("hello")).toBe(2);
		expect(approxTokenCount("a, b!")).toBe(4);
		expect(approxTokenCount("internationalization")).toBe(5);
	});

	test("sentences split on terminal punctuation", () => {
		expect(splitSentences("One. Two!  Three?\n\nFour 3.5 five")).toEqual([
			"One.",
			"Two!",
			"Three?",
			"Four 3.5 five",
		]);
	});

	test("semantic strategy breaks where the topic changes", async () => {
		const text =
			"Rust ownership borrow checker. Rust ownership lifetimes borrow. Rust borrow checker ownership rules. Baking bread flour yeast. Bread dough flour yeast oven. Yeast bread flour baking oven.";
		const chunks = await splitTextWithEmbedder(
			text,
			{ strategy: "semantic", breakpoint_percentile: 80, buffer_size: 0 },
			bagOfWords
		);
		expect(chunks).toHaveLength(2);
		expect(chunks[0]?.content).toContain("Rust");
		expect(chunks[0]?.content).not.toContain("bread");
		expect(chunks[1]?.content).toContain("bread");
	});

	test("invalid strategies are rejected", () => {
		expect(() =>
			validateStrategy({
				strategy: "recursive",
				chunk_size: 100,
				chunk_overlap: 100,
			})
		).toThrow(RangeError);
		expect(() =>
			validateStrategy({ strategy: "token", chunk_size: 0 })
		).toThrow(RangeError);
		expect(() =>
			validateStrategy({ strategy: "semantic", breakpoint_percentile: 120 })
		).toThrow(RangeError);
	});
});

describe("metadata filters", () => {
	const check = (filter: MetadataFilter, metadata: Record<string, unknown>) =>
		matchesFilter(filter, metadata);

	test("equality, membership, and arrays", () => {
		expect(check({ kind: "page" }, { kind: "page" })).toBe(true);
		expect(check({ kind: "page" }, {})).toBe(false);
		expect(check({ n: 3 }, { n: 3.0 })).toBe(true);
		expect(check({ kind: { $ne: "page" } }, {})).toBe(true);
		expect(check({ lang: { $in: ["en", "de"] } }, { lang: "de" })).toBe(true);
		expect(check({ lang: { $nin: ["en"] } }, { lang: "fr" })).toBe(true);
		expect(check({ tags: "b" }, { tags: ["a", "b"] })).toBe(true);
		expect(check({ tags: { $ne: "b" } }, { tags: ["a", "b"] })).toBe(false);
	});

	test("ranges, combinators, dotted paths, and existence", () => {
		expect(check({ ordinal: { $gt: 1, $lt: 4 } }, { ordinal: 2 })).toBe(true);
		expect(check({ ordinal: { $gt: 1, $lt: 4 } }, { ordinal: 4 })).toBe(false);
		expect(check({ n: { $gt: 1 } }, { n: "5" })).toBe(false);
		const filter: MetadataFilter = {
			$or: [
				{ kind: "file" },
				{ $and: [{ kind: "page" }, { ordinal: { $lt: 2 } }] },
			],
			$not: { draft: true },
		};
		expect(check(filter, { kind: "page", ordinal: 1 })).toBe(true);
		expect(check(filter, { kind: "file", draft: true })).toBe(false);
		expect(check({ "doc.lang": "en" }, { doc: { lang: "en" } })).toBe(true);
		expect(check({ x: { $exists: false } }, { x: null })).toBe(true);
		expect(check({}, { anything: 1 })).toBe(true);
	});

	test("malformed filters are rejected", () => {
		for (const bad of [
			[1, 2],
			{ $or: [] },
			{ $where: "1" },
			{ a: { $regex: "x" } },
			{ a: { $in: "x" } },
			{ a: { $gt: true } },
			{ a: { $exists: 1 } },
			{ "": 1 },
		]) {
			expect(() => validateFilter(bad)).toThrow(TypeError);
		}
		let deep: MetadataFilter = { a: 1 };
		for (let i = 0; i < 18; i += 1) {
			deep = { $not: deep };
		}
		expect(() => validateFilter(deep)).toThrow(TypeError);
	});
});

describe("weightedRrf", () => {
	const ids = (fused: { item: string }[]) => fused.map((f) => f.item);
	const key = (s: string) => s;

	test("alpha extremes reproduce one ranking", () => {
		expect(
			ids(
				weightedRrf(
					[
						{ weight: 1, items: ["a", "b", "c"] },
						{ weight: 0, items: ["c", "d"] },
					],
					key,
					10
				)
			)
		).toEqual(["a", "b", "c"]);
	});

	test("shared hits rise and weights tilt the order", () => {
		expect(
			ids(
				weightedRrf(
					[
						{ weight: 0.5, items: ["a", "shared"] },
						{ weight: 0.5, items: ["k", "shared"] },
					],
					key,
					3
				)
			)
		).toEqual(["shared", "a", "k"]);
		expect(
			ids(
				weightedRrf(
					[
						{ weight: 0.8, items: ["v1", "v2"] },
						{ weight: 0.2, items: ["k1", "k2"] },
					],
					key,
					4
				)
			)
		).toEqual(["v1", "v2", "k1", "k2"]);
	});
});
