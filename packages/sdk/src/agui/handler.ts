/**
 * `toAgUiHandler(agent)` — serve a Ryu `Agent` over the AG-UI protocol.
 *
 * The returned function takes a Fetch `Request` (an AG-UI `RunAgentInput`
 * POST) and returns an SSE `Response`, so it mounts directly in Bun.serve,
 * Hono, Next.js route handlers, Deno, or Cloudflare Workers. CopilotKit-style
 * frontends connect to it with their generic AG-UI HTTP agent.
 *
 * Human-in-the-loop: when a tool marked `needsApproval` (SDK loop) or a Core
 * harness permission request (`sessionId` agents) needs a decision, the run is
 * suspended in memory and the response ends with a `CUSTOM` `on_interrupt`
 * event plus `RUN_FINISHED { outcome: "interrupt" }`. The client resumes by
 * POSTing the same thread with `resume: { interruptId, payload }` (or
 * CopilotKit's `forwardedProps.command.resume`); the suspended execution then
 * continues streaming into the new response. Suspended runs live in this
 * handler's process and are denied after `interruptTimeoutMs`; an interrupt id
 * only resumes its own thread, and a payload that is not a recognized approval
 * (or an offered option id) denies. A client disconnect stops the run and
 * denies its pending approvals. An `auth_required` interrupt ends the
 * execution, so resuming it starts a fresh run of the thread.
 *
 * The handler does not authenticate requests: mount it behind the host app's
 * own auth.
 */

import { z } from "zod";
import { Agent, type AgentRunOptions } from "../agent/agent.ts";
import type { AgentEvent } from "../agent/loop.ts";
import type { LoopMessage, ToolCall } from "../agent/model-call.ts";
import { hasHandoffs, streamWithHandoffs } from "../agent/network.ts";
import type {
	AgentApprovalDecision,
	AgentApprovalOption,
	AgentApprovalRequest,
} from "../agent/tools.ts";
import { AgUiEventMapper } from "./adapter.ts";
import {
	AG_UI_SSE_CONTENT_TYPE,
	type AgUiEvent,
	type AgUiJson,
	type AgUiMessage,
	encodeAgUiEvent,
	type RunAgentInput,
	type RunAgentInputMessage,
	runAgentInputSchema,
} from "./events.ts";
import { diffJsonState } from "./json-patch.ts";

const DEFAULT_INTERRUPT_TIMEOUT_MS = 10 * 60 * 1000;

/** Fold agent events into AG-UI shared state; changes stream as `STATE_DELTA`. */
export type AgUiStateReducer = (state: AgUiJson, event: AgentEvent) => AgUiJson;

/** Options for {@link toAgUiHandler}. */
export interface AgUiHandlerOptions {
	/** Extra response headers (for example CORS). */
	headers?: Record<string, string>;
	/** Mint ids for runs/messages; defaults to `crypto.randomUUID()`. */
	idFactory?: () => string;
	/**
	 * Suspend runs on approval requests and resume them on a later request
	 * (default true). When the agent already has an `approvalHandler`, that
	 * handler decides and no interrupt is raised.
	 */
	interrupts?: boolean;
	/** How long a suspended run waits for a resume before it is denied. */
	interruptTimeoutMs?: number;
	/**
	 * Shared-state reducer. With it, the handler emits `STATE_SNAPSHOT` of the
	 * client's `state` at run start and a `STATE_DELTA` (JSON Patch) whenever
	 * the reducer returns a different state.
	 */
	reduceState?: AgUiStateReducer;
}

/** A Fetch handler serving one agent over AG-UI. */
export type AgUiHandler = ((request: Request) => Promise<Response>) & {
	/** Number of runs currently suspended on an interrupt. */
	readonly pendingInterrupts: number;
};

// ── Run pump ──────────────────────────────────────────────────────────────────

type PumpItem =
	| { event: AgentEvent; kind: "event" }
	| { kind: "interrupt"; request: AgentApprovalRequest }
	| { error: string; kind: "crash" }
	| { kind: "done" };

