/**
 * Model-graded scorers. Each one delegates the judging to the Ryu Gateway's
 * eval API (`POST /v1/evals/score`), so the judge prompt format, verdict
 * parsing, budgets, and routing are the Gateway's — the same ones Desktop and
 * `ryu eval` use. Catalog evaluators (toxicity, correctness, conciseness, …)
 * are referenced by id and never re-implemented here.
 */

import {
	defaultGatewayEvalClient,
	type GatewayAssertion,
	type GatewayEvalClient,
	type OnlineScoreRequest,
} from "./gateway.ts";
import {
	assertUnitInterval,
	createScorer,
	expectedText,
	skipped,
} from "./scorer.ts";
import type { ScoreResult, Scorer, ScorerInput } from "./types.ts";

/** Options shared by every Gateway-backed scorer. */
export interface GatewayScorerOptions {
	/** Agent id for per-agent Gateway budgets and audit. */
	agentId?: string;
	/** Gateway eval client (defaults to one built from the environment). */
	gateway?: GatewayEvalClient;
	/** Override the scorer id. */
	id?: string;
	/** Judge model routed by the Gateway (its default model when omitted). */
	model?: string;
	/** Pass threshold in [0, 1]. */
	threshold?: number;
}

function caseVars(input: ScorerInput): Record<string, unknown> {
	const vars: Record<string, unknown> = { input: input.input };
	const expected = expectedText(input.expected);
	if (expected !== undefined) {
		vars.expected = expected;
	}
	if (input.context !== undefined) {
		vars.context =
			typeof input.context === "string"
				? input.context
				: JSON.stringify(input.context);
	}
	return vars;
}

function baseRequest(
	input: ScorerInput,
	options: GatewayScorerOptions
): OnlineScoreRequest {
	const request: OnlineScoreRequest = {
		prompt: input.input,
		response: input.output,
		vars: caseVars(input),
	};
	const expected = expectedText(input.expected);
	if (expected !== undefined) {
		request.expected = expected;
	}
	if (input.context !== undefined) {
		request.context = input.context;
	}
	if (options.agentId) {
		request.agentId = options.agentId;
	}
	if (options.model) {
		request.model = options.model;
	}
	return request;
}

async function scoreAssertion(
	input: ScorerInput,
	options: GatewayScorerOptions,
	assertion: GatewayAssertion
): Promise<ScoreResult> {
	const gateway = options.gateway ?? defaultGatewayEvalClient();
	const result = await gateway.score(
		{ ...baseRequest(input, options), assertions: [assertion] },
		input.signal
	);
	const scored = result.assertions.find(
		(entry) => entry.kind === assertion.kind
	);
	if (!scored) {
		throw new Error(`gateway returned no ${assertion.kind} result`);
	}
	if (scored.executed === false) {
		return skipped(scored.detail);
	}
	return {
		details: { verdict: scored.pass ? "pass" : "fail" },
		reason: scored.detail,
		score: scored.score,
	};
}

function checkThreshold(options: GatewayScorerOptions, label: string): void {
	if (options.threshold !== undefined) {
		assertUnitInterval(options.threshold, `${label} threshold`);
	}
}

/** Options for {@link llmJudge}. */
export interface LlmJudgeOptions extends GatewayScorerOptions {
	/**
	 * What the judge should check, scored from 0 to 1. `{{input}}`,
	 * `{{expected}}`, and `{{context}}` are replaced with the case's values.
	 */
	rubric: string;
}

/**
 * LLM-as-judge with your own rubric. The Gateway sends the rubric and the
 * output to the judge model and parses its verdict and score.
 *
 * ```ts
 * llmJudge({
 *   id: "cites_sources",
 *   rubric: "Question: {{input}}\nScore 1 if the answer cites a source.",
 *   model: "your-judge-model",
 * });
 * ```
 */
export function llmJudge(options: LlmJudgeOptions): Scorer {
	if (options.rubric.trim() === "") {
		throw new TypeError("llmJudge needs a non-empty rubric");
	}
	checkThreshold(options, "llmJudge");
	return createScorer({
		description: "LLM-as-judge rubric",
		id: options.id ?? "llm_judge",
		threshold: options.threshold,
		score: (input) =>
			scoreAssertion(input, options, {
				kind: "llm_judge",
				provider: options.model,
				rubric: options.rubric,
			}),
	});
}

/**
 * The rubric for {@link answerRelevancy}. The Gateway's judge prompt carries
 * only the rubric and the output, so the question travels inside the rubric.
 */
const ANSWER_RELEVANCE_RUBRIC =
	"The user asked:\n{{input}}\n\nScore from 0 to 1 how directly and completely the output answers that question; off-topic or evasive answers score low.";

/** Whether the output actually answers the question (Gateway `answer_relevance`). */
export function answerRelevancy(options: GatewayScorerOptions = {}): Scorer {
	checkThreshold(options, "answerRelevancy");
	return createScorer({
		description: "Output answers the question asked",
		id: options.id ?? "answer_relevancy",
		threshold: options.threshold,
		score: (input) =>
			scoreAssertion(input, options, {
				kind: "answer_relevance",
				provider: options.model,
				rubric: ANSWER_RELEVANCE_RUBRIC,
			}),
	});
}

