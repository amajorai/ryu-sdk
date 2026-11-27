/**
 * The local, in-process workflow executor.
 *
 * A run walks the workflow's stages in order. Every finished step is recorded
 * by its *path* (its position in the program: `fetch`, `parallel_1.a`,
 * `dowhile_2[3].refine`, `child/inner`, …). A suspended step is recorded too,
 * and the run ends with status `suspended`. `resume()` replays the program from
 * the top: recorded steps return their stored output without running again,
 * and only the resumed step (plus everything after it) executes. That makes a
 * run resumable from a JSON snapshot in another process, the same replay model
 * Core uses for its durable runs.
 *
 * Step functions should therefore be deterministic in their *control flow*:
 * conditions and `.map` functions re-run on replay, step bodies do not.
 */

import type { RunnableContext } from "../runnable/runnable-types.ts";
import { type ConditionContext, evaluateCondition } from "./conditions.ts";
import { validateWithSchema } from "./schema.ts";
import type { Step, StepRetryPolicy } from "./step.ts";
import type {
	AnyStep,
	AnyStepLike,
	CreateRunOptions,
	Stage,
	WorkflowLike,
} from "./workflow.ts";

/** Lifecycle of one recorded step. */
export type StepStatus = "success" | "suspended" | "failed";

/** What the executor records for one step path. */
export interface StepRecord {
	error?: string;
	output?: unknown;
	payload?: unknown;
	status: StepStatus;
	stepId: string;
}

/** A step a run is suspended on. */
export interface SuspendedStep {
	path: string;
	payload: unknown;
	stepId: string;
}

/** Overall run status. */
export type RunStatus =
	| "pending"
	| "running"
	| "success"
	| "suspended"
	| "failed";

/** One event on a run's `events` stream. */
export type WorkflowEvent =
	| {
			input: unknown;
			runId: string;
			type: "workflow-start";
			workflowId: string;
	  }
	| {
			input: unknown;
			path: string;
			runId: string;
			stepId: string;
			type: "step-start";
	  }
	| {
			output: unknown;
			path: string;
			runId: string;
			stepId: string;
			type: "step-result";
	  }
	| {
			path: string;
			payload: unknown;
			runId: string;
			stepId: string;
			type: "step-suspended";
	  }
	| {
			error: string;
			path: string;
			runId: string;
			stepId: string;
			type: "step-error";
	  }
	| {
			data: unknown;
			path: string;
			runId: string;
			stepId: string;
			type: "step-output";
	  }
	| { runId: string; state: Record<string, unknown>; type: "state" }
	| {
			error?: string;
			output?: unknown;
			runId: string;
			status: "success" | "suspended" | "failed";
			suspended?: SuspendedStep[];
			type: "workflow-finish";
	  };

/** The full run state, emitted on the `values` stream after every change. */
export interface WorkflowValues {
	input: unknown;
	output?: unknown;
	state: Record<string, unknown>;
	status: RunStatus;
	steps: Record<string, StepRecord>;
}

/** Stream modes, after LangGraph's `streamMode`. */
export type StreamMode = "events" | "updates" | "values";

/** One chunk of a run stream, tagged with the mode that produced it. */
export type StreamChunk =
	| { data: WorkflowEvent; mode: "events" }
	| { data: Record<string, unknown>; mode: "updates" }
	| { data: WorkflowValues; mode: "values" };

/** The outcome of `start()` / `resume()`. */
export type WorkflowResult<TOutput> =
	| {
			result: TOutput;
			state: Record<string, unknown>;
			status: "success";
			steps: Record<string, StepRecord>;
	  }
	| {
			state: Record<string, unknown>;
			status: "suspended";
			steps: Record<string, StepRecord>;
			suspended: SuspendedStep[];
	  }
	| {
			error: Error;
			state: Record<string, unknown>;
			status: "failed";
			steps: Record<string, StepRecord>;
	  };

/** A JSON-serializable run checkpoint; restore with `createRun({ snapshot })`. */
export interface WorkflowSnapshot {
	input: unknown;
	output?: unknown;
	runId: string;
	state: Record<string, unknown>;
	status: RunStatus;
	steps: Record<string, StepRecord>;
	version: 1;
	workflowId: string;
}

