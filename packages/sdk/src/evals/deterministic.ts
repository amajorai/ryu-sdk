/**
 * Deterministic, network-free scorers: exact match, contains, regex, JSON
 * Schema, Levenshtein similarity, tool-call accuracy, and completeness.
 */

import {
	formatSchemaIssues,
	fromJsonSchema,
	type SchemaLike,
	validateWithSchema,
} from "../schema/json-schema.ts";
import { isStandardSchema } from "../schema/standard-schema.ts";
import { parseJsonReply } from "../schema/structured-output.ts";
import {
	assertUnitInterval,
	createScorer,
	expectedText,
	skipped,
} from "./scorer.ts";
import type {
	ExpectedToolCall,
	Scorer,
	ScorerInput,
	ToolCallRecord,
} from "./types.ts";

/** Options shared by the text-comparison scorers. */
export interface TextMatchOptions {
	/** Compare case-sensitively (default false). */
	caseSensitive?: boolean;
	/** Override the scorer id (useful when one experiment uses two variants). */
	id?: string;
	/** Trim and collapse whitespace before comparing (default true). */
	normalizeWhitespace?: boolean;
}

function normalizeText(value: string, options: TextMatchOptions): string {
	let text = value;
	if (options.normalizeWhitespace !== false) {
		text = text.replace(/\s+/g, " ").trim();
	}
	return options.caseSensitive ? text : text.toLowerCase();
}

/** 1 when the output equals the expected answer, else 0. */
export function exactMatch(options: TextMatchOptions = {}): Scorer {
	return createScorer({
		description: "Output equals the expected answer",
		id: options.id ?? "exact_match",
		score: ({ expected, output }) => {
			const reference = expectedText(expected);
			if (reference === undefined) {
				return skipped("no expected answer");
			}
			const pass =
				normalizeText(output, options) === normalizeText(reference, options);
			return { pass, score: pass ? 1 : 0 };
		},
	});
}

/** Options for {@link contains}. */
export interface ContainsOptions extends TextMatchOptions {
	/**
	 * Substring(s) the output must contain. Defaults to the case's expected
	 * answer. With several values the score is the fraction found.
	 */
	value?: string | string[];
}

/** Fraction of the required substrings present in the output. */
export function contains(options: ContainsOptions = {}): Scorer {
	return createScorer({
		description: "Output contains the required text",
		id: options.id ?? "contains",
		threshold: 1,
		score: ({ expected, output }) => {
			const fallback = expectedText(expected);
			let needles: string[] = [];
			if (options.value !== undefined) {
				needles = Array.isArray(options.value)
					? options.value
					: [options.value];
			} else if (fallback !== undefined) {
				needles = [fallback];
			}
			if (needles.length === 0) {
				return skipped("no value and no expected answer");
			}
			const haystack = normalizeText(output, options);
			const missing = needles.filter(
				(needle) => !haystack.includes(normalizeText(needle, options))
			);
			return {
				details: { missing },
				reason:
					missing.length === 0
						? "all required text found"
						: `missing: ${missing.join(", ")}`,
				score: (needles.length - missing.length) / needles.length,
			};
		},
	});
}

/** Options for {@link regex}. */
export interface RegexOptions {
	id?: string;
	/** Pass when the pattern does NOT match (default false). */
	negate?: boolean;
	pattern: RegExp | string;
}

/** 1 when the output matches the pattern (or does not, with `negate`). */
export function regex(options: RegexOptions): Scorer {
	const pattern =
		typeof options.pattern === "string"
			? new RegExp(options.pattern)
			: new RegExp(options.pattern.source, options.pattern.flags);
	return createScorer({
		description: `Output ${options.negate ? "does not match" : "matches"} ${pattern}`,
		id: options.id ?? "regex",
		score: ({ output }) => {
			pattern.lastIndex = 0;
			const match = pattern.exec(output);
			const pass = options.negate ? match === null : match !== null;
			return {
				details: match ? { match: match[0] } : undefined,
				pass,
				score: pass ? 1 : 0,
			};
		},
	});
}

