/**
 * The Gateway eval client behind the model-graded scorers.
 *
 * LLM-as-judge rubrics, the shared evaluator catalog (answer relevance,
 * toxicity, correctness, …), and embeddings all live in the Ryu Gateway, so
 * the SDK never ships its own judge prompts or provider keys. Every request
 * goes to the configured Gateway (`RYU_GATEWAY_URL`, default local) with the
 * Gateway token, and direct-provider URLs are rejected like every other SDK
 * model call.
 *
 * Endpoints:
 *   POST /v1/evals/score   score a completed output (assertions + evaluators)
 *   GET  /v1/evaluators    the evaluator catalog (polarity, offline support)
 *   POST /v1/embeddings    OpenAI-compatible embeddings
 */

import { z } from "zod";
import {
	assertAllowedEgressUrl,
	resolveGatewayToken,
	resolveGatewayUrl,
} from "../model/gateway.ts";

/** `fetch`-compatible transport, injectable for tests. */
export type EvalFetch = (
	input: string,
	init?: RequestInit
) => Promise<Response>;

/** Options for {@link GatewayEvalClient}. */
export interface GatewayEvalClientOptions {
	/** Gateway base URL (no `/v1`). Defaults to `RYU_GATEWAY_URL`. */
	baseUrl?: string;
	/** Injectable transport (defaults to the global `fetch`). */
	fetch?: EvalFetch;
	/** Gateway bearer token. Defaults to `RYU_GATEWAY_TOKEN`. */
	token?: string;
}

/** A Gateway assertion (the subset the SDK scorers send). */
export interface GatewayAssertion {
	kind: string;
	/** Judge model override for model-graded assertions. */
	provider?: string;
	rubric?: string;
	threshold?: number;
	value?: string;
}

/** Request body for `POST /v1/evals/score`. */
export interface OnlineScoreRequest {
	agentId?: string;
	assertions?: GatewayAssertion[];
	context?: unknown;
	evaluators?: string[];
	expected?: string;
	id?: string;
	/** Judge model; the Gateway default model when omitted. */
	model?: string;
	prompt: string;
	response: string;
	vars?: Record<string, unknown>;
}

const assertionResultSchema = z.object({
	detail: z.string(),
	executed: z.boolean().optional(),
	kind: z.string(),
	pass: z.boolean(),
	score: z.number(),
});
const evaluatorResultSchema = z.object({
	category: z.string(),
	detail: z.string(),
	executed: z.boolean(),
	id: z.string(),
	pass: z.boolean(),
	score: z.number(),
});
const onlineScoreSchema = z.object({
	kind: z.literal("online_score"),
	score: z.looseObject({
		assertions: z.array(assertionResultSchema),
		evaluators: z.array(evaluatorResultSchema).optional(),
	}),
});
const catalogSchema = z.object({
	evaluators: z.array(
		z.looseObject({
			capabilities: z
				.looseObject({ inline: z.boolean(), offline: z.boolean() })
				.optional(),
			description: z.string().optional(),
			higherIsBetter: z.boolean().optional(),
			id: z.string(),
			name: z.string().optional(),
			target: z.string().optional(),
		})
	),
});
const embeddingsSchema = z.object({
	data: z.array(
		z.object({ embedding: z.array(z.number()), index: z.number().optional() })
	),
});

/** One Gateway assertion result. */
export type GatewayAssertionResult = z.infer<typeof assertionResultSchema>;
/** One Gateway evaluator result (raw score; see `higherIsBetter`). */
export type GatewayEvaluatorResult = z.infer<typeof evaluatorResultSchema>;
/** One evaluator catalog entry. */
export type GatewayEvaluatorInfo = z.infer<
	typeof catalogSchema
>["evaluators"][number];

/** What the Gateway scored for one online score request. */
export interface OnlineScoreResult {
	assertions: GatewayAssertionResult[];
	evaluators: GatewayEvaluatorResult[];
}

/** Raised for a non-2xx Gateway response or an unexpected body. */
export class GatewayEvalError extends Error {
	readonly status: number | null;

	constructor(message: string, status: number | null = null) {
		super(message);
		this.name = "GatewayEvalError";
		this.status = status;
	}
}

function env(key: string): string | undefined {
	const value = globalThis.process?.env?.[key];
	return value && value !== "" ? value : undefined;
}

/** HTTP client for the Gateway's eval surface. */
export class GatewayEvalClient {
	readonly baseUrl: string;
	private catalog: Promise<GatewayEvaluatorInfo[]> | null = null;
	private readonly fetchImpl: EvalFetch;
	private readonly token: string | undefined;

