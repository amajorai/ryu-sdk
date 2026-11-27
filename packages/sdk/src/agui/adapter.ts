/**
 * Map Ryu agent streams onto AG-UI events.
 *
 * Two sources feed the same stateful mapper:
 *
 * - the SDK `AgentEvent` stream (`agent.stream()` / `runAgentLoop`), and
 * - Core's durable harness SSE stream (`HarnessAPI.events()` envelopes).
 *
 * The mapper owns the bookkeeping AG-UI requires and neither source carries:
 * message ids, open/close pairing of `TEXT_MESSAGE_*` and `STEP_*`, the tool
 * call's parent message, and the transcript produced during the run (for
 * `MESSAGES_SNAPSHOT`). An approval or account-connection pause becomes a
 * `CUSTOM` `on_interrupt` event followed by `RUN_FINISHED` with
 * `outcome: "interrupt"`, which is how AG-UI clients render human-in-the-loop
 * prompts and later resume the thread.
 */

// biome-ignore lint/correctness/useImportExtensions: Published client exposes only the package root.
import type { HarnessRunEventEnvelope } from "@ryuhq/client";
import type { AgentEvent } from "../agent/loop.ts";
import {
	AG_UI_INTERRUPT_EVENT,
	type AgUiEvent,
	type AgUiInterrupt,
	type AgUiJson,
	type AgUiMessage,
	type AgUiToolCall,
} from "./events.ts";

/** Options for one AG-UI run. */
export interface AgUiMapperOptions {
	/** Mint message ids; defaults to `crypto.randomUUID()`. */
	idFactory?: () => string;
	/** Clock for event timestamps (ms); omit to leave `timestamp` unset. */
	now?: () => number;
	parentRunId?: string;
	runId: string;
	/**
	 * Messages the client sent. When provided, a `MESSAGES_SNAPSHOT` of these
	 * plus the messages produced by the run is emitted before `RUN_FINISHED`.
	 */
	snapshotMessages?: AgUiMessage[];
	threadId: string;
}

/** Convert any value into JSON (`undefined` and non-JSON leaves become null). */
export function toAgUiJson(value: unknown): AgUiJson {
	if (value === undefined) {
		return null;
	}
	try {
		const encoded = JSON.stringify(value);
		// SAFETY: JSON.parse of a JSON.stringify result is a JSON value.
		return encoded === undefined ? null : (JSON.parse(encoded) as AgUiJson);
	} catch {
		return String(value);
	}
}

function toContentString(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	return JSON.stringify(toAgUiJson(value));
}

function defaultId(): string {
	return globalThis.crypto.randomUUID();
}

interface OpenAssistant {
	content: string;
	id: string;
	textOpen: boolean;
	toolCalls: AgUiToolCall[];
}

/**
 * Stateful AgentEvent / harness event → AG-UI event mapper for one thread. A
 * mapper may span several AG-UI runs of the same agent execution (an
 * interrupted run resumed later): call {@link beginRun} for each.
 */
export class AgUiEventMapper {
	private readonly idFactory: () => string;
	private readonly now?: () => number;
	private readonly snapshotBase?: AgUiMessage[];
	private readonly produced: AgUiMessage[] = [];
	private readonly threadId: string;
	private runId: string;
	private parentRunId?: string;
	private assistant: OpenAssistant | null = null;
	private stepIndex = 0;
	private stepOpen = false;
	/** A tool result (or repair) closed the round; the next output opens one. */
	private roundDone = false;
	private lastToolCallId?: string;
	private pendingInterrupt?: AgUiInterrupt;
	private ended = false;

	constructor(options: AgUiMapperOptions) {
		this.idFactory = options.idFactory ?? defaultId;
		this.now = options.now;
		this.snapshotBase = options.snapshotMessages;
		this.threadId = options.threadId;
		this.runId = options.runId;
		this.parentRunId = options.parentRunId;
	}

	/** Whether the current AG-UI run already ended (finished, errored, or paused). */
	get terminated(): boolean {
		return this.ended;
	}

	/** The interrupt a paused run is waiting on, if any. */
	get interrupt(): AgUiInterrupt | undefined {
		return this.pendingInterrupt;
	}

	/** Messages produced so far in this execution (assistant + tool). */
	get messages(): AgUiMessage[] {
		const out = [...this.produced];
		const open = this.assistant;
		if (open) {
			out.push(this.assistantMessage(open));
		}
		return out;
	}

	private stamp<T extends AgUiEvent>(event: T): T {
		if (this.now) {
			event.timestamp = this.now();
		}
		return event;
	}