/** Options for {@link jsonSchema}. */
export interface JsonSchemaScorerOptions {
	id?: string;
	/** A JSON Schema object or any Standard Schema (zod 4, valibot, …). */
	schema: SchemaLike;
}

/**
 * 1 when the output parses as JSON (a bare document, a fenced block, or one
 * object/array embedded in prose) and validates against `schema`.
 */
export function jsonSchema(options: JsonSchemaScorerOptions): Scorer {
	const schema = isStandardSchema(options.schema)
		? options.schema
		: fromJsonSchema(options.schema);
	return createScorer({
		description: "Output is JSON that matches the schema",
		id: options.id ?? "json_schema",
		score: async ({ output }) => {
			const parsed = parseJsonReply(output);
			if (!parsed.ok) {
				return { pass: false, reason: parsed.error, score: 0 };
			}
			const result = await validateWithSchema(schema, parsed.value);
			if (!result.ok) {
				return {
					details: { issues: result.issues },
					pass: false,
					reason: formatSchemaIssues(result.issues),
					score: 0,
				};
			}
			return { pass: true, score: 1 };
		},
	});
}

/** Edit distance between two strings (insert, delete, substitute = 1). */
export function levenshteinDistance(a: string, b: string): number {
	if (a === b) {
		return 0;
	}
	const left = [...a];
	const right = [...b];
	if (left.length === 0) {
		return right.length;
	}
	if (right.length === 0) {
		return left.length;
	}
	let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
	for (const [i, leftChar] of left.entries()) {
		const current = [i + 1];
		for (const [j, rightChar] of right.entries()) {
			const substitution =
				(previous[j] ?? 0) + (leftChar === rightChar ? 0 : 1);
			const insertion = (current[j] ?? 0) + 1;
			const deletion = (previous[j + 1] ?? 0) + 1;
			current.push(Math.min(substitution, insertion, deletion));
		}
		previous = current;
	}
	return previous[right.length] ?? 0;
}

/** Options for {@link levenshtein}. */
export interface LevenshteinOptions extends TextMatchOptions {
	/** Minimum similarity to pass (default 0.8). */
	threshold?: number;
}

/**
 * Normalized edit similarity to the expected answer:
 * `1 - distance / max(length)`, so identical text scores 1.
 */
export function levenshtein(options: LevenshteinOptions = {}): Scorer {
	const threshold = options.threshold ?? 0.8;
	assertUnitInterval(threshold, "levenshtein threshold");
	return createScorer({
		description: "Edit similarity to the expected answer",
		id: options.id ?? "levenshtein",
		threshold,
		score: ({ expected, output }) => {
			const reference = expectedText(expected);
			if (reference === undefined) {
				return skipped("no expected answer");
			}
			const a = normalizeText(output, options);
			const b = normalizeText(reference, options);
			const longest = Math.max([...a].length, [...b].length);
			const distance = levenshteinDistance(a, b);
			return {
				details: { distance },
				score: longest === 0 ? 1 : 1 - distance / longest,
			};
		},
	});
}

/** Options for {@link toolCallAccuracy}. */
export interface ToolCallAccuracyOptions {
	/** Tool calls to expect when a case does not list `expectedToolCalls`. */
	expected?: ExpectedToolCall[];
	id?: string;
	/** Require the expected calls in this relative order (default false). */
	ordered?: boolean;
	/** Penalize calls to tools that were not expected (default false). */
	strict?: boolean;
}

function argumentsMatch(
	expected: Record<string, unknown> | undefined,
	actual: unknown
): boolean {
	if (!expected) {
		return true;
	}
	if (typeof actual !== "object" || actual === null) {
		return Object.keys(expected).length === 0;
	}
	const record = new Map(Object.entries(actual));
	return Object.entries(expected).every(
		([key, value]) =>
			record.has(key) &&
			JSON.stringify(record.get(key)) === JSON.stringify(value)
	);
}

