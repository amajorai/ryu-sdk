/**
 * Branch and loop conditions.
 *
 * A condition is either a JavaScript predicate (runs only in the local
 * executor) or a {@link CoreCondition} built with {@link when}, which carries
 * an expression in Core's condition grammar and evaluates identically in both
 * places. Core compares against the step value as text: a string value is used
 * as is, any other value as its JSON encoding (the same text a Core script step
 * emits).
 */

/** What a predicate condition receives. */
export interface ConditionContext<T> {
	getInitData<TInit = unknown>(): TInit;
	getStepResult<TResult = unknown>(stepId: string): TResult | undefined;
	inputData: T;
	state: Readonly<Record<string, unknown>>;
}

/** A local-only predicate condition. */
export type ConditionFn<T> = (
	context: ConditionContext<T>
) => boolean | Promise<boolean>;

const CORE_CONDITION = "core-condition";

/** A condition expressed in Core's grammar, portable to Core workflows. */
export interface CoreCondition {
	readonly expr: string;
	readonly kind: typeof CORE_CONDITION;
}

/** Any condition accepted by `.branch`, `.dowhile`, and `.dountil`. */
export type Condition<T> = ConditionFn<T> | CoreCondition;

/** True when `condition` compiles to Core. */
export function isCoreCondition<T>(
	condition: Condition<T>
): condition is CoreCondition {
	return (
		typeof condition === "object" &&
		condition !== null &&
		condition.kind === CORE_CONDITION
	);
}

function quote(value: string): string {
	return `"${value}"`;
}

function core(expr: string): CoreCondition {
	return { kind: CORE_CONDITION, expr };
}

/**
 * Builders for portable conditions. Each compiles to a Core `condition` /
 * `while` expression and evaluates locally with the same semantics.
 *
 * @example
 * ```ts
 * workflow.branch([
 *   [when.contains("urgent"), escalate],
 *   [when.nonEmpty(), triage],
 * ]);
 * workflow.dountil(refine, when.gte(0.9));
 * ```
 */
export const when = {
	/** The value's text equals `value`. */
	equals: (value: string | number | boolean): CoreCondition =>
		core(`input == ${quote(String(value))}`),
	/** The value's text differs from `value`. */
	notEquals: (value: string | number | boolean): CoreCondition =>
		core(`input != ${quote(String(value))}`),
	/** The value's text contains `text`. */
	contains: (text: string): CoreCondition =>
		core(`input contains ${quote(text)}`),
	/** The value's text starts with `text`. */
	startsWith: (text: string): CoreCondition =>
		core(`input starts_with ${quote(text)}`),
	/** The value's text ends with `text`. */
	endsWith: (text: string): CoreCondition =>
		core(`input ends_with ${quote(text)}`),
	/** The value's text is empty. */
	empty: (): CoreCondition => core("input empty"),
	/** The value's text is not empty. */
	nonEmpty: (): CoreCondition => core("input nonempty"),
	/** The value is a number below `n` (non-numeric values never match). */
	lt: (n: number): CoreCondition => core(`input < ${n}`),
	/** The value is a number at or below `n`. */
	lte: (n: number): CoreCondition => core(`input <= ${n}`),
	/** The value is a number above `n`. */
	gt: (n: number): CoreCondition => core(`input > ${n}`),
	/** The value is a number at or above `n`. */
	gte: (n: number): CoreCondition => core(`input >= ${n}`),
	/** A raw Core condition expression, e.g. `input == "yes"`. */
	expr: (expression: string): CoreCondition => core(expression.trim()),
} as const;

/**
 * The text Core compares a value against: strings verbatim, `null` and
 * `undefined` as the empty string, everything else as JSON.
 */
export function coreText(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (value === undefined || value === null) {
		return "";
	}
	return JSON.stringify(value) ?? "";
}

function stripQuotes(raw: string): string {
	return raw
		.trim()
		.replace(/^"+|"+$/g, "")
		.replace(/^'+|'+$/g, "");
}

const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const SPECIAL_FLOAT = /^[+-]?(inf|infinity|nan)$/i;

/** Parse like Rust's `str::parse::<f64>()`; `undefined` when it would fail. */
function parseF64(raw: string): number | undefined {
	if (DECIMAL.test(raw)) {
		return Number(raw);
	}
	if (SPECIAL_FLOAT.test(raw)) {
		const negative = raw.startsWith("-");
		if (/nan$/i.test(raw)) {
			return Number.NaN;
		}
		return negative ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
	}
	return;
}

type NumericCmp = (left: number, right: number) => boolean;

const STRING_OPS: readonly [string, (input: string, rhs: string) => boolean][] =
	[
		["input ==", (input, rhs) => input === rhs],
		["input !=", (input, rhs) => input !== rhs],
		["input contains", (input, rhs) => input.includes(rhs)],
		["input starts_with", (input, rhs) => input.startsWith(rhs)],
		["input ends_with", (input, rhs) => input.endsWith(rhs)],
	];

// Two-character operators first so `input <= N` is not read as `input < =N`.
const NUMERIC_OPS: readonly [string, NumericCmp][] = [
	["input <=", (l, r) => l <= r],
	["input >=", (l, r) => l >= r],
	["input <", (l, r) => l < r],
	["input >", (l, r) => l > r],
];

/**
 * Evaluate a Core condition expression against a value's text. A faithful
 * port of Core's `eval_condition`, so a local run and a Core run take the same
 * branch for the same value.
 */
export function evalCoreCondition(expression: string, input: string): boolean {
	const expr = expression.trim();
	if (expr === "input empty") {
		return input.length === 0;
	}
	if (expr === "input nonempty") {
		return input.length > 0;
	}
	for (const [prefix, test] of STRING_OPS) {
		if (expr.startsWith(prefix)) {
			return test(input, stripQuotes(expr.slice(prefix.length)));
		}
	}
	for (const [prefix, cmp] of NUMERIC_OPS) {
		if (expr.startsWith(prefix)) {
			const left = parseF64(input.trim());
			const right = parseF64(stripQuotes(expr.slice(prefix.length)));
			return left !== undefined && right !== undefined && cmp(left, right);
		}
	}
	// Core's fallback: truthy when the input equals the raw expression.
	return input === expr;
}

const NEGATIONS: readonly [string, string][] = [
	["input ==", "input !="],
	["input !=", "input =="],
	["input <=", "input >"],
	["input >=", "input <"],
	["input <", "input >="],
	["input >", "input <="],
];

/**
 * The logical negation of a Core expression, used to compile `.dountil` onto
 * Core's `while` node. Core's grammar has no `not`, so `contains`,
 * `starts_with`, and `ends_with` cannot be negated; numeric negations hold for
 * numeric values (a non-numeric value fails both an operator and its negation,
 * exactly as in Core).
 */
export function negateCoreExpr(expression: string): string {
	const expr = expression.trim();
	if (expr === "input empty") {
		return "input nonempty";
	}
	if (expr === "input nonempty") {
		return "input empty";
	}
	for (const [prefix, negated] of NEGATIONS) {
		if (expr.startsWith(prefix)) {
			return `${negated}${expr.slice(prefix.length)}`;
		}
	}
	throw new Error(
		`Core conditions cannot negate "${expr}"; use .dowhile with the opposite condition instead of .dountil`
	);
}

/** Evaluate any condition for the local executor. */
export async function evaluateCondition<T>(
	condition: Condition<T>,
	context: ConditionContext<T>
): Promise<boolean> {
	if (isCoreCondition(condition)) {
		return evalCoreCondition(condition.expr, coreText(context.inputData));
	}
	return Boolean(await condition(context));
}
