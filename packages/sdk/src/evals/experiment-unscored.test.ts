import { describe, expect, test } from "bun:test";
import { runExperiment } from "./experiment.ts";
import { type EvalFetch, GatewayEvalClient } from "./gateway.ts";
import { faithfulness, toxicity } from "./model-graded.ts";
import { createScorer, runScorer, unscored } from "./scorer.ts";

const CATALOG = {
	evaluators: [
		{
			capabilities: { inline: true, offline: true },
			higherIsBetter: false,
			id: "toxicity",
		},
	],
};

/** A Gateway whose judge refuses to score any response containing "bait". */
function refusingGateway(): GatewayEvalClient {
	const fetchImpl: EvalFetch = async (url, init) => {
		if (new URL(url).pathname === "/v1/evaluators") {
			return Response.json(CATALOG);
		}
		const body = JSON.parse(String(init?.body)) as { response: string };
		const refused = body.response.includes("bait");
		return Response.json({
			kind: "online_score",
			score: {
				assertions: [],
				evaluators: [
					{
						category: "safety",
						detail: refused
							? "judge refused; no verdict"
							: "VERDICT: PASS SCORE: 0",
						executed: !refused,
						id: "toxicity",
						pass: !refused,
						score: 0,
					},
				],
				overall: 1,
			},
			scored_at: "2026-11-02T00:00:00Z",
		});
	};
	return new GatewayEvalClient({
		baseUrl: "http://gateway.test/",
		fetch: fetchImpl,
		token: "gw-token",
	});
}

const DATASET = [
	{ id: "greeting", input: "hello" },
	{ id: "weather", input: "weather?" },
	{ id: "toxic", input: "bait" },
];

describe("a judge that leaves cases unscored", () => {
	test("fails the case and the threshold instead of averaging the rest", async () => {
		const result = await runExperiment({
			dataset: DATASET,
			fn: (item) => `reply to ${item.input}`,
			scorers: [toxicity({ gateway: refusingGateway() })],
			thresholds: { toxicity: 0.9 },
		});
		expect(result.cases.map((entry) => [entry.id, entry.pass])).toEqual([
			["greeting", true],
			["weather", true],
			["toxic", false],
		]);
		expect(result.cases[2]?.scores.toxicity).toMatchObject({
			pass: false,
			reason: "judge refused; no verdict",
			skipped: true,
			unscored: true,
		});
		expect(result.scores.toxicity).toEqual({
			executed: 2,
			mean: 1,
			passRate: 1,
			skipped: 1,
			unscored: 1,
		});
		expect(result.thresholds).toEqual([
			{ mean: 1, pass: false, scorer: "toxicity", threshold: 0.9, unscored: 1 },
		]);
		expect(result.pass).toBe(false);
	});

	test("passes when the judge scored every case", async () => {
		const result = await runExperiment({
			dataset: DATASET.slice(0, 2),
			fn: (item) => `reply to ${item.input}`,
			scorers: [toxicity({ gateway: refusingGateway() })],
			thresholds: { toxicity: 0.9 },
		});
		expect(result.pass).toBe(true);
		expect(result.scores.toxicity?.unscored).toBeUndefined();
	});

	test("a not-applicable skip still leaves the case and threshold passing", async () => {
		const result = await runExperiment({
			dataset: [{ id: "no-context", input: "hello" }],
			fn: () => "hi",
			scorers: [
				faithfulness({ gateway: refusingGateway() }),
				createScorer({ id: "always", score: () => ({ score: 1 }) }),
			],
			thresholds: { always: 0.5 },
		});
		expect(result.cases[0]?.scores.faithfulness).toMatchObject({
			skipped: true,
		});
		expect(result.cases[0]?.scores.faithfulness?.unscored).toBeUndefined();
		expect(result.cases[0]?.pass).toBe(true);
		expect(result.pass).toBe(true);
	});

	test("a custom scorer can report an unscored case", async () => {
		const scorer = createScorer({
			id: "custom_judge",
			score: () => unscored("judge output was cut off"),
		});
		const score = await runScorer(scorer, {
			input: "q",
			output: "a",
			toolCalls: [],
		});
		expect(score).toEqual({
			details: undefined,
			pass: false,
			reason: "judge output was cut off",
			score: 0,
			skipped: true,
			unscored: true,
		});
	});
});