function matchCalls(
	expected: readonly ExpectedToolCall[],
	actual: readonly ToolCallRecord[],
	ordered: boolean
): { matched: number; missing: string[]; used: Set<number> } {
	const used = new Set<number>();
	const missing: string[] = [];
	let cursor = 0;
	for (const call of expected) {
		const start = ordered ? cursor : 0;
		let found = -1;
		for (let index = start; index < actual.length; index += 1) {
			const candidate = actual[index];
			if (
				!used.has(index) &&
				candidate?.name === call.name &&
				argumentsMatch(call.input, candidate.input)
			) {
				found = index;
				break;
			}
		}
		if (found === -1) {
			missing.push(call.name);
		} else {
			used.add(found);
			cursor = found + 1;
		}
	}
	return { matched: expected.length - missing.length, missing, used };
}

/**
 * Fraction of expected tool calls the agent made (by name, with a subset
 * match on arguments). With `strict`, unexpected calls count against the
 * score; with `ordered`, expected calls must appear in sequence. When no tool
 * calls are expected, the case passes only if the agent called none.
 */
export function toolCallAccuracy(
	options: ToolCallAccuracyOptions = {}
): Scorer {
	return createScorer({
		description: "Agent called the expected tools",
		id: options.id ?? "tool_call_accuracy",
		threshold: 1,
		score: ({ expectedToolCalls, toolCalls }: ScorerInput) => {
			const expected = expectedToolCalls ?? options.expected;
			if (expected === undefined) {
				return skipped("no expected tool calls");
			}
			if (expected.length === 0) {
				const pass = toolCalls.length === 0;
				return {
					reason: pass
						? "no tools called, as expected"
						: `unexpected calls: ${toolCalls.map((call) => call.name).join(", ")}`,
					score: pass ? 1 : 0,
				};
			}
			const { matched, missing, used } = matchCalls(
				expected,
				toolCalls,
				options.ordered === true
			);
			const unexpected = toolCalls
				.filter((_, index) => !used.has(index))
				.map((call) => call.name);
			const denominator =
				expected.length + (options.strict ? unexpected.length : 0);
			const reasons: string[] = [];
			if (missing.length > 0) {
				reasons.push(`missing: ${missing.join(", ")}`);
			}
			if (options.strict && unexpected.length > 0) {
				reasons.push(`unexpected: ${unexpected.join(", ")}`);
			}
			return {
				details: { missing, unexpected },
				reason:
					reasons.length > 0 ? reasons.join("; ") : "all expected tools called",
				score: matched / denominator,
			};
		},
	});
}

/** Words ignored when measuring completeness. */
const STOP_WORDS = new Set(
	"a an and are as at be but by for from has have in is it its of on or that the this to was were will with what which who why how".split(
		" "
	)
);

/** Lowercased content words of `text` (letters/digits, stop words removed). */
export function contentTerms(text: string): Set<string> {
	const terms = new Set<string>();
	for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
		const term = match[0];
		if (term.length > 1 && !STOP_WORDS.has(term)) {
			terms.add(term);
		}
	}
	return terms;
}

/** Options for {@link completeness}. */
export interface CompletenessOptions {
	id?: string;
	/** Minimum coverage to pass (default 0.7). */
	threshold?: number;
}

/**
 * Coverage of the reference's content words in the output: the fraction of
 * distinct non-stop-words from the expected answer (or, without one, from the
 * input) that the output mentions.
 */
export function completeness(options: CompletenessOptions = {}): Scorer {
	const threshold = options.threshold ?? 0.7;
	assertUnitInterval(threshold, "completeness threshold");
	return createScorer({
		description: "Output covers the reference's key terms",
		id: options.id ?? "completeness",
		threshold,
		score: ({ expected, input, output }) => {
			const reference = expectedText(expected) ?? input;
			const required = contentTerms(reference);
			if (required.size === 0) {
				return skipped("reference has no content words");
			}
			const present = contentTerms(output);
			const missing = [...required].filter((term) => !present.has(term));
			return {
				details: { missing },
				score: (required.size - missing.length) / required.size,
			};
		},
	});
}
