import { describe, expect, test } from "bun:test";
import {
	type EvalFetch,
	GatewayEvalClient,
	GatewayEvalError,
} from "./gateway.ts";
import {
	answerRelevancy,
	catalogEvaluator,
	cosineSimilarity,
	embeddingSimilarity,
	faithfulness,
	llmJudge,
	toxicity,
} from "./model-graded.ts";
import { runScorer } from "./scorer.ts";
import type { ScorerInput } from "./types.ts";

interface Sent {
	authorization: string | null;
	body: unknown;
	method: string;
	path: string;
}

const CATALOG = {
	evaluators: [
		{
			capabilities: { inline: true, offline: true },
			higherIsBetter: false,
			id: "toxicity",
		},
		{
			capabilities: { inline: false, offline: true },
			higherIsBetter: true,
			id: "correctness",
		},
		{
			capabilities: { inline: true, offline: false },
			higherIsBetter: true,
			id: "inline_only",
		},
	],
};

function mockGateway(
	handler: (path: string, body: unknown) => unknown,
	status = 200
): { client: GatewayEvalClient; sent: Sent[] } {
	const sent: Sent[] = [];
	const fetchImpl: EvalFetch = async (url, init) => {
		const path = new URL(url).pathname;
		const body =
			typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		sent.push({
			authorization: new Headers(init?.headers).get("authorization"),
			body,
			method: init?.method ?? "GET",
			path,
		});
		return Response.json(handler(path, body), { status });
	};
	return {
		client: new GatewayEvalClient({
			baseUrl: "http://gateway.test/",
			fetch: fetchImpl,
			token: "gw-token",
		}),
		sent,
	};
}

function onlineScore(
	assertions: unknown[] = [],
	evaluators: unknown[] = []
): unknown {
	return {
		kind: "online_score",
		score: { assertions, evaluators, overall: 1 },
		scored_at: "2026-10-21T00:00:00Z",
	};
}

const CASE: ScorerInput = {
	context: ["Paris is the capital of France."],
	expected: "Paris",
	input: "What is the capital of France?",
	output: "Paris.",
	toolCalls: [],
};

describe("GatewayEvalClient", () => {
	test("posts online scores with the gateway token and snake_case fields", async () => {
		const { client, sent } = mockGateway(() =>
			onlineScore([
				{
					detail: "ok",
					executed: true,
					kind: "contains",
					pass: true,
					score: 1,
				},
			])
		);
		const result = await client.score({
			agentId: "agent-1",
			assertions: [{ kind: "contains", value: "Paris" }],
			model: "judge",
			prompt: "q",
			response: "Paris",
		});
		expect(result.assertions[0]?.pass).toBe(true);
		expect(result.evaluators).toEqual([]);
		expect(sent).toEqual([
			{
				authorization: "Bearer gw-token",
				body: {
					agent_id: "agent-1",
					assertions: [{ kind: "contains", value: "Paris" }],
					model: "judge",
					prompt: "q",
					response: "Paris",
				},
				method: "POST",
				path: "/v1/evals/score",
			},
		]);
	});

	test("surfaces Gateway errors with the status", async () => {
		const { client } = mockGateway(() => ({ error: "model is required" }), 400);
		const error = await client
			.score({ prompt: "q", response: "a" })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(GatewayEvalError);
		expect(error).toMatchObject({ status: 400 });
		expect(String(error)).toContain("model is required");
	});

	test("caches the evaluator catalog and orders embeddings by index", async () => {
		const { client, sent } = mockGateway((path) =>
			path === "/v1/evaluators"
				? CATALOG
				: {
						data: [
							{ embedding: [0, 1], index: 1 },
							{ embedding: [1, 0], index: 0 },
						],
					}
		);
		await client.evaluators();
		await client.evaluators();
		expect(
			sent.filter((entry) => entry.path === "/v1/evaluators")
		).toHaveLength(1);
		expect(await client.embed("embed-model", ["a", "b"])).toEqual([
			[1, 0],
			[0, 1],
		]);
		expect(sent.at(-1)?.body).toEqual({
			input: ["a", "b"],
			model: "embed-model",
		});
	});

	test("rejects direct-provider base URLs", () => {
		expect(
			() => new GatewayEvalClient({ baseUrl: "https://api.openai.com" })
		).toThrow();
	});
});

