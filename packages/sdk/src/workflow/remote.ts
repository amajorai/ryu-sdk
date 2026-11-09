/**
 * Run DSL workflows on a Core node.
 *
 * `createCoreWorkflowClient` deploys a compiled workflow (children first, then
 * the primary definition) through `POST /workflows`, starts runs with
 * `POST /workflows/:id/run`, and streams them by polling
 * `GET /workflows/runs/:runId` while the run request is in flight, turning
 * per-node state changes into the same events, updates, and values the local
 * executor emits. Human gates resume through
 * `POST /workflows/runs/:runId/resume`.
 *
 * Core runs are durable: a run parked on a provider limit (`waiting`) keeps
 * being polled until it completes, fails, or suspends.
 */

import { encodePathId } from "@ryuhq/client";
import {
	type CoreUrlOptions,
	pickCoreUrl,
	resolveCoreToken,
	resolveCoreUrl,
} from "../core-env.ts";
import { assertAllowedEgressUrl } from "../model/gateway.ts";
import { coreText } from "./conditions.ts";
import {
	CORE_INPUT_KEY,
	CORE_OUTPUT_KEY,
	type CompiledWorkflow,
	type CoreWorkflow,
} from "./core-types.ts";
import {
	chunksForEvent,
	type RunStatus,
	type StepRecord,
	type StreamChunk,
	type StreamMode,
	type SuspendedStep,
	streamModes,
	type WorkflowEvent,
	type WorkflowResult,
	type WorkflowStream,
	type WorkflowValues,
} from "./executor.ts";
import { type StandardSchemaV1, validateWithSchema } from "./schema.ts";

/** Per-node state in a Core run record. */
export interface CoreNodeRunState {
	attempts?: number;
	error?: string | null;
	output?: string | null;
	status: "pending" | "running" | "completed" | "failed" | "skipped";
}

/** A Core workflow run record (`GET /workflows/runs/:runId`). */
export interface CoreRunRecord {
	awaiting_node?: string | null;
	error?: string | null;
	input?: Record<string, string>;
	nodes?: Record<string, CoreNodeRunState>;
	output?: Record<string, string>;
	run_id: string;
	status: "running" | "completed" | "failed" | "awaiting_input" | "waiting";
	workflow_id: string;
}

/** The HTTP call the client makes (global `fetch` satisfies it). */
export type CoreFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Connection options for {@link createCoreWorkflowClient}. */
export interface CoreWorkflowClientOptions extends CoreUrlOptions {
	/** Core node URL. Defaults to `RYU_CORE_URL`, then `http://127.0.0.1:7980`. */
	baseUrl?: string;
	/** Fetch implementation (defaults to global `fetch`). */
	fetchImpl?: CoreFetch;
	/** @deprecated Use `baseUrl`. Still read when `baseUrl` is unset. */
	nodeUrl?: string;
	/** How often a streaming run polls Core, in milliseconds. Default 250. */
	pollIntervalMs?: number;
	/** Node bearer token. Defaults to `RYU_CORE_TOKEN`, then `RYU_TOKEN`. */
	token?: string;
	/** Verified end-user JWT for an org-bound Core. */
	userJwt?: string;
}

/** What a deployable workflow exposes. */
export interface DeployableWorkflow<TInput = unknown, TOutput = unknown> {
	readonly id: string;
	readonly inputSchema?: StandardSchemaV1<unknown, TInput>;
	readonly outputSchema?: StandardSchemaV1<unknown, TOutput>;
	toCore(): CompiledWorkflow;
}

/** The ids written by {@link CoreWorkflowClient.deploy}. */
export interface DeployResult {
	children: string[];
	workflowId: string;
}

/** A Core-backed run of a DSL workflow. */
export interface RemoteWorkflowRun<TInput, TOutput> {
	/** Fetch the raw Core run record. */
	get(): Promise<CoreRunRecord>;
	/** Resume a run suspended at a human gate. */
	resume(options?: {
		resumeData?: unknown;
		signal?: AbortSignal;
	}): Promise<WorkflowResult<TOutput>>;
	/** Resume and stream. */
	resumeStream(options?: {
		resumeData?: unknown;
		signal?: AbortSignal;
		streamMode?: StreamMode | readonly StreamMode[];
	}): WorkflowStream<TOutput>;
	readonly runId: string;
	/** Start the run and resolve with its outcome. */
	start(options: {
		inputData: TInput;
		signal?: AbortSignal;
	}): Promise<WorkflowResult<TOutput>>;
	/** Start the run and stream chunks for `streamMode` (default `events`). */
	stream(options: {
		inputData: TInput;
		signal?: AbortSignal;
		streamMode?: StreamMode | readonly StreamMode[];
	}): WorkflowStream<TOutput>;
}