/** A run stream: iterate the chunks, await `result` for the outcome. */
export interface WorkflowStream<TOutput> extends AsyncIterable<StreamChunk> {
	readonly result: Promise<WorkflowResult<TOutput>>;
}

/** Thrown when a run (or part of one) suspends; carries every suspension. */
export class WorkflowSuspended extends Error {
	readonly entries: SuspendedStep[];

	constructor(entries: SuspendedStep[]) {
		super(
			`workflow suspended at ${entries.map((entry) => entry.path).join(", ")}`
		);
		this.name = "WorkflowSuspended";
		this.entries = entries;
	}
}

/** Raised when a run is cancelled. */
export class WorkflowCancelledError extends Error {
	constructor() {
		super("workflow run was cancelled");
		this.name = "WorkflowCancelledError";
	}
}

class ValidationFailure extends Error {
	override readonly cause: unknown;

	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause));
		this.name = "ValidationFailure";
		this.cause = cause;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown): Error {
	if (error instanceof ValidationFailure && error.cause instanceof Error) {
		return error.cause;
	}
	return error instanceof Error ? error : new Error(String(error));
}

function isStep(value: AnyStepLike): value is AnyStep {
	return value.kind === "step";
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	if (ms <= 0) {
		return Promise.resolve();
	}
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new WorkflowCancelledError());
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new WorkflowCancelledError());
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Run one step attempt with an optional wall-clock limit. The attempt gets its
 * own signal, linked to the run's: a timeout aborts it so an abandoned attempt
 * stops instead of racing the retry that replaces it.
 */
async function withTimeout<T>(
	work: (signal: AbortSignal) => Promise<T>,
	ms: number | undefined,
	stepId: string,
	runSignal: AbortSignal
): Promise<T> {
	if (ms === undefined || ms <= 0) {
		return await work(runSignal);
	}
	const attempt = new AbortController();
	const onRunAbort = () => attempt.abort(runSignal.reason);
	runSignal.addEventListener("abort", onRunAbort, { once: true });
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			const error = new Error(`step "${stepId}" timed out after ${ms} ms`);
			attempt.abort(error);
			reject(error);
		}, ms);
	});
	try {
		return await Promise.race([work(attempt.signal), timeout]);
	} finally {
		clearTimeout(timer);
		runSignal.removeEventListener("abort", onRunAbort);
	}
}

/** Backoff before retry `attempt` (1-based), mirroring Core's policy. */
export function retryBackoffMs(
	policy: StepRetryPolicy,
	attempt: number
): number {
	const initial = policy.initialIntervalMs ?? 100;
	const coefficient = policy.backoffCoefficient ?? 2;
	const max = policy.maxIntervalMs ?? 60_000;
	return Math.min(initial * coefficient ** (attempt - 1), max);
}

function isRetryable(policy: StepRetryPolicy, error: unknown): boolean {
	if (
		error instanceof WorkflowSuspended ||
		error instanceof WorkflowCancelledError ||
		error instanceof ValidationFailure
	) {
		return false;
	}
	const message = errorMessage(error).toLowerCase();
	return !(policy.nonRetryableErrors ?? []).some((needle) =>
		message.includes(needle.toLowerCase())
	);
}

/**
 * Run tasks with bounded concurrency and wait for all of them. A failure wins
 * over suspensions; otherwise every suspension is merged into one.
 */
async function settleAll<T>(
	tasks: (() => Promise<T>)[],
	concurrency: number
): Promise<T[]> {
	const results: T[] = new Array(tasks.length);
	const failures: unknown[] = [];
	const suspended: SuspendedStep[] = [];
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < tasks.length) {
			const index = next;
			next += 1;
			const task = tasks[index];
			if (!task) {
				continue;
			}
			try {
				results[index] = await task();
			} catch (error) {
				if (error instanceof WorkflowSuspended) {
					suspended.push(...error.entries);
				} else {
					failures.push(error);
				}
			}
		}
	};
	const width = Math.max(1, Math.min(concurrency, tasks.length));
	await Promise.all(Array.from({ length: width }, worker));
	if (failures.length > 0) {
		throw failures[0];
	}
	if (suspended.length > 0) {
		throw new WorkflowSuspended(suspended);
	}
	return results;
}