/** Gateway prepends the case context to this rubric for `context_faithfulness`. */
const FAITHFULNESS_RUBRIC =
	"Score from 0 to 1 how fully every factual claim in the output is supported by the reference context above. 1 means every claim is supported; unsupported or contradicted claims lower the score.";

/**
 * Whether the output's claims are supported by the case `context` (Gateway
 * `context_faithfulness`). Skipped for cases without context.
 */
export function faithfulness(options: GatewayScorerOptions = {}): Scorer {
	checkThreshold(options, "faithfulness");
	return createScorer({
		description: "Output claims are supported by the context",
		id: options.id ?? "faithfulness",
		threshold: options.threshold,
		score: (input) =>
			input.context === undefined || input.context === null
				? skipped("no context")
				: scoreAssertion(input, options, {
						kind: "context_faithfulness",
						provider: options.model,
						rubric: FAITHFULNESS_RUBRIC,
					}),
	});
}

/** Options for {@link catalogEvaluator}. */
export interface CatalogEvaluatorOptions extends GatewayScorerOptions {
	/** Gateway catalog evaluator id (`GET /v1/evaluators`), e.g. `correctness`. */
	evaluator: string;
}

/**
 * Score with any offline evaluator from the Gateway's shared catalog. Scores
 * are normalized so higher is always better: a negative-signal evaluator
 * (catalog `higherIsBetter: false`, such as `toxicity`) reports `1 - raw`.
 * Without a `threshold`, the Gateway's own pass verdict is used.
 */
export function catalogEvaluator(options: CatalogEvaluatorOptions): Scorer {
	checkThreshold(options, `catalog evaluator '${options.evaluator}'`);
	return createScorer({
		description: `Gateway evaluator ${options.evaluator}`,
		id: options.id ?? options.evaluator,
		threshold: options.threshold,
		score: async (input) => {
			const gateway = options.gateway ?? defaultGatewayEvalClient();
			const catalog = await gateway.evaluators();
			const entry = catalog.find((item) => item.id === options.evaluator);
			if (!entry) {
				throw new Error(
					`unknown Gateway evaluator '${options.evaluator}'; known: ${catalog.map((item) => item.id).join(", ")}`
				);
			}
			if (entry.capabilities?.offline === false) {
				throw new Error(
					`Gateway evaluator '${options.evaluator}' cannot score offline`
				);
			}
			const result = await gateway.score(
				{ ...baseRequest(input, options), evaluators: [options.evaluator] },
				input.signal
			);
			const scored = result.evaluators.find(
				(item) => item.id === options.evaluator
			);
			if (!scored) {
				throw new Error(`gateway returned no ${options.evaluator} result`);
			}
			if (!scored.executed) {
				return skipped(scored.detail);
			}
			const higherIsBetter = entry.higherIsBetter !== false;
			const score = higherIsBetter ? scored.score : 1 - scored.score;
			return {
				details: { higherIsBetter, rawScore: scored.score },
				pass:
					options.threshold === undefined
						? scored.pass
						: score >= options.threshold,
				reason: scored.detail,
				score,
			};
		},
	});
}

/**
 * Non-toxicity via the Gateway catalog's `toxicity` evaluator; 1 = benign.
 */
export function toxicity(options: GatewayScorerOptions = {}): Scorer {
	return catalogEvaluator({
		...options,
		evaluator: "toxicity",
		id: options.id ?? "toxicity",
	});
}

/** Options for {@link embeddingSimilarity}. */
export interface EmbeddingSimilarityOptions {
	gateway?: GatewayEvalClient;
	id?: string;
	/** Embedding model routed by the Gateway (required). */
	model: string;
	/** Minimum similarity to pass (default 0.8). */
	threshold?: number;
}

/** Cosine similarity of two equal-length vectors (0 when either is zero). */
export function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length) {
		throw new RangeError(
			`embedding lengths differ (${a.length} vs ${b.length})`
		);
	}
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (const [index, value] of a.entries()) {
		const other = b[index] ?? 0;
		dot += value * other;
		normA += value * value;
		normB += other * other;
	}
	if (normA === 0 || normB === 0) {
		return 0;
	}
	return dot / Math.sqrt(normA * normB);
}

/**
 * Semantic similarity to the expected answer: cosine similarity of Gateway
 * embeddings (negative similarity scores 0).
 */
export function embeddingSimilarity(
	options: EmbeddingSimilarityOptions
): Scorer {
	if (options.model.trim() === "") {
		throw new TypeError("embeddingSimilarity needs an embedding model");
	}
	const threshold = options.threshold ?? 0.8;
	assertUnitInterval(threshold, "embeddingSimilarity threshold");
	return createScorer({
		description: "Embedding similarity to the expected answer",
		id: options.id ?? "embedding_similarity",
		threshold,
		score: async ({ expected, output, signal }) => {
			const reference = expectedText(expected);
			if (reference === undefined) {
				return skipped("no expected answer");
			}
			const gateway = options.gateway ?? defaultGatewayEvalClient();
			const [outputVector, referenceVector] = await gateway.embed(
				options.model,
				[output, reference],
				signal
			);
			const similarity = cosineSimilarity(
				outputVector ?? [],
				referenceVector ?? []
			);
			return { details: { similarity }, score: Math.max(0, similarity) };
		},
	});
}
