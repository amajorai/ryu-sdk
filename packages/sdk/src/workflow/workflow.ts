/**
 * `createWorkflow` — the code-first workflow builder.
 *
 * A workflow is a typed chain of stages built with `.then`, `.parallel`,
 * `.branch`, `.foreach`, `.dowhile`, `.dountil`, `.map`, and `.sleep`, closed
 * with `.commit()`. A committed workflow:
 *
 * - runs in-process with `createRun().start()` / `.stream()` (see
 *   `executor.ts`), including `suspend()` / `resume()` for human input;
 * - compiles to Core's JSON workflow graph with `toCore()` (see `compile.ts`)
 *   so it can be deployed and run durably on a Core node;
 * - is itself a step (nest it in another workflow) and a `Runnable`
 *   (`kind: "workflow"`), so agents and `defineWorkflow` can call it.
 */

import type { Runnable, RunnableContext } from "../runnable/runnable-types.ts";
import { compileWorkflow } from "./compile.ts";
import type { Condition, ConditionContext } from "./conditions.ts";
import {
	type CompiledWorkflow,
	type CoreTrigger,
	DEFAULT_LOOP_ITERATIONS,
} from "./core-types.ts";
import { WorkflowRun, type WorkflowSnapshot } from "./executor.ts";
import type { InferSchema, StandardSchemaV1 } from "./schema.ts";
import { functionExpression, type Step } from "./step.ts";

/** Any step, typed loosely for storage. */
export type AnyStep = Step<string, unknown, unknown, unknown, unknown>;

/** A committed workflow used as a step. */
export interface WorkflowLike<
	TId extends string = string,
	TInput = unknown,
	TOutput = unknown,
> {
	/** Phantom field carrying the type parameters for inference. */
	readonly "~types"?: { readonly input: TInput; readonly output: TOutput };
	readonly description?: string;
	readonly id: TId;
	readonly inputSchema?: StandardSchemaV1<unknown, TInput>;
	readonly kind: "workflow";
	readonly name: string;
	readonly outputSchema?: StandardSchemaV1<unknown, TOutput>;
	readonly stages: readonly Stage[];
}

/** Anything `.then` and friends accept: a step or a nested workflow. */
export type StepLike<TId extends string, TInput, TOutput> =
	| Step<TId, TInput, TOutput, unknown, unknown>
	| WorkflowLike<TId, TInput, TOutput>;

/**
 * Type check that a step's input accepts the current value: resolves to
 * `unknown` (no constraint) when it does, and to an impossible shape naming
 * both types when it does not. An untyped current value (a workflow without
 * `inputSchema`, or after an untyped step) accepts any step; schemas still
 * validate at run time.
 */
export type Accepts<TStepInput, TCurrent> = unknown extends TCurrent
	? unknown
	: [TCurrent] extends [TStepInput]
		? unknown
		: {
				readonly "~error": "the step input type does not accept the current value";
				readonly current: TCurrent;
				readonly expected: TStepInput;
			};

/** Any step or nested workflow. */
export type AnyStepLike = AnyStep | WorkflowLike;

/** The output type of a step or nested workflow. */
export type OutputOf<S> =
	S extends Step<string, unknown, infer O, unknown, unknown>
		? O
		: S extends WorkflowLike<string, unknown, infer O>
			? O
			: never;

/** What a `.map` function receives. */
export type MapContext<T> = ConditionContext<T>;

/** One stage of a workflow program. */
export type Stage =
	| { kind: "step"; step: AnyStepLike }
	| { id: string; kind: "parallel"; steps: AnyStepLike[] }
	| {
			branches: { condition: Condition<unknown>; step: AnyStepLike }[];
			id: string;
			kind: "branch";
	  }
	| { concurrency: number; id: string; kind: "foreach"; step: AnyStepLike }
	| {
			condition: Condition<unknown>;
			id: string;
			kind: "loop";
			maxIterations: number;
			mode: "dowhile" | "dountil";
			step: AnyStepLike;
	  }
	| {
			fn: (context: MapContext<unknown>) => unknown;
			id: string;
			kind: "map";
			script: string;
	  }
	| { id: string; kind: "sleep"; ms: number };

