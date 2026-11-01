/**
 * Shared types for `@ryuhq/sdk/evals`: dataset items, scorer contracts, and
 * experiment results.
 */

/** One tool call an agent made while answering a case. */
export interface ToolCallRecord {
	/** Arguments the model passed to the tool. */
	input: unknown;
	/** Model-facing tool name. */
	name: string;
	/** What the tool returned (absent when it never completed). */
	output?: unknown;
}

/** An expected tool call for `toolCallAccuracy`. */
export interface ExpectedToolCall {
	/**
	 * Arguments that must match. Only the listed keys are compared (a subset
	 * match), so unrelated arguments the model adds do not fail the case.
	 */
	input?: Record<string, unknown>;
	name: string;
}

/** One case in an eval dataset. */
export interface EvalItem {
	/** Reference context for faithfulness-style scorers (documents, facts). */
	context?: unknown;
	/** Reference answer. Strings are compared as text; other values as JSON. */
	expected?: unknown;
	/** Tool calls the agent is expected to make, for `toolCallAccuracy`. */
	expectedToolCalls?: ExpectedToolCall[];
	/** Stable case id used in results and uploads. */
	id?: string;
	/** The prompt sent to the agent or function under test. */
	input: string;
	/** Free-form metadata preserved in results. */
	metadata?: Record<string, unknown>;
}

/** Everything a scorer sees about one case. */
export interface ScorerInput {
	context?: unknown;
	expected?: unknown;
	expectedToolCalls?: ExpectedToolCall[];
	/** The prompt the case sent. */
	input: string;
	metadata?: Record<string, unknown>;
	/** The final text the agent or function produced. */
	output: string;
	/** Cancellation for scorers that call the network. */
	signal?: AbortSignal;
	/** Tool calls observed while producing `output` (agents only). */
	toolCalls: ToolCallRecord[];
}

/** What a scorer returns for one case. */
export interface ScoreResult {
	/** Free-form details (judge text, distances, matched spans). */
	details?: Record<string, unknown>;
	/**
	 * Whether this case passed. Defaults to `score >= threshold` (the scorer's
	 * threshold, else 0.5) when omitted.
	 */
	pass?: boolean;
	/** Human-readable explanation. */
	reason?: string;
	/** Normalized score in [0, 1], higher is better. */
	score: number;
	/**
	 * True when the scorer could not run for this case (for example a missing
	 * reference). Skipped results are excluded from aggregates instead of
	 * counting as zero.
	 */
	skipped?: boolean;
}

/** A named scoring function. Build one with `createScorer`. */
export interface Scorer {
	/** One-line description shown in reports. */
	readonly description?: string;
	/** Stable id used as the key in results and thresholds. */
	readonly id: string;
	/** Score one case. */
	score(input: ScorerInput): Promise<ScoreResult> | ScoreResult;
	/** Default pass threshold for this scorer's cases (0.5 when unset). */
	readonly threshold?: number;
}

/** A scored case result for one scorer, normalized. */
export interface CaseScore {
	details?: Record<string, unknown>;
	pass: boolean;
	reason?: string;
	score: number;
	skipped: boolean;
}

/** Per-case experiment result. */
export interface ExperimentCaseResult {
	/** Wall time spent producing the output, in milliseconds. */
	durationMs: number;
	/** Set when the target threw; scorers are not run for an errored case. */
	error?: string;
	expected?: unknown;
	id: string;
	input: string;
	metadata?: Record<string, unknown>;
	output: string;
	/** True when the target succeeded and every executed scorer passed. */
	pass: boolean;
	/** Results keyed by scorer id. */
	scores: Record<string, CaseScore>;
	toolCalls: ToolCallRecord[];
}

/** Aggregate for one scorer across the experiment. */
export interface ScorerAggregate {
	/** Cases the scorer actually executed (not skipped, not errored). */
	executed: number;
	/** Mean score over executed cases; null when none executed. */
	mean: number | null;
	/** Fraction of executed cases that passed; null when none executed. */
	passRate: number | null;
	/** Cases the scorer skipped. */
	skipped: number;
}

/** A threshold the experiment checked. */
export interface ThresholdCheck {
	/** Mean score that was compared (null = never measured, which fails). */
	mean: number | null;
	pass: boolean;
	scorer: string;
	threshold: number;
}

/** The complete result of `runExperiment`. */
export interface ExperimentResult {
	cases: ExperimentCaseResult[];
	/** Cases whose target threw. */
	errored: number;
	finishedAt: string;
	/** Experiment name. */
	name: string;
	/** True when no case errored and every threshold check passed. */
	pass: boolean;
	/** Aggregates keyed by scorer id. */
	scores: Record<string, ScorerAggregate>;
	startedAt: string;
	/** Threshold checks (empty when no thresholds were configured). */
	thresholds: ThresholdCheck[];
}