/** A client for running DSL workflows on Core. */
export interface CoreWorkflowClient {
	/** Create a run handle for a deployed workflow. */
	createRun<TInput, TOutput>(
		workflow: DeployableWorkflow<TInput, TOutput>,
		options?: { runId?: string }
	): RemoteWorkflowRun<TInput, TOutput>;
	/** Persist the workflow and every nested definition on Core. */
	deploy(
		workflow: DeployableWorkflow | CompiledWorkflow
	): Promise<DeployResult>;
	/** Fetch a Core run record. */
	getRun(runId: string): Promise<CoreRunRecord>;
}

/** Raised for a non-2xx Core response; `status` is the HTTP status. */
export class CoreWorkflowError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "CoreWorkflowError";
		this.status = status;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRun(body: unknown, path: string): CoreRunRecord {
	const run = isRecord(body) ? body.run : undefined;
	if (
		!isRecord(run) ||
		typeof run.run_id !== "string" ||
		typeof run.status !== "string"
	) {
		throw new Error(`${path}: response has no run record`);
	}
	return run as unknown as CoreRunRecord;
}

/**
 * Decode a Core text value. JSON is parsed; when a schema is given, the parsed
 * value is tried first and the raw text second, so a string-typed output that
 * happens to look like JSON (`"42"`) still validates.
 */