/** Async queue backing `stream()`. */
class ChunkQueue implements AsyncIterable<StreamChunk> {
	readonly #items: StreamChunk[] = [];
	readonly #waiters: ((value: IteratorResult<StreamChunk>) => void)[] = [];
	#closed = false;

	push(chunk: StreamChunk): void {
		if (this.#closed) {
			return;
		}
		const waiter = this.#waiters.shift();
		if (waiter) {
			waiter({ value: chunk, done: false });
		} else {
			this.#items.push(chunk);
		}
	}

	close(): void {
		this.#closed = true;
		for (const waiter of this.#waiters.splice(0)) {
			waiter({ value: undefined, done: true });
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
		return {
			next: () => {
				const item = this.#items.shift();
				if (item) {
					return Promise.resolve({ value: item, done: false });
				}
				if (this.#closed) {
					return Promise.resolve({ value: undefined, done: true });
				}
				return new Promise((resolve) => this.#waiters.push(resolve));
			},
		};
	}
}

/** Turn run events into stream chunks for the requested modes. */
export function chunksForEvent(
	event: WorkflowEvent,
	modes: ReadonlySet<StreamMode>,
	values: () => WorkflowValues
): StreamChunk[] {
	const chunks: StreamChunk[] = [];
	if (modes.has("events")) {
		chunks.push({ mode: "events", data: event });
	}
	if (modes.has("updates") && event.type === "step-result") {
		chunks.push({ mode: "updates", data: { [event.stepId]: event.output } });
	}
	const changesValues =
		event.type === "step-result" ||
		event.type === "step-suspended" ||
		event.type === "step-error" ||
		event.type === "state" ||
		event.type === "workflow-finish";
	if (modes.has("values") && changesValues) {
		chunks.push({ mode: "values", data: values() });
	}
	return chunks;
}

/** Normalize a `streamMode` option. */
export function streamModes(
	mode: StreamMode | readonly StreamMode[] | undefined
): ReadonlySet<StreamMode> {
	if (mode === undefined) {
		return new Set<StreamMode>(["events"]);
	}
	return new Set<StreamMode>(typeof mode === "string" ? [mode] : mode);
}

/** Options for `start()` and `stream()`. */
export interface StartOptions<TInput> {
	/** Initial run state. */
	initialState?: Record<string, unknown>;
	inputData: TInput;
	signal?: AbortSignal;
}

/** Options for `resume()` and `resumeStream()`. */
export interface ResumeOptions {
	/** The value the resumed step receives as `resumeData`. */
	resumeData?: unknown;
	signal?: AbortSignal;
	/**
	 * Which suspended step to resume: its path, its step id, or the step. May
	 * be omitted when exactly one step is suspended.
	 */
	step?: string | { id: string };
}

interface Scope {
	readonly counts: Map<string, number>;
}

/** A local run of a committed workflow. */
export class WorkflowRun<TInput, TOutput> {
	readonly runId: string;
	readonly #workflow: WorkflowLike<string, TInput, TOutput>;
	readonly #runtime: RunnableContext | undefined;
	readonly #listeners = new Set<(event: WorkflowEvent) => void>();
	#status: RunStatus = "pending";
	#input: unknown;
	#output: unknown;
	#state: Record<string, unknown> = {};
	readonly #steps: Record<string, StepRecord> = {};
	#latest = new Map<string, unknown>();
	#controller = new AbortController();
	#resume: { data: unknown; path: string } | undefined;
	#busy = false;

	constructor(
		workflow: WorkflowLike<string, TInput, TOutput>,
		options: CreateRunOptions
	) {
		this.#workflow = workflow;
		this.#runtime = options.runtime;
		const snapshot = options.snapshot;
		if (snapshot) {
			if (snapshot.workflowId !== workflow.id) {
				throw new Error(
					`snapshot belongs to workflow "${snapshot.workflowId}", not "${workflow.id}"`
				);
			}
			this.runId = snapshot.runId;
			this.#status = snapshot.status;
			this.#input = snapshot.input;
			this.#output = snapshot.output;
			this.#state = { ...snapshot.state };
			this.#steps = { ...snapshot.steps };
		} else {
			this.runId = options.runId ?? globalThis.crypto.randomUUID();
		}
	}

	/** Current status. */
	get status(): RunStatus {
		return this.#status;
	}

	/** Steps the run is currently suspended on. */
	get suspended(): SuspendedStep[] {
		return Object.entries(this.#steps)
			.filter(([, record]) => record.status === "suspended")
			.map(([path, record]) => ({
				path,
				stepId: record.stepId,
				payload: record.payload,
			}));
	}

	/** Subscribe to run events; returns an unsubscribe function. */
	watch(listener: (event: WorkflowEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** A JSON-serializable checkpoint of the run. */
	snapshot(): WorkflowSnapshot {
		return {
			version: 1,
			runId: this.runId,
			workflowId: this.#workflow.id,
			status: this.#status,
			input: this.#input,
			output: this.#output,
			state: { ...this.#state },
			steps: { ...this.#steps },
		};
	}

	/** Abort the run; running steps see `signal.aborted`. */
	cancel(): void {
		this.#controller.abort();
	}

	/** Run from the start and resolve with the outcome. */
	start(options: StartOptions<TInput>): Promise<WorkflowResult<TOutput>> {
		if (this.#status !== "pending") {
			throw new Error(
				`run ${this.runId} already started (status ${this.#status}); use resume()`
			);
		}
		this.#input = options.inputData;
		this.#state = { ...(options.initialState ?? {}) };
		return this.#execute(options.signal, true);
	}

	/** Like `start`, but streams chunks for `streamMode` (default `events`). */
	stream(
		options: StartOptions<TInput> & {
			streamMode?: StreamMode | readonly StreamMode[];
		}
	): WorkflowStream<TOutput> {
		return this.#streamed(options.streamMode, () => this.start(options));
	}

	/** Resume a suspended run. */
	resume(options: ResumeOptions = {}): Promise<WorkflowResult<TOutput>> {
		if (this.#status !== "suspended") {
			throw new Error(
				`run ${this.runId} is not suspended (status ${this.#status})`
			);
		}
		const target = this.#resolveResumeTarget(options.step);
		this.#resume = { path: target.path, data: options.resumeData };
		return this.#execute(options.signal, false);
	}

	/** Like `resume`, but streams chunks for `streamMode` (default `events`). */
	resumeStream(
		options: ResumeOptions & {
			streamMode?: StreamMode | readonly StreamMode[];
		} = {}
	): WorkflowStream<TOutput> {
		return this.#streamed(options.streamMode, () => this.resume(options));
	}

	#streamed(
		mode: StreamMode | readonly StreamMode[] | undefined,
		begin: () => Promise<WorkflowResult<TOutput>>
	): WorkflowStream<TOutput> {
		const modes = streamModes(mode);
		const queue = new ChunkQueue();
		const unsubscribe = this.watch((event) => {
			for (const chunk of chunksForEvent(event, modes, () => this.#values())) {
				queue.push(chunk);
			}
		});
		let started: Promise<WorkflowResult<TOutput>>;
		try {
			started = begin();
		} catch (error) {
			unsubscribe();
			throw error;
		}
		const result = started.finally(() => {
			unsubscribe();
			queue.close();
		});
		return {
			result,
			[Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
		};
	}

	#resolveResumeTarget(step: ResumeOptions["step"]): SuspendedStep {
		const suspended = this.suspended;
		if (step === undefined) {
			const [only] = suspended;
			if (suspended.length !== 1 || !only) {
				throw new Error(
					`run ${this.runId} has ${suspended.length} suspended steps (${suspended
						.map((entry) => entry.path)
						.join(", ")}); pass \`step\` to choose one`
				);
			}
			return only;
		}
		const key = typeof step === "string" ? step : step.id;
		const byPath = suspended.find((entry) => entry.path === key);
		if (byPath) {
			return byPath;
		}
		const byId = suspended.filter((entry) => entry.stepId === key);
		const [first] = byId;
		if (byId.length === 1 && first) {
			return first;
		}
		if (byId.length > 1) {
			throw new Error(
				`step "${key}" is suspended at several paths (${byId
					.map((entry) => entry.path)
					.join(", ")}); pass the path`
			);
		}
		throw new Error(`step "${key}" is not suspended in run ${this.runId}`);
	}

	#values(): WorkflowValues {
		return {
			status: this.#status,
			input: this.#input,
			output: this.#output,
			state: { ...this.#state },
			steps: { ...this.#steps },
		};
	}

	#emit(event: WorkflowEvent): void {
		for (const listener of this.#listeners) {
			listener(event);
		}
	}

	#result(): Pick<WorkflowResult<TOutput>, "state" | "steps"> {
		return { state: { ...this.#state }, steps: { ...this.#steps } };
	}

	async #execute(
		signal: AbortSignal | undefined,
		fresh: boolean
	): Promise<WorkflowResult<TOutput>> {
		if (this.#busy) {
			throw new Error(`run ${this.runId} is already executing`);
		}
		this.#busy = true;
		if (this.#controller.signal.aborted) {
			this.#controller = new AbortController();
		}
		const onAbort = () => this.#controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		this.#status = "running";
		this.#latest = new Map();
		if (fresh) {
			this.#emit({
				type: "workflow-start",
				runId: this.runId,
				workflowId: this.#workflow.id,
				input: this.#input,
			});
		}
		try {
			const input = await this.#validate(
				this.#workflow.inputSchema,
				this.#input,
				`workflow "${this.#workflow.id}" input`
			);
			const raw = await this.#runStages(this.#workflow.stages, input, "");
			const output = (await this.#validate(
				this.#workflow.outputSchema,
				raw,
				`workflow "${this.#workflow.id}" output`
			)) as TOutput;
			this.#status = "success";
			this.#output = output;
			this.#emit({
				type: "workflow-finish",
				runId: this.runId,
				status: "success",
				output,
			});
			return { status: "success", result: output, ...this.#result() };
		} catch (error) {
			if (error instanceof WorkflowSuspended) {
				this.#status = "suspended";
				this.#emit({
					type: "workflow-finish",
					runId: this.runId,
					status: "suspended",
					suspended: error.entries,
				});
				return {
					status: "suspended",
					suspended: error.entries,
					...this.#result(),
				};
			}
			const failure = toError(error);
			this.#status = "failed";
			this.#emit({
				type: "workflow-finish",
				runId: this.runId,
				status: "failed",
				error: failure.message,
			});
			return { status: "failed", error: failure, ...this.#result() };
		} finally {
			this.#resume = undefined;
			this.#busy = false;
			signal?.removeEventListener("abort", onAbort);
		}
	}

	async #validate<T>(
		schema: Parameters<typeof validateWithSchema<T>>[0],
		value: unknown,
		where: string
	): Promise<T> {
		try {
			return await validateWithSchema(schema, value, where);
		} catch (error) {
			throw new ValidationFailure(error);
		}
	}

	#conditionContext<T>(inputData: T): ConditionContext<T> {
		const run = this;
		return {
			inputData,
			get state() {
				return run.#state;
			},
			getInitData: <TInit>() => this.#input as TInit,
			getStepResult: <TResult>(stepId: string) =>
				this.#latest.get(stepId) as TResult | undefined,
		};
	}

	#pathFor(scope: Scope, prefix: string, id: string): string {
		const count = (scope.counts.get(id) ?? 0) + 1;
		scope.counts.set(id, count);
		return count === 1 ? `${prefix}${id}` : `${prefix}${id}#${count}`;
	}

	#checkAborted(): void {
		if (this.#controller.signal.aborted) {
			throw new WorkflowCancelledError();
		}
	}

	/** Replay a recorded path, or `undefined` when it must run. */
	#replay(path: string): { output: unknown } | undefined {
		const record = this.#steps[path];
		if (!record) {
			return;
		}
		if (record.status === "success") {
			this.#latest.set(record.stepId, record.output);
			return { output: record.output };
		}
		if (record.status === "suspended" && this.#resume?.path !== path) {
			throw new WorkflowSuspended([
				{ path, stepId: record.stepId, payload: record.payload },
			]);
		}
		return;
	}

	#record(path: string, stepId: string, output: unknown): void {
		this.#steps[path] = { status: "success", stepId, output };
		this.#latest.set(stepId, output);
		this.#emit({
			type: "step-result",
			runId: this.runId,
			stepId,
			path,
			output,
		});
	}

	async #runStages(
		stages: readonly Stage[],
		input: unknown,
		prefix: string
	): Promise<unknown> {
		const scope: Scope = { counts: new Map() };
		let value = input;
		for (const stage of stages) {
			this.#checkAborted();
			value = await this.#runStage(stage, value, prefix, scope);
		}
		return value;
	}

	async #runStage(
		stage: Stage,
		input: unknown,
		prefix: string,
		scope: Scope
	): Promise<unknown> {
		switch (stage.kind) {
			case "step":
				return await this.#runStepLike(
					stage.step,
					input,
					this.#pathFor(scope, prefix, stage.step.id)
				);
			case "parallel": {
				const base = `${this.#pathFor(scope, prefix, stage.id)}.`;
				const outputs = await settleAll(
					stage.steps.map(
						(step) => () => this.#runStepLike(step, input, `${base}${step.id}`)
					),
					Number.POSITIVE_INFINITY
				);
				return Object.fromEntries(
					stage.steps.map((step, index) => [step.id, outputs[index]])
				);
			}
			case "branch": {
				const base = `${this.#pathFor(scope, prefix, stage.id)}.`;
				const chosen: AnyStepLike[] = [];
				for (const branch of stage.branches) {
					if (
						await evaluateCondition(
							branch.condition,
							this.#conditionContext(input)
						)
					) {
						chosen.push(branch.step);
					}
				}
				const outputs = await settleAll(
					chosen.map(
						(step) => () => this.#runStepLike(step, input, `${base}${step.id}`)
					),
					Number.POSITIVE_INFINITY
				);
				return Object.fromEntries(
					chosen.map((step, index) => [step.id, outputs[index]])
				);
			}
			case "foreach": {
				if (!Array.isArray(input)) {
					throw new Error(
						`.foreach() at "${stage.id}" needs an array input, got ${typeof input}`
					);
				}
				const base = this.#pathFor(scope, prefix, stage.id);
				const items: unknown[] = input;
				return await settleAll(
					items.map(
						(item, index) => () =>
							this.#runStepLike(
								stage.step,
								item,
								`${base}[${index}].${stage.step.id}`
							)
					),
					stage.concurrency
				);
			}
			case "loop": {
				const base = this.#pathFor(scope, prefix, stage.id);
				let value = input;
				for (let iteration = 1; ; iteration += 1) {
					this.#checkAborted();
					value = await this.#runStepLike(
						stage.step,
						value,
						`${base}[${iteration}].${stage.step.id}`
					);
					if (iteration >= stage.maxIterations) {
						return value;
					}
					const holds = await evaluateCondition(
						stage.condition,
						this.#conditionContext(value)
					);
					const again = stage.mode === "dowhile" ? holds : !holds;
					if (!again) {
						return value;
					}
				}
			}
			case "map": {
				const path = this.#pathFor(scope, prefix, stage.id);
				const replayed = this.#replay(path);
				if (replayed) {
					return replayed.output;
				}
				this.#emit({
					type: "step-start",
					runId: this.runId,
					stepId: stage.id,
					path,
					input,
				});
				const output = await stage.fn(this.#conditionContext(input));
				this.#record(path, stage.id, output);
				return output;
			}
			case "sleep": {
				const path = this.#pathFor(scope, prefix, stage.id);
				if (this.#replay(path)) {
					return input;
				}
				this.#emit({
					type: "step-start",
					runId: this.runId,
					stepId: stage.id,
					path,
					input,
				});
				await abortableSleep(stage.ms, this.#controller.signal);
				this.#record(path, stage.id, input);
				return input;
			}
			default:
				throw new Error("unknown workflow stage");
		}
	}

	async #runStepLike(
		stepLike: AnyStepLike,
		input: unknown,
		path: string
	): Promise<unknown> {
		const replayed = this.#replay(path);
		if (replayed) {
			return replayed.output;
		}
		this.#checkAborted();
		this.#emit({
			type: "step-start",
			runId: this.runId,
			stepId: stepLike.id,
			path,
			input,
		});
		try {
			const output = isStep(stepLike)
				? await this.#runStep(stepLike, input, path)
				: await this.#runNested(stepLike, input, path);
			this.#record(path, stepLike.id, output);
			return output;
		} catch (error) {
			if (error instanceof WorkflowSuspended) {
				throw error;
			}
			const message = errorMessage(error);
			this.#steps[path] = {
				status: "failed",
				stepId: stepLike.id,
				error: message,
			};
			this.#emit({
				type: "step-error",
				runId: this.runId,
				stepId: stepLike.id,
				path,
				error: message,
			});
			throw error;
		}
	}

	async #runNested(
		workflow: WorkflowLike,
		input: unknown,
		path: string
	): Promise<unknown> {
		const validated = await this.#validate(
			workflow.inputSchema,
			input,
			`workflow "${workflow.id}" input`
		);
		const output = await this.#runStages(
			workflow.stages,
			validated,
			`${path}/`
		);
		return await this.#validate(
			workflow.outputSchema,
			output,
			`workflow "${workflow.id}" output`
		);
	}

	async #runStep(
		step: AnyStep,
		input: unknown,
		path: string
	): Promise<unknown> {
		const inputData = await this.#validate(
			step.inputSchema,
			input,
			`step "${step.id}" input`
		);
		const resuming = this.#resume?.path === path;
		const resumeData = resuming
			? await this.#validate(
					step.resumeSchema,
					this.#resume?.data,
					`step "${step.id}" resume data`
				)
			: undefined;
		const policy = step.retry ?? {};
		const maxAttempts = Math.max(1, policy.maxAttempts ?? 1);
		for (let attempt = 1; ; attempt += 1) {
			try {
				const output = await withTimeout(
					(signal) => this.#invoke(step, inputData, resumeData, path, signal),
					step.timeoutMs,
					step.id,
					this.#controller.signal
				);
				return await this.#validate(
					step.outputSchema,
					output,
					`step "${step.id}" output`
				);
			} catch (error) {
				if (attempt >= maxAttempts || !isRetryable(policy, error)) {
					throw error;
				}
				await abortableSleep(
					retryBackoffMs(policy, attempt),
					this.#controller.signal
				);
			}
		}
	}

	#invoke(
		step: Step<string, unknown, unknown, unknown, unknown>,
		inputData: unknown,
		resumeData: unknown,
		path: string,
		signal: AbortSignal
	): Promise<unknown> {
		const run = this;
		return step.execute({
			inputData,
			resumeData,
			runId: this.runId,
			workflowId: this.#workflow.id,
			runtime: this.#runtime,
			signal,
			get state() {
				return run.#state;
			},
			getInitData: <TInit>() => this.#input as TInit,
			getStepResult: <TResult>(stepId: string) =>
				this.#latest.get(stepId) as TResult | undefined,
			setState: (patch) => {
				run.#state = { ...run.#state, ...patch };
				run.#emit({
					type: "state",
					runId: run.runId,
					state: { ...run.#state },
				});
			},
			emit: (data) => {
				run.#emit({
					type: "step-output",
					runId: run.runId,
					stepId: step.id,
					path,
					data,
				});
			},
			suspend: async (payload) => {
				if (signal.aborted) {
					throw new WorkflowCancelledError();
				}
				const validated = await run.#validate(
					step.suspendSchema,
					payload,
					`step "${step.id}" suspend payload`
				);
				run.#steps[path] = {
					status: "suspended",
					stepId: step.id,
					payload: validated,
				};
				run.#emit({
					type: "step-suspended",
					runId: run.runId,
					stepId: step.id,
					path,
					payload: validated,
				});
				throw new WorkflowSuspended([
					{ path, stepId: step.id, payload: validated },
				]);
			},
		});
	}
}