	/** Emit `RUN_STARTED`. For a resumed execution pass the new run id. */
	beginRun(next?: { parentRunId?: string; runId: string }): AgUiEvent[] {
		if (next) {
			this.parentRunId = next.parentRunId ?? this.runId;
			this.runId = next.runId;
		}
		this.ended = false;
		this.pendingInterrupt = undefined;
		const event: AgUiEvent = {
			type: "RUN_STARTED",
			threadId: this.threadId,
			runId: this.runId,
		};
		if (this.parentRunId) {
			event.parentRunId = this.parentRunId;
		}
		return [this.stamp(event)];
	}

	private assistantMessage(open: OpenAssistant): AgUiMessage {
		const message: AgUiMessage = { id: open.id, role: "assistant" };
		if (open.content) {
			message.content = open.content;
		}
		if (open.toolCalls.length > 0) {
			message.toolCalls = open.toolCalls;
		}
		return message;
	}

	private closeText(out: AgUiEvent[]) {
		const open = this.assistant;
		if (open?.textOpen) {
			open.textOpen = false;
			out.push(this.stamp({ type: "TEXT_MESSAGE_END", messageId: open.id }));
		}
	}

	private closeMessage(out: AgUiEvent[]) {
		this.closeText(out);
		if (this.assistant) {
			this.produced.push(this.assistantMessage(this.assistant));
			this.assistant = null;
		}
	}

	private closeRound(out: AgUiEvent[]) {
		this.closeMessage(out);
		if (this.stepOpen) {
			this.stepOpen = false;
			out.push(
				this.stamp({
					type: "STEP_FINISHED",
					stepName: `step-${this.stepIndex}`,
				})
			);
		}
	}

	/** Open a step + assistant message for model output, closing a finished round. */
	private openAssistant(out: AgUiEvent[]): OpenAssistant {
		if (this.roundDone) {
			this.roundDone = false;
			this.closeRound(out);
		}
		if (!this.stepOpen) {
			this.stepOpen = true;
			this.stepIndex += 1;
			out.push(
				this.stamp({
					type: "STEP_STARTED",
					stepName: `step-${this.stepIndex}`,
				})
			);
		}
		this.assistant ??= {
			id: this.idFactory(),
			content: "",
			textOpen: false,
			toolCalls: [],
		};
		return this.assistant;
	}

	private text(delta: string): AgUiEvent[] {
		const out: AgUiEvent[] = [];
		if (delta === "") {
			return out;
		}
		let open = this.openAssistant(out);
		if (!open.textOpen) {
			if (open.toolCalls.length > 0) {
				// Text after this message's tool calls starts a new message.
				this.closeMessage(out);
				open = this.openAssistant(out);
			}
			open.textOpen = true;
			out.push(
				this.stamp({
					type: "TEXT_MESSAGE_START",
					messageId: open.id,
					role: "assistant",
				})
			);
		}
		open.content += delta;
		out.push(
			this.stamp({ type: "TEXT_MESSAGE_CONTENT", messageId: open.id, delta })
		);
		return out;
	}

	private toolCall(id: string, name: string, args?: string): AgUiEvent[] {
		const out: AgUiEvent[] = [];
		const open = this.openAssistant(out);
		this.closeText(out);
		this.lastToolCallId = id;
		open.toolCalls.push({
			id,
			type: "function",
			function: { name, arguments: args ?? "" },
		});
		out.push(
			this.stamp({
				type: "TOOL_CALL_START",
				toolCallId: id,
				toolCallName: name,
				parentMessageId: open.id,
			})
		);
		if (args !== undefined && args !== "") {
			out.push(
				this.stamp({ type: "TOOL_CALL_ARGS", toolCallId: id, delta: args })
			);
		}
		out.push(this.stamp({ type: "TOOL_CALL_END", toolCallId: id }));
		return out;
	}

	private toolResult(id: string, content: string): AgUiEvent[] {
		const out: AgUiEvent[] = [];
		this.closeMessage(out);
		const messageId = this.idFactory();
		this.produced.push({
			id: messageId,
			role: "tool",
			toolCallId: id,
			content,
		});
		if (this.pendingInterrupt?.reason === "tool_approval") {
			// The approval was decided in-process and the tool ran.
			this.pendingInterrupt = undefined;
		}
		this.roundDone = true;
		out.push(
			this.stamp({
				type: "TOOL_CALL_RESULT",
				messageId,
				toolCallId: id,
				content,
				role: "tool",
			})
		);
		return out;
	}