/** Options for {@link createWorkflow}. */
export interface CreateWorkflowOptions<TId extends string, TInput, TOutput> {
	description?: string;
	id: TId;
	inputSchema?: StandardSchemaV1<unknown, TInput>;
	/** Display name on Core; defaults to the id. */
	name?: string;
	outputSchema?: StandardSchemaV1<unknown, TOutput>;
	/** Core triggers to declare when deployed (default manual-only). */
	triggers?: CoreTrigger[];
}

/** Options for {@link Workflow.createRun}. */
export interface CreateRunOptions {
	/** Run id; generated when absent. */
	runId?: string;
	/** Gateway and primitives handed to steps as `runtime`. */
	runtime?: RunnableContext;
	/** Restore a run from a snapshot taken with `run.snapshot()`. */
	snapshot?: WorkflowSnapshot;
}

/** Element type of an array (for `.foreach`). */
export type ElementOf<T> = T extends readonly (infer E)[] ? E : never;

/** A workflow under construction or committed. */
export class Workflow<TId extends string, TInput, TOutput, TCurrent = TInput>
	implements WorkflowLike<TId, TInput, TOutput>, Runnable<TInput, TOutput>
{
	readonly description?: string;
	readonly id: TId;
	readonly inputSchema?: StandardSchemaV1<unknown, TInput>;
	readonly kind = "workflow" as const;
	readonly name: string;
	readonly outputSchema?: StandardSchemaV1<unknown, TOutput>;
	readonly triggers?: CoreTrigger[];
	readonly "~types"?: { readonly input: TInput; readonly output: TOutput };
	readonly #stages: Stage[] = [];
	#committed = false;
	#stageCount = 0;
	#compiled: CompiledWorkflow | undefined;

	constructor(options: CreateWorkflowOptions<TId, TInput, TOutput>) {
		if (!options.id.trim()) {
			throw new Error("createWorkflow: id must be a non-empty string");
		}
		this.id = options.id;
		this.name = options.name ?? options.id;
		this.description = options.description;
		this.inputSchema = options.inputSchema;
		this.outputSchema = options.outputSchema;
		this.triggers = options.triggers;
	}

	/** The stages in order. */
	get stages(): readonly Stage[] {
		return this.#stages;
	}

	/** True once `.commit()` has been called. */
	get committed(): boolean {
		return this.#committed;
	}

	#push<TNext>(stage: Stage): Workflow<TId, TInput, TOutput, TNext> {
		if (this.#committed) {
			throw new Error(
				`workflow "${this.id}" is committed; build a new workflow to add steps`
			);
		}
		this.#stages.push(stage);
		return this as unknown as Workflow<TId, TInput, TOutput, TNext>;
	}

	#nextId(kind: string): string {
		this.#stageCount += 1;
		return `${kind}_${this.#stageCount}`;
	}

	/**
	 * Run a step (or nested workflow) on the current value.
	 *
	 * Named `then` for parity with Mastra and LangGraph chains. That makes a
	 * workflow look thenable, so `await workflow` would call it with a
	 * resolver function: that case throws instead of adding a bogus step.
	 */
	// biome-ignore lint/suspicious/noThenProperty: the chain method is the DSL's public API; awaiting a workflow is rejected below.
	then<TStepId extends string, TStepInput, TOut>(
		step: StepLike<TStepId, TStepInput, TOut> & Accepts<TStepInput, TCurrent>
	): Workflow<TId, TInput, TOutput, TOut> {
		if (typeof step === "function") {
			throw new TypeError(
				`workflow "${this.id}" is not awaitable; call createRun().start() to run it`
			);
		}
		return this.#push<TOut>({ kind: "step", step: step as AnyStepLike });
	}

	/**
	 * Run several steps concurrently on the current value. The output is an
	 * object keyed by step id.
	 */
	parallel<const TSteps extends readonly AnyStepLike[]>(
		steps: TSteps
	): Workflow<
		TId,
		TInput,
		TOutput,
		{ [S in TSteps[number] as S["id"]]: OutputOf<S> }
	> {
		if (steps.length === 0) {
			throw new Error(".parallel() needs at least one step");
		}
		assertUniqueIds(
			steps.map((step) => step.id),
			".parallel()"
		);
		return this.#push({
			kind: "parallel",
			id: this.#nextId("parallel"),
			steps: [...steps],
		});
	}

	/**
	 * Run every step whose condition holds (concurrently). The output is an
	 * object keyed by the ids of the steps that ran.
	 */
	branch<
		const TBranches extends readonly (readonly [
			Condition<TCurrent>,
			AnyStepLike,
		])[],
	>(
		branches: TBranches
	): Workflow<
		TId,
		TInput,
		TOutput,
		{ [S in TBranches[number][1] as S["id"]]?: OutputOf<S> }
	> {
		if (branches.length === 0) {
			throw new Error(".branch() needs at least one [condition, step] pair");
		}
		assertUniqueIds(
			branches.map(([, step]) => step.id),
			".branch()"
		);
		return this.#push({
			kind: "branch",
			id: this.#nextId("branch"),
			branches: branches.map(([condition, step]) => ({
				condition: condition as Condition<unknown>,
				step,
			})),
		});
	}

	/** Run a step once per element of the current (array) value. */
	foreach<TStepId extends string, TStepInput, TOut>(
		step: StepLike<TStepId, TStepInput, TOut> &
			Accepts<TStepInput, ElementOf<TCurrent>>,
		options: { concurrency?: number } = {}
	): Workflow<TId, TInput, TOutput, TOut[]> {
		const concurrency = options.concurrency ?? 1;
		if (!Number.isInteger(concurrency) || concurrency < 1) {
			throw new Error(".foreach() concurrency must be a positive integer");
		}
		return this.#push({
			kind: "foreach",
			id: this.#nextId("foreach"),
			step: step as AnyStepLike,
			concurrency,
		});
	}

	#loop<TStepId extends string, TStepInput, TOut>(
		mode: "dowhile" | "dountil",
		step: StepLike<TStepId, TStepInput, TOut> &
			Accepts<TStepInput, TCurrent | TOut>,
		condition: Condition<TOut>,
		options: { maxIterations?: number }
	): Workflow<TId, TInput, TOutput, TOut> {
		const maxIterations = options.maxIterations ?? DEFAULT_LOOP_ITERATIONS;
		if (!Number.isInteger(maxIterations) || maxIterations < 1) {
			throw new Error(`.${mode}() maxIterations must be a positive integer`);
		}
		return this.#push({
			kind: "loop",
			id: this.#nextId(mode),
			mode,
			step: step as AnyStepLike,
			condition: condition as Condition<unknown>,
			maxIterations,
		});
	}

	/**
	 * Run `step` on its own output while `condition` holds (checked after each
	 * pass, so the step runs at least once). `maxIterations` (default 100)
	 * bounds the total passes; reaching it ends the loop with the last output.
	 */
	dowhile<TStepId extends string, TStepInput, TOut>(
		step: StepLike<TStepId, TStepInput, TOut> &
			Accepts<TStepInput, TCurrent | TOut>,
		condition: Condition<TOut>,
		options: { maxIterations?: number } = {}
	): Workflow<TId, TInput, TOutput, TOut> {
		return this.#loop("dowhile", step, condition, options);
	}

	/** Like `.dowhile`, but loops until `condition` holds. */
	dountil<TStepId extends string, TStepInput, TOut>(
		step: StepLike<TStepId, TStepInput, TOut> &
			Accepts<TStepInput, TCurrent | TOut>,
		condition: Condition<TOut>,
		options: { maxIterations?: number } = {}
	): Workflow<TId, TInput, TOutput, TOut> {
		return this.#loop("dountil", step, condition, options);
	}

	/**
	 * Reshape the current value. On Core the function is serialized into a
	 * script node with `{ inputData }`, so it must be self-contained; pass
	 * `script` to supply the Core body yourself.
	 */
	map<TOut>(
		fn: (context: MapContext<TCurrent>) => TOut | Promise<TOut>,
		options: { id?: string; script?: string } = {}
	): Workflow<TId, TInput, TOutput, Awaited<TOut>> {
		const script =
			options.script ??
			`return await (${functionExpression(fn.toString())})({ inputData: args });`;
		return this.#push({
			kind: "map",
			id: options.id ?? this.#nextId("map"),
			fn: fn as (context: MapContext<unknown>) => unknown,
			script,
		});
	}

	/** Pause for `ms` milliseconds (a durable timer on Core). */
	sleep(ms: number): Workflow<TId, TInput, TOutput, TCurrent> {
		if (!Number.isInteger(ms) || ms < 0) {
			throw new Error(".sleep() needs a non-negative integer of milliseconds");
		}
		return this.#push({ kind: "sleep", id: this.#nextId("sleep"), ms });
	}

	/**
	 * Close the workflow. The current value becomes the workflow output
	 * (validated by `outputSchema`). Returns the committed workflow.
	 */
	commit(): Workflow<TId, TInput, TOutput, TCurrent> {
		if (this.#stages.length === 0) {
			throw new Error(`workflow "${this.id}" has no steps to commit`);
		}
		this.#committed = true;
		return this;
	}

	#assertCommitted(action: string): void {
		if (!this.#committed) {
			throw new Error(
				`workflow "${this.id}" must be committed with .commit() before ${action}`
			);
		}
	}

	/**
	 * Compile to Core's workflow JSON graph: the primary definition plus every
	 * nested workflow and loop body it references. Throws
	 * `WorkflowCompileError` when a stage cannot run on Core.
	 */
	toCore(): CompiledWorkflow {
		this.#assertCommitted("compiling");
		this.#compiled ??= compileWorkflow(this);
		return this.#compiled;
	}

	/** Create a local, in-process run. */
	createRun(options: CreateRunOptions = {}): WorkflowRun<TInput, TOutput> {
		this.#assertCommitted("running");
		return new WorkflowRun<TInput, TOutput>(this, options);
	}

	/** `Runnable` interop: run locally and return the output. */
	async run(input: TInput, ctx: RunnableContext): Promise<TOutput> {
		const result = await this.createRun({ runtime: ctx }).start({
			inputData: input,
			signal: ctx.signal,
		});
		if (result.status === "success") {
			return result.result;
		}
		if (result.status === "suspended") {
			throw new Error(
				`workflow "${this.id}" suspended at ${result.suspended
					.map((entry) => entry.path)
					.join(", ")}; use createRun() to resume it`
			);
		}
		throw result.error;
	}
}

