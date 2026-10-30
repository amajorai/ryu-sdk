/**
 * `runExperiment`: run an agent (or any function) over a dataset, score every
 * case with a set of scorers, aggregate, and check thresholds. Optionally
 * upload the run to a Core prompt suite so it appears beside Desktop runs.
 */

import type { AgentEvent } from "../agent/loop.ts";
import type { Dataset } from "./dataset.ts";
import { createDataset } from "./dataset.ts";
import { assertUnitInterval, runScorer } from "./scorer.ts";
import type {
	CaseScore,
	EvalItem,
	ExperimentCaseResult,
	ExperimentResult,
	Scorer,
	ScorerAggregate,
	ThresholdCheck,
	ToolCallRecord,
} from "./types.ts";

/** Anything with the SDK `Agent.stream` shape (an `Agent`, or a test double). */
export interface ExperimentAgent {
	stream(prompt: string, signal?: AbortSignal): AsyncIterable<AgentEvent>;
}

/** What a function target may return. */
export type TargetOutput =
	| string
	| { output: string; toolCalls?: ToolCallRecord[] };

/** A function under test. */
export type ExperimentFn = (
	item: EvalItem,
	context: { signal: AbortSignal }
) => TargetOutput | Promise<TargetOutput>;

/** Options for {@link runExperiment}. Pass exactly one of `agent` or `fn`. */
export interface RunExperimentOptions {
	/** An SDK agent; its final text and tool calls are scored. */
	agent?: ExperimentAgent;
	/** Cases run in parallel (default 4, at most 64). */
	concurrency?: number;
	/** The cases: a `Dataset` or a plain item array. */
	dataset: Dataset | readonly EvalItem[];
	/** Any function from an item to its output. */
	fn?: ExperimentFn;
	/** Experiment name (defaults to the dataset name). */
	name?: string;
	/** Called after each case finishes, in completion order. */
	onCaseComplete?: (result: ExperimentCaseResult) => void;
	/** Scorers applied to every case. Ids must be unique. */
	scorers: readonly Scorer[];
	/** Cancels the whole experiment. */
	signal?: AbortSignal;
	/**
	 * Minimum mean score: one number for every scorer, or per scorer id. A
	 * scorer that never executed fails its threshold.
	 */
	thresholds?: number | Record<string, number>;
	/** Per-case deadline for the target, in milliseconds. */
	timeoutMs?: number;
}

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 64;

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function runAgent(
	agent: ExperimentAgent,
	prompt: string,
	signal: AbortSignal
): Promise<{ output: string; toolCalls: ToolCallRecord[] }> {
	const toolCalls: ToolCallRecord[] = [];
	const byId = new Map<string, ToolCallRecord>();
	let output: string | null = null;
	let streamed = "";
	for await (const event of agent.stream(prompt, signal)) {
		switch (event.type) {
			case "text":
				streamed += event.content;
				break;
			case "tool_call": {
				const record: ToolCallRecord = { input: event.input, name: event.name };
				toolCalls.push(record);
				byId.set(event.id, record);
				break;
			}
			case "tool_result": {
				const record = byId.get(event.id);
				if (record) {
					record.output = event.output;
				}
				break;
			}
			case "result":
				output = event.text;
				break;
			case "error":
				throw new Error(event.message);
			case "approval_requested":
				throw new Error(
					`the agent paused for approval (${event.summary}); evals cannot answer approvals`
				);
			case "auth_required":
				throw new Error(
					`the agent needs an account connection for ${event.tool}`
				);
			default:
				break;
		}
	}
	return { output: output ?? streamed, toolCalls };
}

async function runTarget(
	options: RunExperimentOptions,
	item: EvalItem,
	signal: AbortSignal
): Promise<{ output: string; toolCalls: ToolCallRecord[] }> {
	if (options.agent) {
		return runAgent(options.agent, item.input, signal);
	}
	if (!options.fn) {
		throw new TypeError("runExperiment needs an agent or fn");
	}
	const value = await options.fn(item, { signal });
	if (typeof value === "string") {
		return { output: value, toolCalls: [] };
	}
	return { output: value.output, toolCalls: value.toolCalls ?? [] };
}

function caseSignal(
	parent: AbortSignal | undefined,
	timeoutMs: number | undefined
): { dispose: () => void; signal: AbortSignal } {
	const controller = new AbortController();
	const abort = () => controller.abort(parent?.reason);
	parent?.addEventListener("abort", abort, { once: true });
	if (parent?.aborted) {
		controller.abort(parent.reason);
	}
	const timer =
		timeoutMs === undefined
			? null
			: setTimeout(
					() =>
						controller.abort(new Error(`case timed out after ${timeoutMs}ms`)),
					timeoutMs
				);
	return {
		dispose: () => {
			if (timer) {
				clearTimeout(timer);
			}
			parent?.removeEventListener("abort", abort);
		},
		signal: controller.signal,
	};
}