	private announceInterrupt(interrupt: AgUiInterrupt): AgUiEvent[] {
		const out: AgUiEvent[] = [];
		this.closeText(out);
		this.pendingInterrupt = interrupt;
		out.push(
			this.stamp({
				type: "CUSTOM",
				name: AG_UI_INTERRUPT_EVENT,
				value: {
					id: interrupt.id,
					reason: interrupt.reason,
					payload: interrupt.payload ?? null,
				},
			})
		);
		return out;
	}

	private snapshot(out: AgUiEvent[]) {
		if (this.snapshotBase) {
			out.push(
				this.stamp({
					type: "MESSAGES_SNAPSHOT",
					messages: [...this.snapshotBase, ...this.messages],
				})
			);
		}
	}

	/**
	 * End the current AG-UI run. A pending interrupt ends it with
	 * `outcome: "interrupt"`; otherwise `result` is the run's result value.
	 */
	finish(result?: AgUiJson): AgUiEvent[] {
		if (this.ended) {
			return [];
		}
		const out: AgUiEvent[] = [];
		const interrupt = this.pendingInterrupt;
		if (interrupt) {
			this.closeText(out);
		} else {
			this.closeRound(out);
		}
		this.snapshot(out);
		const finished: AgUiEvent = {
			type: "RUN_FINISHED",
			threadId: this.threadId,
			runId: this.runId,
		};
		if (interrupt) {
			finished.outcome = "interrupt";
			finished.interrupt = interrupt;
		} else {
			finished.outcome = "success";
			if (result !== undefined) {
				finished.result = result;
			}
		}
		out.push(this.stamp(finished));
		this.ended = true;
		return out;
	}

	/** End the current AG-UI run with `RUN_ERROR`. */
	error(message: string, code?: string): AgUiEvent[] {
		if (this.ended) {
			return [];
		}
		const out: AgUiEvent[] = [];
		this.closeRound(out);
		const event: AgUiEvent = { type: "RUN_ERROR", message };
		if (code) {
			event.code = code;
		}
		out.push(this.stamp(event));
		this.ended = true;
		this.pendingInterrupt = undefined;
		return out;
	}

	/** Map one SDK `AgentEvent`. */
	fromAgentEvent(event: AgentEvent): AgUiEvent[] {
		switch (event.type) {
			case "text":
				return this.text(event.content);
			case "tool_call":
				return this.toolCall(
					event.id,
					event.name,
					event.input === undefined ? undefined : toContentString(event.input)
				);
			case "tool_result":
				return this.toolResult(event.id, toContentString(event.output));
			case "approval_requested": {
				const payload: { [key: string]: AgUiJson } = {
					approvalId: event.approvalId,
					summary: event.summary,
					options: toAgUiJson(event.options ?? []),
				};
				if (event.name) {
					payload.toolName = event.name;
				}
				if (event.input !== undefined) {
					payload.input = toAgUiJson(event.input);
				}
				if (this.lastToolCallId && event.name !== "runtime") {
					payload.toolCallId = this.lastToolCallId;
				}
				return this.announceInterrupt({
					id: event.approvalId,
					reason: "tool_approval",
					payload,
				});
			}
			case "auth_required": {
				const payload: { [key: string]: AgUiJson } = { tool: event.tool };
				if (event.url) {
					payload.url = event.url;
				}
				if (event.message) {
					payload.message = event.message;
				}
				return this.announceInterrupt({
					id: `auth_${event.tool}`,
					reason: "auth_required",
					payload,
				});
			}
			case "output_repair": {
				this.roundDone = true;
				const out: AgUiEvent[] = [];
				this.closeText(out);
				out.push(
					this.stamp({
						type: "CUSTOM",
						name: "ryu.output_repair",
						value: {
							attempt: event.attempt,
							issues: toAgUiJson(event.issues),
						},
					})
				);
				return out;
			}
			case "error":
				return this.error(event.message, event.code);
			case "result": {
				const result: { [key: string]: AgUiJson } = {
					text: event.text,
					steps: event.steps,
				};
				if (event.output !== undefined) {
					result.output = toAgUiJson(event.output);
				}
				if (event.usage) {
					result.usage = toAgUiJson(event.usage);
				}
				// A result means nothing is pending any more.
				this.pendingInterrupt = undefined;
				return this.finish(result);
			}
			default:
				return [];
		}
	}