describe("model-graded scorers", () => {
	test("llmJudge sends the rubric, judge model, and case vars", async () => {
		const { client, sent } = mockGateway(() =>
			onlineScore([
				{
					detail: "VERDICT: PASS SCORE: 0.9",
					executed: true,
					kind: "llm_judge",
					pass: true,
					score: 0.9,
				},
			])
		);
		const result = await runScorer(
			llmJudge({
				gateway: client,
				model: "judge-model",
				rubric: "Q: {{input}}. Score 1 if correct.",
				threshold: 0.8,
			}),
			CASE
		);
		expect(result).toMatchObject({
			pass: true,
			reason: "VERDICT: PASS SCORE: 0.9",
			score: 0.9,
		});
		expect(sent[0]?.body).toEqual({
			assertions: [
				{
					kind: "llm_judge",
					provider: "judge-model",
					rubric: "Q: {{input}}. Score 1 if correct.",
				},
			],
			context: ["Paris is the capital of France."],
			expected: "Paris",
			model: "judge-model",
			prompt: "What is the capital of France?",
			response: "Paris.",
			vars: {
				context: '["Paris is the capital of France."]',
				expected: "Paris",
				input: "What is the capital of France?",
			},
		});
	});

	test("an unexecuted Gateway judge is a skip, not a pass", async () => {
		const { client } = mockGateway(() =>
			onlineScore([
				{
					detail: "judge error: no provider",
					executed: false,
					kind: "answer_relevance",
					pass: false,
					score: 0,
				},
			])
		);
		const result = await runScorer(answerRelevancy({ gateway: client }), CASE);
		expect(result).toMatchObject({
			reason: "judge error: no provider",
			skipped: true,
		});
	});

	test("answerRelevancy carries the question; faithfulness needs context", async () => {
		const { client, sent } = mockGateway((_path, body) => {
			const kind = (body as { assertions: { kind: string }[] }).assertions[0]
				?.kind;
			return onlineScore([
				{ detail: "ok", executed: true, kind, pass: true, score: 0.8 },
			]);
		});
		await runScorer(answerRelevancy({ gateway: client }), CASE);
		const relevance = sent[0]?.body as {
			assertions: { kind: string; rubric: string }[];
		};
		expect(relevance.assertions[0]?.kind).toBe("answer_relevance");
		expect(relevance.assertions[0]?.rubric).toContain("{{input}}");

		expect(
			(await runScorer(faithfulness({ gateway: client }), CASE)).score
		).toBe(0.8);
		expect(
			(sent[1]?.body as { assertions: { kind: string }[] }).assertions[0]?.kind
		).toBe("context_faithfulness");
		const noContext = await runScorer(faithfulness({ gateway: client }), {
			...CASE,
			context: undefined,
		});
		expect(noContext.skipped).toBe(true);
		expect(sent).toHaveLength(2);
	});

	test("catalog evaluators invert negative-signal scores", async () => {
		const { client, sent } = mockGateway((path) =>
			path === "/v1/evaluators"
				? CATALOG
				: onlineScore(
						[],
						[
							{
								category: "safety",
								detail: "benign",
								executed: true,
								id: "toxicity",
								pass: true,
								score: 0.1,
							},
						]
					)
		);
		const result = await runScorer(toxicity({ gateway: client }), CASE);
		expect(result.score).toBeCloseTo(0.9);
		expect(result.pass).toBe(true);
		expect(result.details).toEqual({ higherIsBetter: false, rawScore: 0.1 });
		expect(sent[1]?.body).toMatchObject({ evaluators: ["toxicity"] });
	});

	test("catalog evaluators reject unknown or inline-only ids", async () => {
		const { client } = mockGateway(() => CATALOG);
		expect(
			(
				await runScorer(
					catalogEvaluator({ evaluator: "nope", gateway: client }),
					CASE
				)
			).reason
		).toContain("unknown Gateway evaluator 'nope'");
		expect(
			(
				await runScorer(
					catalogEvaluator({ evaluator: "inline_only", gateway: client }),
					CASE
				)
			).reason
		).toContain("cannot score offline");
	});

	test("embeddingSimilarity is the cosine of Gateway embeddings", async () => {
		expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
		expect(cosineSimilarity([1, 0], [0, 0])).toBe(0);
		expect(() => cosineSimilarity([1], [1, 2])).toThrow("lengths differ");
		const { client } = mockGateway(() => ({
			data: [
				{ embedding: [1, 1], index: 0 },
				{ embedding: [1, 0], index: 1 },
			],
		}));
		const result = await runScorer(
			embeddingSimilarity({ gateway: client, model: "embed" }),
			CASE
		);
		expect(result.score).toBeCloseTo(Math.SQRT1_2);
		expect(result.pass).toBe(false);
		expect(() => embeddingSimilarity({ model: " " })).toThrow(
			"needs an embedding model"
		);
	});
});