/** Decouples the agent's generator from whichever response is reading it. */
class RunPump {
	private readonly items: PumpItem[] = [];
	private wake?: () => void;

	push(item: PumpItem) {
		this.items.push(item);
		this.wake?.();
		this.wake = undefined;
	}

	async next(): Promise<PumpItem> {
		for (;;) {
			const item = this.items.shift();
			if (item) {
				return item;
			}
			await new Promise<void>((resolve) => {
				this.wake = resolve;
			});
		}
	}

	drive(stream: AsyncIterable<AgentEvent>) {
		(async () => {
			try {
				for await (const event of stream) {
					this.push({ kind: "event", event });
				}
			} catch (error) {
				this.push({
					kind: "crash",
					error: error instanceof Error ? error.message : String(error),
				});
			} finally {
				this.push({ kind: "done" });
			}
		})();
	}
}

interface PendingApproval {
	request: AgentApprovalRequest;
	resolve: (decision: AgentApprovalDecision) => void;
}

interface Execution {
	abort: AbortController;
	decisions: Map<string, PendingApproval>;
	mapper: AgUiEventMapper;
	pump: RunPump;
	runId: string;
	state: AgUiJson;
	threadId: string;
}

interface AuthInterrupt {
	interruptId: string;
	runId: string;
	timer: ReturnType<typeof setTimeout>;
}

/** Abort an execution and deny every approval it is waiting on. */
function cancelExecution(execution: Execution) {
	execution.abort.abort();
	for (const pending of execution.decisions.values()) {
		pending.resolve(false);
	}
	execution.decisions.clear();
}

/** Deny one pending approval (if it is still pending). */
function denyPending(execution: Execution, approvalId: string) {
	const pending = execution.decisions.get(approvalId);
	execution.decisions.delete(approvalId);
	pending?.resolve(false);
}

interface Suspended {
	execution: Execution;
	interruptId: string;
	timer: ReturnType<typeof setTimeout>;
}

// ── Input conversion ──────────────────────────────────────────────────────────

function userText(
	content: Extract<RunAgentInputMessage, { role: "user" }>["content"]
) {
	if (typeof content === "string") {
		return content;
	}
	const parts: string[] = [];
	for (const part of content) {
		const text = z
			.object({ type: z.literal("text"), text: z.string() })
			.safeParse(part);
		if (text.success) {
			parts.push(text.data.text);
		}
	}
	return parts.join("\n");
}

/** Convert AG-UI messages into the SDK loop transcript. */
export function agUiMessagesToTranscript(
	messages: RunAgentInputMessage[]
): LoopMessage[] {
	const transcript: LoopMessage[] = [];
	for (const message of messages) {
		switch (message.role) {
			case "user":
				transcript.push({ role: "user", content: userText(message.content) });
				break;
			case "system":
			case "developer":
				transcript.push({ role: "system", content: message.content });
				break;
			case "assistant": {
				const toolCalls: ToolCall[] = (message.toolCalls ?? []).map((call) => ({
					id: call.id,
					type: "function",
					function: call.function,
				}));
				transcript.push(
					toolCalls.length > 0
						? {
								role: "assistant",
								content: message.content ?? null,
								tool_calls: toolCalls,
							}
						: { role: "assistant", content: message.content ?? null }
				);
				break;
			}
			case "tool":
				transcript.push({
					role: "tool",
					tool_call_id: message.toolCallId,
					content: message.content,
				});
				break;
			default:
				break;
		}
	}
	return transcript;
}

