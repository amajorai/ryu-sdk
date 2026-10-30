/**
 * `createScorer` and the helpers every built-in scorer shares.
 */

import type { CaseScore, ScoreResult, Scorer, ScorerInput } from "./types.ts";

/** Pass threshold used when neither the result nor the scorer sets one. */
export const DEFAULT_PASS_THRESHOLD = 0.5;

/** Options for {@link createScorer}. */
export interface CreateScorerOptions {
	description?: string;
	/** Stable id: letters, digits, `_`, `-`, `.`, or `:`. */
	id: string;
	/**
	 * Score one case. Return a number in [0, 1] or a full {@link ScoreResult};
	 * out-of-range numbers are clamped.
	 */
	score: (
		input: ScorerInput
	) => number | ScoreResult | Promise<number | ScoreResult>;
	/** Default pass threshold in [0, 1]. */
	threshold?: number;
}

const SCORER_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Throw unless `value` is a finite number in [0, 1]. */
export function assertUnitInterval(value: number, label: string): void {
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		throw new RangeError(`${label} must be a number between 0 and 1`);
	}
}

/** Clamp a finite number into [0, 1]; non-finite becomes 0. */
export function clampScore(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return Math.min(1, Math.max(0, value));
}

/**
 * Define a custom scorer.
 *
 * ```ts
 * const polite = createScorer({
 *   id: "polite",
 *   score: ({ output }) => (/please|thank/i.test(output) ? 1 : 0),
 * });
 * ```
 */
export function createScorer(options: CreateScorerOptions): Scorer {
	if (!SCORER_ID.test(options.id)) {
		throw new TypeError(
			`scorer id '${options.id}' must be 1-128 letters, digits, '_', '-', '.', or ':'`
		);
	}
	if (options.threshold !== undefined) {
		assertUnitInterval(options.threshold, `scorer '${options.id}' threshold`);
	}
	return {
		description: options.description,
		id: options.id,
		threshold: options.threshold,
		score: async (input) => {
			const raw = await options.score(input);
			return typeof raw === "number" ? { score: raw } : raw;
		},
	};
}

/**
 * Run one scorer and normalize its result: the score is clamped, `pass`
 * defaults to the threshold comparison, and a thrown error becomes a failing
 * (not skipped) result so a broken scorer can never look like a pass.
 */
export async function runScorer(
	scorer: Scorer,
	input: ScorerInput
): Promise<CaseScore> {
	try {
		const result = await scorer.score(input);
		const score = clampScore(result.score);
		const skipped = result.skipped === true;
		const threshold = scorer.threshold ?? DEFAULT_PASS_THRESHOLD;
		return {
			details: result.details,
			pass: skipped ? false : (result.pass ?? score >= threshold),
			reason: result.reason,
			score,
			skipped,
		};
	} catch (error) {
		return {
			pass: false,
			reason: `scorer error: ${error instanceof Error ? error.message : String(error)}`,
			score: 0,
			skipped: false,
		};
	}
}

/** Render an expected value as text (strings verbatim, everything else JSON). */
export function expectedText(expected: unknown): string | undefined {
	if (expected === undefined || expected === null) {
		return;
	}
	return typeof expected === "string" ? expected : JSON.stringify(expected);
}

/** A skipped result with a reason. */
export function skipped(reason: string): ScoreResult {
	return { reason, score: 0, skipped: true };
}
