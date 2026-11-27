/**
 * Steps: the units a workflow composes.
 *
 * `createStep` builds a code step from an `execute` function. `agentStep`,
 * `toolStep`, `mcpStep`, and `humanStep` build steps that map onto a dedicated
 * Core node kind, and `nodeStep` passes any other Core node through. Every step
 * runs in the local executor; how it compiles to Core is recorded in its
 * `core` spec.
 */

import type { RunnableContext } from "../runnable/runnable-types.ts";
import type { CoreNodeKind, CoreRawNodeKind } from "./core-types.ts";
import type { StandardSchemaV1 } from "./schema.ts";

/** Retry policy for one step (mirrors Core's per-node `retry`). */
export interface StepRetryPolicy {
	/** Multiplicative backoff growth per retry. Default 2. */
	backoffCoefficient?: number;
	/** Backoff before the first retry, in milliseconds. Default 100. */
	initialIntervalMs?: number;
	/** Total attempts including the first. Default 1 (no retries). */
	maxAttempts?: number;
	/** Ceiling for one backoff interval, in milliseconds. Default 60000. */
	maxIntervalMs?: number;
	/** Case-insensitive error substrings that fail immediately. */
	nonRetryableErrors?: string[];
}

/** Everything a step's `execute` receives. */
export interface StepExecuteContext<
	TInput,
	TResume = unknown,
	TSuspend = unknown,
> {
	/** Publish a custom event on the run's `events` stream. */
	emit(data: unknown): void;
	/** The workflow's validated start input. */
	getInitData<TInit = unknown>(): TInit;
	/** The latest output of an earlier step in this run, by step id. */
	getStepResult<TResult = unknown>(stepId: string): TResult | undefined;
	/** The step's validated input. */
	inputData: TInput;
	/** Present when this step is being resumed after `suspend()`. */
	resumeData?: TResume;
	/** The run id. */
	runId: string;
	/** Runtime context (gateway and primitives) passed to `createRun`. */
	runtime?: RunnableContext;
	/** Merge a patch into the run state shared by every step. */
	setState(patch: Record<string, unknown>): void;
	/** Aborts when the run is cancelled. */
	signal: AbortSignal;
	/** The run state shared by every step. */
	state: Readonly<Record<string, unknown>>;
	/**
	 * Pause the run for human input. The run ends with status `suspended`;
	 * `run.resume({ resumeData })` re-runs this step with `resumeData` set.
	 */
	suspend(payload?: TSuspend): Promise<never>;
	/** The workflow id. */
	workflowId: string;
}

/**
 * How a step compiles to a Core node.
 *
 * - `script`: a Core `script` node. `body` is an async function body in which
 *   `args` is the step input and `agent`, `parallel`, `pipeline`, `log`, and
 *   `phase` are the Core script helpers; `return` sets the output.
 * - `node`: a dedicated Core node kind (agent, tool, mcp, awakeable, …).
 * - `local`: runs only in the local executor; compiling it fails with `reason`.
 */
export type StepCoreSpec =
	| { body: string; kind: "script" }
	| { kind: "node"; node: CoreNodeKind | CoreRawNodeKind }
	| { kind: "local"; reason: string };

/** A workflow step. */
export interface Step<
	TId extends string = string,
	TInput = unknown,
	TOutput = unknown,
	TResume = unknown,
	TSuspend = unknown,
> {
	/** How this step compiles to Core. */
	readonly core: StepCoreSpec;
	readonly description?: string;
	execute(
		context: StepExecuteContext<TInput, TResume, TSuspend>
	): Promise<TOutput>;
	readonly id: TId;
	readonly inputSchema?: StandardSchemaV1<unknown, TInput>;
	readonly kind: "step";
	readonly outputSchema?: StandardSchemaV1<unknown, TOutput>;
	readonly resumeSchema?: StandardSchemaV1<unknown, TResume>;
	readonly retry?: StepRetryPolicy;
	readonly suspendSchema?: StandardSchemaV1<unknown, TSuspend>;
	/** Per-attempt wall-clock limit, in milliseconds. */
	readonly timeoutMs?: number;
}

/** Options shared by every step factory. */
export interface StepCommonOptions<TId extends string> {
	description?: string;
	id: TId;
	retry?: StepRetryPolicy;
	timeoutMs?: number;
}

/** Options for {@link createStep}. */
export interface CreateStepOptions<
	TId extends string,
	TInput,
	TOutput,
	TResume,
	TSuspend,
