/**
 * Run history and local traces for the Ryu developer server.
 *
 * Every agent, workflow, and tool invocation the server handles is recorded as
 * a {@link RunRecord}: what ran, its input, the ordered events it produced, and
 * how it ended. Workflow records also carry the run's snapshot, which is what
 * lets `resume` continue a suspended run after the in-process run object is
 * gone (another serverless invocation, a restart with a persistent store).
 *
 * The default store keeps a bounded number of runs in memory. Pass your own
 * {@link RunStore} to `createRyuServer({ runStore })` to persist them.
 */

import type { WorkflowSnapshot } from "../workflow/executor.ts";

/** What kind of thing a run executed. */
export type RunKind = "agent" | "tool" | "workflow";

/** How a run ended (or that it has not yet). */
export type RunRecordStatus =
	| "failed"
	| "paused"
	| "running"
	| "success"
	| "suspended";

/** One recorded event of a run. */
export interface TraceEvent {
	/** The event payload as streamed to the client. */
	data: unknown;
	/** Milliseconds since the run started. */
	offsetMs: number;
	/** Event name (`text`, `tool_call`, `step-result`, …). */
	type: string;
}

/** A recorded run: the server's history entry and local trace. */
export interface RunRecord {
	endedAt?: string;
	error?: string;
	/** Ordered events, capped at {@link MAX_TRACE_EVENTS}. */
	events: TraceEvent[];
	/** Events dropped after the cap was reached. */
	eventsDropped?: number;
	id: string;
	input: unknown;
	kind: RunKind;
	output?: unknown;
	/** Workflow runs only: the latest resumable checkpoint. */
	snapshot?: WorkflowSnapshot;
	startedAt: string;
	status: RunRecordStatus;
	/** The agent, workflow, or tool id. */
	target: string;
}

/** Filters for {@link RunStore.list}. */
export interface RunListFilter {
	kind?: RunKind;
	limit?: number;
	target?: string;
}

/** Persistence for run records. Methods may be sync or async. */
export interface RunStore {
	get(id: string): Promise<RunRecord | undefined> | RunRecord | undefined;
	/** Newest first. */
	list(filter?: RunListFilter): Promise<RunRecord[]> | RunRecord[];
	save(record: RunRecord): Promise<void> | void;
}

/** Most events kept per run. */
export const MAX_TRACE_EVENTS = 2000;

const DEFAULT_MAX_RUNS = 200;
const DEFAULT_LIST_LIMIT = 50;

/** Options for {@link createMemoryRunStore}. */
export interface MemoryRunStoreOptions {
	/** Oldest runs are evicted past this many (default 200). */
	maxRuns?: number;
}

/** An in-memory, bounded {@link RunStore}. */
export function createMemoryRunStore(
	options: MemoryRunStoreOptions = {}
): RunStore {
	const maxRuns = Math.max(1, options.maxRuns ?? DEFAULT_MAX_RUNS);
	const runs = new Map<string, RunRecord>();
	return {
		get: (id) => runs.get(id),
		list(filter = {}) {
			const limit = Math.max(1, filter.limit ?? DEFAULT_LIST_LIMIT);
			const matches: RunRecord[] = [];
			for (const record of [...runs.values()].reverse()) {
				if (filter.kind && record.kind !== filter.kind) {
					continue;
				}
				if (filter.target && record.target !== filter.target) {
					continue;
				}
				matches.push(record);
				if (matches.length >= limit) {
					break;
				}
			}
			return matches;
		},
		save(record) {
			// Re-inserting moves the record to the newest position.
			runs.delete(record.id);
			runs.set(record.id, record);
			while (runs.size > maxRuns) {
				const oldest = runs.keys().next().value;
				if (oldest === undefined) {
					break;
				}
				runs.delete(oldest);
			}
		},
	};
}

/** A run being recorded: append events, then finish it. */
export class RunRecorder {
	readonly record: RunRecord;
	readonly #store: RunStore;
	readonly #started: number;

	constructor(
		store: RunStore,
		init: { id?: string; input: unknown; kind: RunKind; target: string }
	) {
		this.#store = store;
		this.#started = Date.now();
		this.record = {
			id: init.id ?? globalThis.crypto.randomUUID(),
			kind: init.kind,
			target: init.target,
			status: "running",
			startedAt: new Date(this.#started).toISOString(),
			input: init.input,
			events: [],
		};
	}

	/** Continue recording an existing run (workflow resume). */
	static resume(store: RunStore, record: RunRecord): RunRecorder {
		const recorder = new RunRecorder(store, {
			id: record.id,
			input: record.input,
			kind: record.kind,
			target: record.target,
		});
		Object.assign(recorder.record, {
			startedAt: record.startedAt,
			events: [...record.events],
			eventsDropped: record.eventsDropped,
			status: "running",
			snapshot: record.snapshot,
		});
		return recorder;
	}

	/** Append one event. */
	event(type: string, data: unknown): void {
		if (this.record.events.length >= MAX_TRACE_EVENTS) {
			this.record.eventsDropped = (this.record.eventsDropped ?? 0) + 1;
			return;
		}
		this.record.events.push({
			type,
			data,
			offsetMs: Date.now() - this.#started,
		});
	}

	/** Persist the current state without ending the run. */
	async save(): Promise<void> {
		await this.#store.save(this.record);
	}

	/** End the run and persist it. */
	async finish(
		status: Exclude<RunRecordStatus, "running">,
		result: { error?: string; output?: unknown; snapshot?: WorkflowSnapshot }
	): Promise<void> {
		this.record.status = status;
		this.record.endedAt = new Date().toISOString();
		if (result.output !== undefined) {
			this.record.output = result.output;
		}
		if (result.error === undefined) {
			this.record.error = undefined;
		} else {
			this.record.error = result.error;
		}
		if (result.snapshot) {
			this.record.snapshot = result.snapshot;
		}
		await this.#store.save(this.record);
	}
}