function snapshotMessages(
	messages: RunAgentInputMessage[],
	idFactory: () => string
): AgUiMessage[] {
	const out: AgUiMessage[] = [];
	for (const message of messages) {
		const id = message.id || idFactory();
		switch (message.role) {
			case "user":
				out.push({ id, role: "user", content: userText(message.content) });
				break;
			case "system":
			case "developer":
				out.push({ id, role: message.role, content: message.content });
				break;
			case "assistant": {
				const entry: AgUiMessage = { id, role: "assistant" };
				if (message.content) {
					entry.content = message.content;
				}
				if (message.toolCalls?.length) {
					entry.toolCalls = message.toolCalls;
				}
				out.push(entry);
				break;
			}
			case "tool":
				out.push({
					id,
					role: "tool",
					toolCallId: message.toolCallId,
					content: message.content,
				});
				break;
			default:
				break;
		}
	}
	return out;
}

function contextBlock(context: RunAgentInput["context"]): string {
	return [
		"Context from the application:",
		...context.map((entry) => `- ${entry.description}: ${entry.value}`),
	].join("\n");
}

/** Insert the client's `context` entries as a user message before the last user turn. */
function withContext(
	transcript: LoopMessage[],
	context: RunAgentInput["context"]
): LoopMessage[] {
	if (context.length === 0) {
		return transcript;
	}
	const block = contextBlock(context);
	let lastUser = -1;
	transcript.forEach((message, index) => {
		if (message.role === "user") {
			lastUser = index;
		}
	});
	const at = lastUser === -1 ? transcript.length : lastUser;
	return [
		...transcript.slice(0, at),
		{ role: "user", content: block },
		...transcript.slice(at),
	];
}

// ── Resume decoding ───────────────────────────────────────────────────────────

const decisionObjectSchema = z.object({
	approved: z.boolean().optional(),
	optionId: z.string().min(1).optional(),
});

const APPROVE_WORDS = new Set(["approve", "approved", "allow", "yes"]);

/** An option id the request offered, or `false` (deny) for anything else. */
function offeredOption(
	optionId: string,
	options: AgentApprovalOption[]
): AgentApprovalDecision {
	return options.some((option) => option.optionId === optionId)
		? optionId
		: false;
}

/**
 * Read an approval decision from a resume payload. `options` are the choices
 * the approval request offered: a string or `optionId` picks one of them, an
 * approve verb approves, and anything unrecognized denies (fail closed).
 */
export function decodeResumeDecision(
	payload: AgUiJson | undefined,
	options: AgentApprovalOption[] = []
): AgentApprovalDecision {
	if (typeof payload === "boolean") {
		return payload;
	}
	if (typeof payload === "string") {
		const trimmed = payload.trim();
		const offered = offeredOption(trimmed, options);
		if (offered !== false) {
			return offered;
		}
		return APPROVE_WORDS.has(trimmed.toLowerCase());
	}
	const parsed = decisionObjectSchema.safeParse(payload);
	if (parsed.success) {
		if (parsed.data.optionId) {
			return offeredOption(parsed.data.optionId, options);
		}
		return parsed.data.approved === true;
	}
	return false;
}

const commandSchema = z.object({
	command: z.object({
		resume: z.json(),
		interruptId: z.string().min(1).optional(),
	}),
});

interface ResumeRequest {
	interruptId?: string;
	payload?: AgUiJson;
}

function readResume(input: RunAgentInput): ResumeRequest | undefined {
	if (input.resume) {
		return Array.isArray(input.resume) ? input.resume[0] : input.resume;
	}
	const command = commandSchema.safeParse(input.forwardedProps);
	if (command.success) {
		return {
			interruptId: command.data.command.interruptId,
			payload: command.data.command.resume,
		};
	}
	return undefined;
}

// ── Handler ───────────────────────────────────────────────────────────────────

function lastUserPrompt(transcript: LoopMessage[]): string | undefined {
	for (let index = transcript.length - 1; index >= 0; index--) {
		const message = transcript[index];
		if (message?.role === "user") {
			return message.content;
		}
	}
	return undefined;
}

/**
 * The prompt a `sessionId` agent sends to Core: the last user message, with
 * the client's `context` entries ahead of it (Core keeps the earlier turns).
 */
function sessionPrompt(
	transcript: LoopMessage[],
	context: RunAgentInput["context"]
): string | undefined {
	const prompt = lastUserPrompt(transcript);
	if (prompt === undefined || context.length === 0) {
		return prompt;
	}
	return `${contextBlock(context)}\n\n${prompt}`;
}