> extends StepCommonOptions<TId> {
	execute(
		context: StepExecuteContext<TInput, TResume, TSuspend>
	): Promise<TOutput> | TOutput;
	inputSchema?: StandardSchemaV1<unknown, TInput>;
	/**
	 * Mark a step that cannot run on Core (it closes over local state, calls
	 * `suspend`, or uses Node APIs). Compiling a workflow containing it fails
	 * with this reason instead of shipping a script that would break.
	 */
	localOnly?: string;
	outputSchema?: StandardSchemaV1<unknown, TOutput>;
	resumeSchema?: StandardSchemaV1<unknown, TResume>;
	/**
	 * The Core script body for this step. Defaults to the serialized `execute`
	 * function, which must then be self-contained: it runs in Core's sandbox
	 * with `{ inputData, agent, parallel, pipeline, log, phase }`.
	 */
	script?: string;
	suspendSchema?: StandardSchemaV1<unknown, TSuspend>;
}

/** The output type a step produces. */
export type StepOutput<S> =
	S extends Step<string, unknown, infer O> ? O : never;

/** The input type a step accepts. */
export type StepInput<S> = S extends Step<string, infer I, unknown> ? I : never;

/**
 * Turn a function's source into an expression. Method shorthand
 * (`execute({ inputData }) { … }`) is not a valid expression on its own, so it
 * is rewritten as a named function expression.
 */
export function functionExpression(source: string): string {
	const text = source.trim();
	const isExpression =
		/^(async\s+)?function\b/.test(text) ||
		/^(async\s*)?\(/.test(text) ||
		/^(async\s+)?[A-Za-z_$][\w$]*\s*=>/.test(text);
	if (isExpression) {
		return text;
	}
	const method = /^(async\s+)?(\*\s*)?([A-Za-z_$][\w$]*)\s*\(/.exec(text);
	if (!method) {
		return text;
	}
	const asyncPrefix = method[1] ? "async " : "";
	const generator = method[2] ? "*" : "";
	const params = text.slice(method[0].length - 1);
	return `${asyncPrefix}function${generator} ${method[3]}${params}`;
}

/**
 * Context members that exist only in the local executor. On Core they throw a
 * clear error instead of failing with "is not a function". `emit` maps to the
 * script `log` helper, which records progress on the run.
 */
const CORE_SCRIPT_CONTEXT = [
	"inputData: args",
	"agent",
	"parallel",
	"pipeline",
	"log",
	"phase",
	"emit: (data) => log(data)",
	...["suspend", "setState", "getStepResult", "getInitData"].map(
		(name) =>
			`${name}: () => { throw new Error(${JSON.stringify(`${name}() only works in the local executor; on Core use humanStep, node templates, or the step input`)}); }`
	),
].join(", ");

/** The Core script body that calls a serialized `execute`. */
export function scriptBodyForExecute(execute: { toString(): string }): string {
	return `return await (${functionExpression(execute.toString())})({ ${CORE_SCRIPT_CONTEXT} });`;
}

/**
 * Create a code step.
 *
 * Locally the step runs `execute` in-process with schema validation, retries,
 * and `suspend()`. On Core it becomes a `script` node (see `script`).
 *
 * @example
 * ```ts
 * const double = createStep({
 *   id: "double",
 *   inputSchema: z.object({ n: z.number() }),
 *   outputSchema: z.object({ n: z.number() }),
 *   execute: async ({ inputData }) => ({ n: inputData.n * 2 }),
 * });
 * ```
 */
export function createStep<
	TId extends string,
	TInput = unknown,
	TOutput = unknown,
	TResume = unknown,
	TSuspend = unknown,
>(
	options: CreateStepOptions<TId, TInput, TOutput, TResume, TSuspend>
): Step<TId, TInput, TOutput, TResume, TSuspend> {
	let core: StepCoreSpec;
	if (options.localOnly) {
		core = { kind: "local", reason: options.localOnly };
	} else {
		core = {
			kind: "script",
			body: options.script ?? scriptBodyForExecute(options.execute),
		};
	}
	const { execute } = options;
	return {
		kind: "step",
		id: options.id,
		description: options.description,
		inputSchema: options.inputSchema,
		outputSchema: options.outputSchema,
		resumeSchema: options.resumeSchema,
		suspendSchema: options.suspendSchema,
		retry: options.retry,
		timeoutMs: options.timeoutMs,
		core,
		async execute(context) {
			return await execute(context);
		},
	};
}