function assertUniqueIds(ids: readonly string[], where: string): void {
	const seen = new Set<string>();
	for (const id of ids) {
		if (seen.has(id)) {
			throw new Error(`${where}: step id "${id}" appears twice`);
		}
		seen.add(id);
	}
}

/**
 * Create a workflow.
 *
 * @example
 * ```ts
 * const wf = createWorkflow({
 *   id: "triage",
 *   inputSchema: z.object({ text: z.string() }),
 *   outputSchema: z.string(),
 * })
 *   .then(classify)
 *   .branch([
 *     [when.equals("bug"), fileBug],
 *     [when.equals("question"), answer],
 *   ])
 *   .map(({ inputData }) => inputData.fileBug ?? inputData.answer ?? "")
 *   .commit();
 *
 * const result = await wf.createRun().start({ inputData: { text } });
 * ```
 */
export function createWorkflow<
	TId extends string,
	TInputSchema extends StandardSchemaV1 | undefined = undefined,
	TOutputSchema extends StandardSchemaV1 | undefined = undefined,
>(
	options: Omit<
		CreateWorkflowOptions<
			TId,
			InferSchema<TInputSchema>,
			InferSchema<TOutputSchema>
		>,
		"inputSchema" | "outputSchema"
	> & { inputSchema?: TInputSchema; outputSchema?: TOutputSchema }
): Workflow<TId, InferSchema<TInputSchema>, InferSchema<TOutputSchema>> {
	return new Workflow(
		options as CreateWorkflowOptions<
			TId,
			InferSchema<TInputSchema>,
			InferSchema<TOutputSchema>
		>
	);
}