/** Pick the agent entry point: Core session, handoff chain, or SDK loop. */
function runEvents<TOutput>(
	runner: Agent<TOutput>,
	transcript: LoopMessage[],
	prompt: string | undefined,
	signal: AbortSignal,
	approvalHandler?: AgentRunOptions["approvalHandler"]
): AsyncIterable<AgentEvent> {
	if (runner.config.sessionId) {
		return runner.stream(prompt ?? "", signal);
	}
	if (hasHandoffs(runner.config.tools)) {
		// Handoff targets run with their own config, so the interrupt handler must
		// travel with the chain or their approvals could never be resumed.
		return streamWithHandoffs(runner, transcript, signal, approvalHandler);
	}
	return runner.streamMessages(transcript, { signal });
}

/**
 * Serve `agent` over AG-UI. Mount the returned handler on a POST route; it
 * answers each `RunAgentInput` with an SSE stream of AG-UI events.
 */
export function toAgUiHandler<TOutput>(
	agent: Agent<TOutput>,
	options: AgUiHandlerOptions = {}
): AgUiHandler {
	const idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
	const timeoutMs = options.interruptTimeoutMs ?? DEFAULT_INTERRUPT_TIMEOUT_MS;
	const interruptsEnabled =
		(options.interrupts ?? true) && !agent.config.approvalHandler;
	const byInterrupt = new Map<string, Suspended>();
	const byThread = new Map<string, Suspended>();
	/**
	 * Account-connection interrupts end their execution (the loop stops), so a
	 * resume for one starts a fresh run of the thread. Kept per thread for
	 * `interruptTimeoutMs`.
	 */
	const authByThread = new Map<string, AuthInterrupt>();

	const rememberAuthInterrupt = (execution: Execution) => {
		const interrupt = execution.mapper.interrupt;
		if (interrupt?.reason !== "auth_required") {
			return;
		}
		const previous = authByThread.get(execution.threadId);
		if (previous) {
			clearTimeout(previous.timer);
		}
		const entry: AuthInterrupt = {
			interruptId: interrupt.id,
			runId: execution.runId,
			timer: setTimeout(() => {
				if (authByThread.get(execution.threadId) === entry) {
					authByThread.delete(execution.threadId);
				}
			}, timeoutMs),
		};
		authByThread.set(execution.threadId, entry);
	};

	const forget = (suspended: Suspended) => {
		clearTimeout(suspended.timer);
		byInterrupt.delete(suspended.interruptId);
		if (byThread.get(suspended.execution.threadId) === suspended) {
			byThread.delete(suspended.execution.threadId);
		}
	};

	/** Drain an execution nobody is reading any more so its generator finishes. */
	const discard = async (execution: Execution) => {
		cancelExecution(execution);
		for (;;) {
			const item = await execution.pump.next();
			if (item.kind === "done") {
				return;
			}
			if (item.kind === "interrupt") {
				denyPending(execution, item.request.approvalId);
			}
		}
	};

	const suspend = (execution: Execution, interruptId: string) => {
		const previous = byThread.get(execution.threadId);
		if (previous && previous.execution !== execution) {
			forget(previous);
			discard(previous.execution);
		}
		const suspended: Suspended = {
			execution,
			interruptId,
			timer: setTimeout(() => {
				forget(suspended);
				discard(execution);
			}, timeoutMs),
		};
		byInterrupt.set(interruptId, suspended);
		byThread.set(execution.threadId, suspended);
	};

	const respond = (
		produce: (emit: (events: AgUiEvent[]) => void) => Promise<void>,
		onCancel?: () => void
	): Response => {
		const encoder = new TextEncoder();
		let closed = false;
		const body = new ReadableStream<Uint8Array>({
			async start(controller) {
				const emit = (events: AgUiEvent[]) => {
					if (closed) {
						return;
					}
					for (const event of events) {
						controller.enqueue(encoder.encode(encodeAgUiEvent(event)));
					}
				};
				try {
					await produce(emit);
				} finally {
					if (!closed) {
						closed = true;
						controller.close();
					}
				}
			},
			cancel() {
				closed = true;
				onCancel?.();
			},
		});
		return new Response(body, {
			status: 200,
			headers: {
				"Content-Type": AG_UI_SSE_CONTENT_TYPE,
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				...options.headers,
			},
		});
	};

	/**
	 * Move pump items into a response until the run finishes or suspends
	 * (`"ended"`), or until the client disconnects (`"cancelled"`, after which
	 * the caller drains the execution with every approval denied). The
	 * response is the execution's only reader while it runs.
	 */
	const pumpInto = async (
		execution: Execution,
		emit: (events: AgUiEvent[]) => void,
		isCancelled: () => boolean
	): Promise<"cancelled" | "ended"> => {
		for (;;) {
			const item = await execution.pump.next();
			if (item.kind === "done" && isCancelled()) {
				return "ended";
			}
			if (isCancelled()) {
				if (item.kind === "interrupt") {
					denyPending(execution, item.request.approvalId);
				}
				return "cancelled";
			}
			switch (item.kind) {
				case "event":
					emit(execution.mapper.fromAgentEvent(item.event));
					if (options.reduceState) {
						const next = options.reduceState(execution.state, item.event);
						const delta = diffJsonState(execution.state, next);
						execution.state = next;
						if (delta.length > 0) {
							emit([{ type: "STATE_DELTA", delta }]);
						}
					}
					break;
				case "interrupt":
					if (!execution.mapper.interrupt) {
						// Defensive: announce it if the loop did not.
						emit(
							execution.mapper.fromAgentEvent({
								type: "approval_requested",
								...item.request,
							})
						);
					}
					suspend(execution, item.request.approvalId);
					emit(execution.mapper.finish());
					return "ended";
				case "crash":
					emit(execution.mapper.error(item.error, "agent_failed"));
					return "ended";
				default:
					emit(execution.mapper.finish());
					rememberAuthInterrupt(execution);
					return "ended";
			}
		}
	};

	/** Stream an execution until it finishes or suspends. */
	const stream = (execution: Execution, head: AgUiEvent[]) => {
		let cancelled = false;
		return respond(
			async (emit) => {
				emit(head);
				try {
					if ((await pumpInto(execution, emit, () => cancelled)) === "ended") {
						return;
					}
				} catch (error) {
					// A failing `reduceState` (or encoder) ends this response; the
					// agent's generator is still drained below.
					emit(
						execution.mapper.error(
							error instanceof Error ? error.message : String(error),
							"handler_failed"
						)
					);
				}
				await discard(execution);
			},
			() => {
				cancelled = true;
				cancelExecution(execution);
			}
		);
	};

	const errorRun = (input: RunAgentInput, message: string, code: string) => {
		const mapper = new AgUiEventMapper({
			threadId: input.threadId ?? idFactory(),
			runId: input.runId ?? idFactory(),
			idFactory,
		});
		return respond(async (emit) => {
			emit(mapper.beginRun());
			emit(mapper.error(message, code));
		});
	};

	const findSuspended = (
		input: RunAgentInput,
		request: ResumeRequest
	): Suspended | undefined => {
		const suspended = request.interruptId
			? byInterrupt.get(request.interruptId)
			: input.threadId
				? byThread.get(input.threadId)
				: undefined;
		// An interrupt id only resumes the thread it was raised on.
		if (
			suspended &&
			input.threadId &&
			suspended.execution.threadId !== input.threadId
		) {
			return undefined;
		}
		return suspended;
	};

	const findAuthInterrupt = (
		input: RunAgentInput,
		request: ResumeRequest
	): AuthInterrupt | undefined => {
		if (!input.threadId) {
			return undefined;
		}
		const entry = authByThread.get(input.threadId);
		if (
			!entry ||
			(request.interruptId && request.interruptId !== entry.interruptId)
		) {
			return undefined;
		}
		return entry;
	};

	const resume = (input: RunAgentInput, request: ResumeRequest): Response => {
		const suspended = findSuspended(input, request);
		if (!suspended) {
			const auth = findAuthInterrupt(input, request);
			if (auth && input.threadId) {
				// The account is connected now: run the thread again.
				clearTimeout(auth.timer);
				authByThread.delete(input.threadId);
				return start({
					...input,
					parentRunId: input.parentRunId ?? auth.runId,
				});
			}
			return errorRun(
				input,
				"no suspended run matches this resume request",
				"interrupt_not_found"
			);
		}
		forget(suspended);
		const { execution, interruptId } = suspended;
		const runId = input.runId ?? idFactory();
		const begin = execution.mapper.beginRun({
			runId,
			parentRunId: input.parentRunId ?? execution.runId,
		});
		execution.runId = runId;
		const pending = execution.decisions.get(interruptId);
		execution.decisions.delete(interruptId);
		pending?.resolve(
			decodeResumeDecision(request.payload, pending.request.options ?? [])
		);
		return stream(execution, begin);
	};

	const start = (input: RunAgentInput): Response => {
		const threadId = input.threadId ?? idFactory();
		const runId = input.runId ?? idFactory();
		const messages = agUiMessagesToTranscript(input.messages);
		const transcript = withContext(messages, input.context);
		const prompt = sessionPrompt(messages, input.context);
		if (
			agent.config.sessionId ? prompt === undefined : transcript.length === 0
		) {
			return errorRun(
				{ ...input, threadId, runId },
				"the run needs at least one user message",
				"no_user_message"
			);
		}
		const execution: Execution = {
			abort: new AbortController(),
			decisions: new Map(),
			mapper: new AgUiEventMapper({
				threadId,
				runId,
				parentRunId: input.parentRunId,
				idFactory,
				snapshotMessages: snapshotMessages(input.messages, idFactory),
			}),
			pump: new RunPump(),
			runId,
			state: input.state ?? {},
			threadId,
		};
		const approvalHandler: AgentRunOptions["approvalHandler"] | undefined =
			interruptsEnabled
				? (request) =>
						new Promise<AgentApprovalDecision>((resolve) => {
							execution.decisions.set(request.approvalId, { request, resolve });
							execution.pump.push({ kind: "interrupt", request });
						})
				: undefined;
		const runner = approvalHandler
			? new Agent<TOutput>({ ...agent.config, approvalHandler })
			: agent;
		const signal = execution.abort.signal;
		execution.pump.drive(
			runEvents(runner, transcript, prompt, signal, approvalHandler)
		);
		const begin = execution.mapper.beginRun();
		if (options.reduceState) {
			begin.push({ type: "STATE_SNAPSHOT", snapshot: execution.state });
		}
		return stream(execution, begin);
	};

	const handler = async (request: Request): Promise<Response> => {
		if (request.method !== "POST") {
			return new Response(JSON.stringify({ error: "method not allowed" }), {
				status: 405,
				headers: { "Content-Type": "application/json", Allow: "POST" },
			});
		}
		let raw: unknown;
		try {
			raw = await request.json();
		} catch {
			return badRequest("request body must be JSON");
		}
		const parsed = runAgentInputSchema.safeParse(raw);
		if (!parsed.success) {
			return badRequest(
				`invalid RunAgentInput: ${parsed.error.issues[0]?.message ?? "unknown"}`
			);
		}
		const resumeRequest = readResume(parsed.data);
		return resumeRequest
			? resume(parsed.data, resumeRequest)
			: start(parsed.data);
	};

	return Object.defineProperty(handler, "pendingInterrupts", {
		get: () => byInterrupt.size,
	}) as AgUiHandler;
}

function badRequest(message: string): Response {
	return new Response(JSON.stringify({ error: message }), {
		status: 400,
		headers: { "Content-Type": "application/json" },
	});
}