export function decodeCoreValue(
	text: string | null | undefined
): Promise<unknown>;
export function decodeCoreValue<T>(
	text: string | null | undefined,
	schema: StandardSchemaV1<unknown, T> | undefined
): Promise<T>;
export async function decodeCoreValue<T>(
	text: string | null | undefined,
	schema?: StandardSchemaV1<unknown, T>
): Promise<T> {
	const raw = text ?? "";
	const candidates: unknown[] = [];
	try {
		candidates.push(JSON.parse(raw));
	} catch {
		// Not JSON: the raw text is the value.
	}
	candidates.push(raw);
	if (!schema) {
		return candidates[0] as T;
	}
	let lastError: unknown;
	for (const candidate of candidates) {
		try {
			return await validateWithSchema(schema, candidate, "workflow output");
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError;
}

function decodeLoose(text: string | null | undefined): unknown {
	const raw = text ?? "";
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		// Detach on the timer path too: a long poll on one signal must not
		// accumulate an abort listener per tick.
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function newRunId(): string {
	return `run_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

/**
 * Core stores runs (and their `<runId>-sub-<node>` children) under the run id,
 * so it must be path-safe; the margin leaves room for those suffixes.
 */
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

const TERMINAL = new Set(["completed", "failed", "awaiting_input"]);

/** Tracks a Core run's node states and turns changes into events. */
class RunTracker {
	readonly #runId: string;
	readonly #stepNodes: Record<string, string>;
	readonly #seen = new Map<string, string>();
	readonly #emit: (event: WorkflowEvent) => void;
	steps: Record<string, StepRecord> = {};
	status: RunStatus = "running";
	input: unknown;
	output: unknown;

	constructor(
		runId: string,
		stepNodes: Record<string, string>,
		emit: (event: WorkflowEvent) => void
	) {
		this.#runId = runId;
		this.#stepNodes = stepNodes;
		this.#emit = emit;
	}

	values(): WorkflowValues {
		return {
			status: this.status,
			input: this.input,
			output: this.output,
			state: {},
			steps: { ...this.steps },
		};
	}

	observe(run: CoreRunRecord): void {
		for (const [nodeId, state] of Object.entries(run.nodes ?? {})) {
			const stepId = this.#stepNodes[nodeId];
			if (stepId === undefined || this.#seen.get(nodeId) === state.status) {
				continue;
			}
			const previous = this.#seen.get(nodeId);
			this.#seen.set(nodeId, state.status);
			const base = { runId: this.#runId, stepId, path: nodeId };
			if (previous === undefined && state.status !== "skipped") {
				this.#emit({ ...base, type: "step-start", input: undefined });
			}
			if (state.status === "completed") {
				const output = decodeLoose(state.output);
				this.steps[nodeId] = { status: "success", stepId, output };
				this.#emit({ ...base, type: "step-result", output });
			} else if (state.status === "failed") {
				const error = state.error ?? "step failed";
				this.steps[nodeId] = { status: "failed", stepId, error };
				this.#emit({ ...base, type: "step-error", error });
			}
		}
		const gate = run.awaiting_node;
		if (
			run.status === "awaiting_input" &&
			gate &&
			this.steps[gate]?.status !== "suspended"
		) {
			const stepId = this.#stepNodes[gate] ?? gate;
			this.steps[gate] = { status: "suspended", stepId, payload: null };
			this.#emit({
				type: "step-suspended",
				runId: this.#runId,
				stepId,
				path: gate,
				payload: null,
			});
		}
	}

	suspended(): SuspendedStep[] {
		return Object.entries(this.steps)
			.filter(([, record]) => record.status === "suspended")
			.map(([path, record]) => ({
				path,
				stepId: record.stepId,
				payload: record.payload,
			}));
	}
}

/**
 * Create a client that deploys DSL workflows to a Core node and runs them
 * there. Live round-trips need a running Core; the wire contract is covered by
 * unit tests with a mocked transport.
 */
export function createCoreWorkflowClient(
	options: CoreWorkflowClientOptions = {}
): CoreWorkflowClient {
	const base = (pickCoreUrl(options) ?? resolveCoreUrl()).replace(/\/+$/, "");
	const token = options.token ?? resolveCoreToken();
	assertAllowedEgressUrl(base);
	const doFetch: CoreFetch =
		options.fetchImpl ?? ((url, init) => fetch(url, init));
	const pollIntervalMs = options.pollIntervalMs ?? 250;

	const headers = (): Record<string, string> => {
		const out: Record<string, string> = { "content-type": "application/json" };
		const bearer = token ?? options.userJwt;
		if (bearer) {
			out.authorization = `Bearer ${bearer}`;
		}
		if (options.userJwt) {
			out["x-ryu-user-jwt"] = options.userJwt;
		}
		return out;
	};

	const request = async (
		method: "GET" | "POST",
		path: string,
		body?: unknown,
		signal?: AbortSignal
	): Promise<unknown> => {
		const response = await doFetch(`${base}${path}`, {
			method,
			headers: headers(),
			body: body === undefined ? undefined : JSON.stringify(body),
			signal,
		});
		const text = await response.text();
		let parsed: unknown;
		try {
			parsed = text ? JSON.parse(text) : undefined;
		} catch {
			parsed = undefined;
		}
		if (!response.ok) {
			const detail =
				isRecord(parsed) && typeof parsed.error === "string"
					? parsed.error
					: `${response.status} ${response.statusText}`;
			throw new CoreWorkflowError(
				`${method} ${path} failed: ${detail}`,
				response.status
			);
		}
		return parsed;
	};

	const getRun = async (runId: string, signal?: AbortSignal) => {
		const path = `/workflows/runs/${encodePathId("Core workflows", runId)}`;
		return readRun(await request("GET", path, undefined, signal), path);
	};

	const deployOne = async (definition: CoreWorkflow): Promise<void> => {
		await request("POST", "/workflows", definition);
	};

	const deploy = async (
		workflow: DeployableWorkflow | CompiledWorkflow
	): Promise<DeployResult> => {
		const compiled = "toCore" in workflow ? workflow.toCore() : workflow;
		for (const child of compiled.children) {
			await deployOne(child);
		}
		await deployOne(compiled.workflow);
		return {
			workflowId: compiled.workflow.id,
			children: compiled.children.map((child) => child.id),
		};
	};

	const createRun = <TInput, TOutput>(
		workflow: DeployableWorkflow<TInput, TOutput>,
		runOptions: { runId?: string } = {}
	): RemoteWorkflowRun<TInput, TOutput> => {
		const runId = runOptions.runId ?? newRunId();
		if (!RUN_ID.test(runId)) {
			throw new Error(
				`run id "${runId}" must be 1-64 characters of [A-Za-z0-9_-]`
			);
		}
		const listeners = new Set<(event: WorkflowEvent) => void>();
		const emit = (event: WorkflowEvent) => {
			for (const listener of listeners) {
				listener(event);
			}
		};
		let tracker: RunTracker | undefined;
		const trackerFor = () => {
			tracker ??= new RunTracker(runId, workflow.toCore().stepNodes, emit);
			return tracker;
		};

		/** Drive one blocking Core call while polling the run for progress. */
		const drive = async (
			call: () => Promise<unknown>,
			callPath: string,
			signal?: AbortSignal
		): Promise<WorkflowResult<TOutput>> => {
			const track = trackerFor();
			track.status = "running";
			let settled = false;
			let final: CoreRunRecord | undefined;
			let failure: unknown;
			const pending = call().then(
				(body) => {
					final = readRun(body, callPath);
				},
				(error: unknown) => {
					failure = error;
				}
			);
			pending.finally(() => {
				settled = true;
			});
			while (!(settled || signal?.aborted)) {
				await Promise.race([pending, delay(pollIntervalMs, signal)]);
				if (settled) {
					break;
				}
				try {
					track.observe(await getRun(runId, signal));
				} catch {
					// Progress polling is best effort: Core answers 404 until the
					// run's first checkpoint, and a transient poll failure must not
					// abandon a run whose outcome the in-flight call still reports.
				}
			}
			await pending;
			if (failure !== undefined) {
				return finish({ kind: "error", error: failure });
			}
			let run = final;
			try {
				// A limit-parked (`waiting`) run is woken by Core; follow it.
				while (run && !TERMINAL.has(run.status) && !signal?.aborted) {
					track.observe(run);
					await delay(pollIntervalMs, signal);
					run = await getRun(runId, signal);
				}
			} catch (error) {
				return finish({ kind: "error", error });
			}
			if (!(run && TERMINAL.has(run.status))) {
				return finish({
					kind: "error",
					error: new Error(
						`stopped watching run ${runId} before it finished (status ${run?.status ?? "unknown"})`
					),
				});
			}
			track.observe(run);
			return finish({ kind: "run", run });
		};

		const finish = async (
			outcome:
				| { kind: "run"; run: CoreRunRecord }
				| { kind: "error"; error: unknown }
		): Promise<WorkflowResult<TOutput>> => {
			const track = trackerFor();
			const common = { state: {}, steps: { ...track.steps } };
			if (outcome.kind === "error" || outcome.run.status === "failed") {
				const error =
					outcome.kind === "error"
						? outcome.error instanceof Error
							? outcome.error
							: new Error(String(outcome.error))
						: new Error(outcome.run.error ?? "workflow run failed");
				track.status = "failed";
				emit({
					type: "workflow-finish",
					runId,
					status: "failed",
					error: error.message,
				});
				return { status: "failed", error, ...common };
			}
			if (outcome.run.status === "awaiting_input") {
				track.status = "suspended";
				const suspended = track.suspended();
				emit({
					type: "workflow-finish",
					runId,
					status: "suspended",
					suspended,
				});
				return { status: "suspended", suspended, ...common };
			}
			try {
				const result = await decodeCoreValue<TOutput>(
					outcome.run.output?.[CORE_OUTPUT_KEY],
					workflow.outputSchema
				);
				track.status = "success";
				track.output = result;
				emit({
					type: "workflow-finish",
					runId,
					status: "success",
					output: result,
				});
				return { status: "success", result, ...common };
			} catch (error) {
				return finish({ kind: "error", error });
			}
		};

		const streamed = (
			mode: StreamMode | readonly StreamMode[] | undefined,
			begin: () => Promise<WorkflowResult<TOutput>>
		): WorkflowStream<TOutput> => {
			const modes = streamModes(mode);
			const items: StreamChunk[] = [];
			const waiters: ((result: IteratorResult<StreamChunk>) => void)[] = [];
			let closed = false;
			const listener = (event: WorkflowEvent) => {
				for (const chunk of chunksForEvent(event, modes, () =>
					trackerFor().values()
				)) {
					const waiter = waiters.shift();
					if (waiter) {
						waiter({ value: chunk, done: false });
					} else {
						items.push(chunk);
					}
				}
			};
			listeners.add(listener);
			const result = begin().finally(() => {
				listeners.delete(listener);
				closed = true;
				for (const waiter of waiters.splice(0)) {
					waiter({ value: undefined, done: true });
				}
			});
			return {
				result,
				[Symbol.asyncIterator]: () => ({
					next: () => {
						const item = items.shift();
						if (item) {
							return Promise.resolve({ value: item, done: false });
						}
						if (closed) {
							return Promise.resolve({ value: undefined, done: true });
						}
						return new Promise((resolve) => waiters.push(resolve));
					},
				}),
			};
		};

		const start = async (startOptions: {
			inputData: TInput;
			signal?: AbortSignal;
		}): Promise<WorkflowResult<TOutput>> => {
			const inputData = await validateWithSchema(
				workflow.inputSchema,
				startOptions.inputData,
				`workflow "${workflow.id}" input`
			);
			trackerFor().input = inputData;
			emit({
				type: "workflow-start",
				runId,
				workflowId: workflow.id,
				input: inputData,
			});
			const path = `/workflows/${encodeURIComponent(workflow.id)}/run`;
			return await drive(
				() =>
					request(
						"POST",
						path,
						{ input: { [CORE_INPUT_KEY]: coreText(inputData) }, runId },
						startOptions.signal
					),
				path,
				startOptions.signal
			);
		};

		const resume = async (
			resumeOptions: { resumeData?: unknown; signal?: AbortSignal } = {}
		): Promise<WorkflowResult<TOutput>> => {
			const path = `/workflows/runs/${encodeURIComponent(runId)}/resume`;
			return await drive(
				() =>
					request(
						"POST",
						path,
						{ payload: coreText(resumeOptions.resumeData) },
						resumeOptions.signal
					),
				path,
				resumeOptions.signal
			);
		};

		return {
			runId,
			get: () => getRun(runId),
			start,
			stream: (streamOptions) =>
				streamed(streamOptions.streamMode, () => start(streamOptions)),
			resume,
			resumeStream: (resumeOptions = {}) =>
				streamed(resumeOptions.streamMode, () => resume(resumeOptions)),
		};
	};

	return { deploy, createRun, getRun: (runId) => getRun(runId) };
}