/** Reject when `signal` aborts, so a target that ignores it still stops. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		return Promise.reject(signal.reason ?? new Error("aborted"));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason ?? new Error("aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			}
		);
	});
}

async function runCase(
	options: RunExperimentOptions,
	item: EvalItem,
	id: string
): Promise<ExperimentCaseResult> {
	const started = performance.now();
	const { dispose, signal } = caseSignal(options.signal, options.timeoutMs);
	const base = {
		expected: item.expected,
		id,
		input: item.input,
		metadata: item.metadata,
	};
	let output = "";
	let toolCalls: ToolCallRecord[] = [];
	try {
		({ output, toolCalls } = await abortable(
			runTarget(options, item, signal),
			signal
		));
	} catch (error) {
		return {
			...base,
			durationMs: performance.now() - started,
			error: describeError(error),
			output: "",
			pass: false,
			scores: {},
			toolCalls,
		};
	} finally {
		dispose();
	}
	const durationMs = performance.now() - started;
	const scores: Record<string, CaseScore> = {};
	const results = await Promise.all(
		options.scorers.map((scorer) =>
			runScorer(scorer, {
				context: item.context,
				expected: item.expected,
				expectedToolCalls: item.expectedToolCalls,
				input: item.input,
				metadata: item.metadata,
				output,
				signal: options.signal,
				toolCalls,
			})
		)
	);
	for (const [index, scorer] of options.scorers.entries()) {
		const result = results[index];
		if (result) {
			scores[scorer.id] = result;
		}
	}
	const pass = Object.values(scores).every(
		(score) => score.skipped || score.pass
	);
	return { ...base, durationMs, output, pass, scores, toolCalls };
}

function aggregate(
	cases: readonly ExperimentCaseResult[],
	scorers: readonly Scorer[]
): Record<string, ScorerAggregate> {
	const result: Record<string, ScorerAggregate> = {};
	for (const scorer of scorers) {
		let executed = 0;
		let skippedCount = 0;
		let total = 0;
		let passed = 0;
		for (const entry of cases) {
			const score = entry.scores[scorer.id];
			if (!score) {
				continue;
			}
			if (score.skipped) {
				skippedCount += 1;
				continue;
			}
			executed += 1;
			total += score.score;
			passed += score.pass ? 1 : 0;
		}
		result[scorer.id] = {
			executed,
			mean: executed === 0 ? null : total / executed,
			passRate: executed === 0 ? null : passed / executed,
			skipped: skippedCount,
		};
	}
	return result;
}

/**
 * Resolve and validate the threshold option against the scorer ids. Runs
 * before any case so a typo'd scorer id or an out-of-range minimum fails fast
 * instead of after a full (possibly paid) experiment.
 */
function resolveThresholds(
	thresholds: RunExperimentOptions["thresholds"],
	scorerIds: ReadonlySet<string>
): [string, number][] {
	if (thresholds === undefined) {
		return [];
	}
	const entries: [string, number][] =
		typeof thresholds === "number"
			? [...scorerIds].map((id) => [id, thresholds])
			: Object.entries(thresholds);
	for (const [scorer, threshold] of entries) {
		assertUnitInterval(threshold, `threshold for '${scorer}'`);
		if (!scorerIds.has(scorer)) {
			throw new TypeError(`threshold names unknown scorer '${scorer}'`);
		}
	}
	return entries;
}

function thresholdChecks(
	entries: readonly [string, number][],
	scores: Record<string, ScorerAggregate>
): ThresholdCheck[] {
	return entries.map(([scorer, threshold]) => {
		const mean = scores[scorer]?.mean ?? null;
		return {
			mean,
			pass: mean !== null && mean >= threshold,
			scorer,
			threshold,
		};
	});
}

function resolveConcurrency(value: number | undefined): number {
	const concurrency = value ?? DEFAULT_CONCURRENCY;
	if (
		!Number.isInteger(concurrency) ||
		concurrency < 1 ||
		concurrency > MAX_CONCURRENCY
	) {
		throw new RangeError(
			`concurrency must be an integer from 1 to ${MAX_CONCURRENCY}`
		);
	}
	return concurrency;
}

function isDataset(value: Dataset | readonly EvalItem[]): value is Dataset {
	return !Array.isArray(value) && "items" in value;
}

/**
 * Run a dataset through an agent or function and score every case.
 *
 * ```ts
 * const result = await runExperiment({
 *   agent,
 *   dataset: await loadDataset("evals/qa.jsonl"),
 *   scorers: [exactMatch(), answerRelevancy()],
 *   thresholds: { exact_match: 0.9 },
 * });
 * if (!result.pass) process.exitCode = 1;
 * ```
 */
export async function runExperiment(
	options: RunExperimentOptions
): Promise<ExperimentResult> {
	if (Boolean(options.agent) === Boolean(options.fn)) {
		throw new TypeError("runExperiment needs exactly one of agent or fn");
	}
	if (options.scorers.length === 0) {
		throw new TypeError("runExperiment needs at least one scorer");
	}
	const ids = new Set<string>();
	for (const scorer of options.scorers) {
		if (ids.has(scorer.id)) {
			throw new TypeError(
				`duplicate scorer id '${scorer.id}'; pass a distinct id option`
			);
		}
		ids.add(scorer.id);
	}
	const concurrency = resolveConcurrency(options.concurrency);
	const thresholdEntries = resolveThresholds(options.thresholds, ids);
	const dataset = isDataset(options.dataset)
		? options.dataset
		: createDataset(options.name ?? "experiment", options.dataset);
	const items = dataset.items;
	const startedAt = new Date().toISOString();
	const cases: ExperimentCaseResult[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			options.signal?.throwIfAborted();
			const index = next;
			next += 1;
			const item = items[index];
			if (!item) {
				continue;
			}
			const result = await runCase(
				options,
				item,
				item.id ?? `case-${index + 1}`
			);
			cases[index] = result;
			options.onCaseComplete?.(result);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, worker)
	);
	const scores = aggregate(cases, options.scorers);
	const thresholds = thresholdChecks(thresholdEntries, scores);
	const errored = cases.filter((entry) => entry.error !== undefined).length;
	return {
		cases,
		errored,
		finishedAt: new Date().toISOString(),
		name: options.name ?? dataset.name,
		pass: errored === 0 && thresholds.every((check) => check.pass),
		scores,
		startedAt,
		thresholds,
	};
}
