import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
	completeness,
	contains,
	contentTerms,
	exactMatch,
	jsonSchema,
	levenshtein,
	levenshteinDistance,
	regex,
	toolCallAccuracy,
} from "./deterministic.ts";
import { createScorer, runScorer } from "./scorer.ts";
import type { ScorerInput, ToolCallRecord } from "./types.ts";

function input(overrides: Partial<ScorerInput> = {}): ScorerInput {
	return {
		input: "Capital of France?",
		output: "",
		toolCalls: [],
		...overrides,
	};
}

describe("createScorer / runScorer", () => {
	test("wraps numbers, clamps, and applies the threshold", async () => {
		const scorer = createScorer({
			id: "len",
			score: () => 1.7,
			threshold: 0.9,
		});
		expect(await runScorer(scorer, input())).toEqual({
			details: undefined,
			pass: true,
			reason: undefined,
			score: 1,
			skipped: false,
		});
		const low = createScorer({ id: "low", score: () => 0.4 });
		expect((await runScorer(low, input())).pass).toBe(false);
	});

	test("a throwing scorer fails rather than passing or skipping", async () => {
		const broken = createScorer({
			id: "broken",
			score: () => {
				throw new Error("boom");
			},
		});
		expect(await runScorer(broken, input())).toMatchObject({
			pass: false,
			reason: "scorer error: boom",
			skipped: false,
		});
	});

	test("validates ids and thresholds", () => {
		expect(() => createScorer({ id: "has space", score: () => 1 })).toThrow(
			"must be 1-128"
		);
		expect(() =>
			createScorer({ id: "x", score: () => 1, threshold: 2 })
		).toThrow("between 0 and 1");
	});
});

describe("text scorers", () => {
	test("exactMatch normalizes whitespace and case by default", async () => {
		const scorer = exactMatch();
		expect(
			(
				await runScorer(
					scorer,
					input({ expected: "Paris", output: "  paris " })
				)
			).pass
		).toBe(true);
		expect(
			(
				await runScorer(
					exactMatch({ caseSensitive: true }),
					input({ expected: "Paris", output: "paris" })
				)
			).pass
		).toBe(false);
		expect((await runScorer(scorer, input({ output: "x" }))).skipped).toBe(
			true
		);
		expect(
			(
				await runScorer(
					scorer,
					input({ expected: { a: 1 }, output: '{"a":1}' })
				)
			).score
		).toBe(1);
	});

	test("contains scores the fraction of required values found", async () => {
		const result = await runScorer(
			contains({ value: ["Paris", "France", "Seine"] }),
			input({ output: "Paris is in France." })
		);
		expect(result.score).toBeCloseTo(2 / 3);
		expect(result.pass).toBe(false);
		expect(result.reason).toBe("missing: Seine");
		expect(
			(
				await runScorer(
					contains(),
					input({ expected: "paris", output: "PARIS!" })
				)
			).pass
		).toBe(true);
	});

	test("regex matches or negates", async () => {
		const scorer = regex({ pattern: /\d{4}/g });
		expect((await runScorer(scorer, input({ output: "in 1889" }))).pass).toBe(
			true
		);
		// A global regex must not carry lastIndex between cases.
		expect((await runScorer(scorer, input({ output: "in 1889" }))).pass).toBe(
			true
		);
		expect(
			(
				await runScorer(
					regex({ negate: true, pattern: "sorry" }),
					input({ output: "sorry, no" })
				)
			).pass
		).toBe(false);
	});

	test("levenshtein distance and similarity", async () => {
		expect(levenshteinDistance("kitten", "sitting")).toBe(3);
		expect(levenshteinDistance("", "abc")).toBe(3);
		const result = await runScorer(
			levenshtein(),
			input({ expected: "kitten", output: "sitting" })
		);
		expect(result.score).toBeCloseTo(1 - 3 / 7);
		expect(result.pass).toBe(false);
		expect(
			(
				await runScorer(
					levenshtein(),
					input({ expected: "Paris", output: "Pariss" })
				)
			).pass
		).toBe(true);
	});

	test("completeness measures coverage of the reference's content words", async () => {
		expect([...contentTerms("The Eiffel Tower is in Paris.")]).toEqual([
			"eiffel",
			"tower",
			"paris",
		]);
		const result = await runScorer(
			completeness(),
			input({
				expected: "The Eiffel Tower is in Paris, France",
				output: "It stands in Paris near the tower.",
			})
		);
		expect(result.score).toBeCloseTo(2 / 4);
		expect(result.details).toEqual({ missing: ["eiffel", "france"] });
	});
});

describe("jsonSchema", () => {
	test("accepts a JSON Schema object and fenced JSON", async () => {
		const scorer = jsonSchema({
			schema: {
				properties: { city: { type: "string" } },
				required: ["city"],
				type: "object",
			},
		});
		expect(
			(
				await runScorer(
					scorer,
					input({ output: 'Here:\n```json\n{"city":"Paris"}\n```' })
				)
			).pass
		).toBe(true);
		const missing = await runScorer(scorer, input({ output: '{"town":"x"}' }));
		expect(missing.pass).toBe(false);
		expect(missing.reason).toContain("city");
		expect(
			(await runScorer(scorer, input({ output: "no json here" }))).reason
		).toBe("the reply was not valid JSON");
	});

	test("accepts a Standard Schema such as zod", async () => {
		const scorer = jsonSchema({
			schema: z.object({ temperature: z.number() }),
		});
		expect(
			(await runScorer(scorer, input({ output: '{"temperature": 21}' }))).pass
		).toBe(true);
		expect(
			(await runScorer(scorer, input({ output: '{"temperature": "hot"}' })))
				.pass
		).toBe(false);
	});
});

describe("toolCallAccuracy", () => {
	const calls: ToolCallRecord[] = [
		{ input: { city: "Paris", units: "c" }, name: "weather" },
		{ input: { q: "eiffel" }, name: "search" },
	];

	test("matches names with a subset match on arguments", async () => {
		const result = await runScorer(
			toolCallAccuracy(),
			input({
				expectedToolCalls: [
					{ input: { city: "Paris" }, name: "weather" },
					{ name: "search" },
				],
				toolCalls: calls,
			})
		);
		expect(result).toMatchObject({ pass: true, score: 1 });
	});

	test("reports missing calls, wrong arguments, and strict extras", async () => {
		const wrongArgs = await runScorer(
			toolCallAccuracy(),
			input({
				expectedToolCalls: [{ input: { city: "Rome" }, name: "weather" }],
				toolCalls: calls,
			})
		);
		expect(wrongArgs).toMatchObject({ reason: "missing: weather", score: 0 });
		const strict = await runScorer(
			toolCallAccuracy({ strict: true }),
			input({ expectedToolCalls: [{ name: "weather" }], toolCalls: calls })
		);
		expect(strict.score).toBeCloseTo(1 / 2);
		expect(strict.reason).toBe("unexpected: search");
	});

	test("ordered requires the expected sequence", async () => {
		const result = await runScorer(
			toolCallAccuracy({ ordered: true }),
			input({
				expectedToolCalls: [{ name: "search" }, { name: "weather" }],
				toolCalls: calls,
			})
		);
		expect(result.score).toBeCloseTo(1 / 2);
	});

	test("an empty expectation passes only when no tool was called", async () => {
		const scorer = toolCallAccuracy({ expected: [] });
		expect((await runScorer(scorer, input())).pass).toBe(true);
		expect((await runScorer(scorer, input({ toolCalls: calls }))).pass).toBe(
			false
		);
		expect((await runScorer(toolCallAccuracy(), input())).skipped).toBe(true);
	});
});