	constructor(options: GatewayEvalClientOptions = {}) {
		const base =
			options.baseUrl ?? env("RYU_GATEWAY_URL") ?? resolveGatewayUrl();
		this.baseUrl = base.endsWith("/") ? base.slice(0, -1) : base;
		assertAllowedEgressUrl(this.baseUrl);
		this.token = options.token ?? resolveGatewayToken();
		this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
	}

	private async request(
		path: string,
		init: { body?: unknown; method: string; signal?: AbortSignal }
	): Promise<unknown> {
		const headers: Record<string, string> = { Accept: "application/json" };
		if (init.body !== undefined) {
			headers["Content-Type"] = "application/json";
		}
		if (this.token) {
			headers.Authorization = `Bearer ${this.token}`;
		}
		const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
			headers,
			method: init.method,
			signal: init.signal,
		});
		const text = await response.text();
		let body: unknown = null;
		if (text.trim() !== "") {
			try {
				body = JSON.parse(text);
			} catch {
				body = text;
			}
		}
		if (!response.ok) {
			const detail = z.object({ error: z.string() }).safeParse(body);
			throw new GatewayEvalError(
				`[ryu-sdk] gateway ${response.status} at ${path}: ${
					detail.success ? detail.data.error : text.slice(0, 500)
				}`,
				response.status
			);
		}
		return body;
	}

	/** Score one completed output with Gateway assertions and/or evaluators. */
	async score(
		request: OnlineScoreRequest,
		signal?: AbortSignal
	): Promise<OnlineScoreResult> {
		const body: Record<string, unknown> = {
			prompt: request.prompt,
			response: request.response,
		};
		if (request.agentId) {
			body.agent_id = request.agentId;
		}
		if (request.assertions && request.assertions.length > 0) {
			body.assertions = request.assertions.map(({ provider, ...rest }) =>
				provider ? { ...rest, provider } : rest
			);
		}
		if (request.context !== undefined) {
			body.context = request.context;
		}
		if (request.evaluators && request.evaluators.length > 0) {
			body.evaluators = request.evaluators;
		}
		if (request.expected !== undefined) {
			body.expected = request.expected;
		}
		if (request.id) {
			body.id = request.id;
		}
		if (request.model) {
			body.model = request.model;
		}
		if (request.vars) {
			body.vars = request.vars;
		}
		const parsed = onlineScoreSchema.safeParse(
			await this.request("/v1/evals/score", { body, method: "POST", signal })
		);
		if (!parsed.success) {
			throw new GatewayEvalError(
				"[ryu-sdk] gateway returned an unexpected /v1/evals/score body"
			);
		}
		return {
			assertions: parsed.data.score.assertions,
			evaluators: parsed.data.score.evaluators ?? [],
		};
	}

	/** The evaluator catalog (fetched once per client). */
	evaluators(): Promise<GatewayEvaluatorInfo[]> {
		if (!this.catalog) {
			this.catalog = this.request("/v1/evaluators", { method: "GET" }).then(
				(body) => {
					const parsed = catalogSchema.safeParse(body);
					if (!parsed.success) {
						throw new GatewayEvalError(
							"[ryu-sdk] gateway returned an unexpected /v1/evaluators body"
						);
					}
					return parsed.data.evaluators;
				}
			);
			// A failed lookup must not poison later calls.
			this.catalog.catch(() => {
				this.catalog = null;
			});
		}
		return this.catalog;
	}

	/** Embed `input` texts with `model`, in input order. */
	async embed(
		model: string,
		input: string[],
		signal?: AbortSignal
	): Promise<number[][]> {
		const parsed = embeddingsSchema.safeParse(
			await this.request("/v1/embeddings", {
				body: { input, model },
				method: "POST",
				signal,
			})
		);
		if (!parsed.success || parsed.data.data.length !== input.length) {
			throw new GatewayEvalError(
				"[ryu-sdk] gateway returned an unexpected /v1/embeddings body"
			);
		}
		const ordered = [...parsed.data.data].sort(
			(a, b) => (a.index ?? 0) - (b.index ?? 0)
		);
		return ordered.map((row) => row.embedding);
	}
}

let sharedClient: GatewayEvalClient | null = null;

/** The process-wide default client (lazily built from the environment). */
export function defaultGatewayEvalClient(): GatewayEvalClient {
	sharedClient ??= new GatewayEvalClient();
	return sharedClient;
}