	/** Map one Core harness event envelope. */
	fromHarnessEvent(envelope: HarnessRunEventEnvelope): AgUiEvent[] {
		switch (envelope.type) {
			case "run_started":
				return [];
			case "text_delta":
				return this.text(envelope.delta);
			case "tool_call_started":
				return this.toolCall(envelope.toolCallId, envelope.name);
			case "tool_call_completed": {
				const output: { [key: string]: AgUiJson } = { ok: envelope.ok };
				if (envelope.resultHash) {
					output.resultHash = envelope.resultHash;
				}
				if (envelope.durationMs !== undefined) {
					output.durationMs = envelope.durationMs;
				}
				return this.toolResult(envelope.toolCallId, JSON.stringify(output));
			}
			case "approval_requested":
				return this.announceInterrupt({
					id: envelope.approvalId,
					reason: "tool_approval",
					payload: {
						approvalId: envelope.approvalId,
						summary: envelope.summary,
						options: toAgUiJson(envelope.options ?? []),
					},
				});
			case "run_completed":
				this.pendingInterrupt = undefined;
				return this.finish(
					envelope.output === undefined
						? undefined
						: toAgUiJson(envelope.output)
				);
			case "run_failed":
				return this.error(envelope.message, envelope.code);
			case "run_canceled":
				return this.error("run canceled", "canceled");
			case "run_interrupted":
				return this.error("run interrupted", "interrupted");
			case "input_accepted":
			case "checkpoint":
			case "ui_frame":
				return [
					this.stamp({
						type: "RAW",
						source: "ryu.harness",
						event: toAgUiJson(envelope),
					}),
				];
			default:
				return [];
		}
	}
}

/** Shared driver: map a source stream, closing the run when the source ends. */
async function* mapStream<T>(
	source: AsyncIterable<T>,
	mapper: AgUiEventMapper,
	map: (event: T) => AgUiEvent[]
): AsyncGenerator<AgUiEvent> {
	yield* mapper.beginRun();
	try {
		for await (const event of source) {
			yield* map(event);
			if (mapper.terminated) {
				return;
			}
		}
	} catch (error) {
		yield* mapper.error(
			error instanceof Error ? error.message : String(error),
			"stream_failed"
		);
		return;
	}
	// The source ended without a terminal event: an approval/auth pause (when
	// no handler decided it) or a cut stream. Either way close the run.
	yield* mapper.finish();
}

/**
 * Convert an SDK `AgentEvent` stream (for example `agent.stream(prompt)`) into
 * a complete AG-UI run: `RUN_STARTED` … `RUN_FINISHED` / `RUN_ERROR`.
 */
export function agentEventsToAgUi(
	events: AsyncIterable<AgentEvent>,
	options: AgUiMapperOptions
): AsyncGenerator<AgUiEvent> {
	const mapper = new AgUiEventMapper(options);
	return mapStream(events, mapper, (event) => mapper.fromAgentEvent(event));
}

/**
 * Convert Core's durable harness stream (`HarnessAPI.events(runId)` /
 * `HarnessAPI.run(...)`) into a complete AG-UI run. `threadId` defaults to the
 * harness session id and `runId` to the harness run id when not supplied.
 */
export async function* harnessEventsToAgUi(
	events: AsyncIterable<HarnessRunEventEnvelope>,
	options: Partial<AgUiMapperOptions> = {}
): AsyncGenerator<AgUiEvent> {
	const iterator = events[Symbol.asyncIterator]();
	let first: IteratorResult<HarnessRunEventEnvelope>;
	try {
		first = await iterator.next();
	} catch (error) {
		// The stream failed before its first event: still report a whole run.
		const mapper = new AgUiEventMapper({
			...options,
			threadId: options.threadId ?? defaultId(),
			runId: options.runId ?? defaultId(),
		});
		yield* mapper.beginRun();
		yield* mapper.error(
			error instanceof Error ? error.message : String(error),
			"stream_failed"
		);
		return;
	}
	const head = first.done ? undefined : first.value;
	const mapper = new AgUiEventMapper({
		...options,
		threadId: options.threadId ?? head?.sessionId ?? defaultId(),
		runId: options.runId ?? head?.runId ?? defaultId(),
	});
	async function* rest(): AsyncGenerator<HarnessRunEventEnvelope> {
		if (head) {
			yield head;
		}
		if (first.done) {
			return;
		}
		for (;;) {
			const next = await iterator.next();
			if (next.done) {
				return;
			}
			yield next.value;
		}
	}
	yield* mapStream(rest(), mapper, (event) => mapper.fromHarnessEvent(event));
}
