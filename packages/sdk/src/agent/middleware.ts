/**
 * In-process middleware for the SDK agent loop.
 *
 * Core already runs plugin turn hooks (`defineTurnHook` / `defineFunctionHook`)
 * for every Core-owned chat and harness run, but those bodies execute in the
 * plugin sandbox and cannot close over the calling app's state. The SDK's own
 * loop (`Agent` without a `sessionId`) runs in the caller's process and never
 * reaches Core's hook runtime, so this module gives it the equivalent seam as
 * ordinary functions.
 *
 * The phases map onto Core's hook vocabulary:
 *
 * - `wrapModelCall` covers `context` (rewrite the outbound messages),
 *   `pre_model_select` (swap the model), and `handled` (answer without calling
 *   the model by returning a result instead of calling `next`).
 * - `wrapToolCall` covers `pre_tool_use` (deny by returning an error output
 *   without calling `next`) and `tool_result` (transform the output before the
 *   model sees it).
 * - `afterTurn` covers `post_assistant_turn` `continue` (inject a follow-up user
 *   turn and loop again, still bounded by `maxSteps`).
 *
 * Middleware composes onion-style in array order: the first entry is the
 * outermost wrapper, so it sees the request first and the result last.
 */

import type {
	LoopMessage,
	ModelCallResult,
	ToolFunctionDef,
} from "./model-call.ts";

/** The request one model round sends to the gateway. */
export interface ModelCallRequest {
	/**
	 * Outbound transcript for this call. It is a copy: return a new array from a
	 * rewritten request rather than mutating the messages in place.
	 */
	messages: LoopMessage[];
	/** Model id routed by the gateway. */
	model: string;
	/** 1-based model round within this run. */
	step: number;
	/** Tool definitions offered to the model, when any are configured. */
	tools?: ToolFunctionDef[];
}

/** Continue to the next middleware, or to the gateway when none remain. */
export type ModelCallNext = (
	request: ModelCallRequest
) => Promise<ModelCallResult>;

/** One tool call the model requested. */
export interface ToolCallRequest {
	/** The model's tool-call id. */
	id: string;
	/** Parsed tool arguments. */
	input: unknown;
	/** Model-facing tool name (a key of the agent's `tools`). */
	name: string;
	/** 1-based model round that produced this call. */
	step: number;
}

/** What a tool call reports back to the model. */
export interface ToolCallResult {
	/** The tool output; objects are JSON-encoded into the transcript. */
	output: unknown;
}

/** Continue to the next middleware, or to the tool itself when none remain. */
export type ToolCallNext = (
	request: ToolCallRequest
) => Promise<ToolCallResult>;

/** The state of a run when the model stops calling tools. */
export interface TurnSummary {
	/** The full transcript so far, including the final assistant message. */
	messages: readonly LoopMessage[];
	/** Model rounds used so far. */
	step: number;
	/** The final assistant text of this turn. */
	text: string;
}

/** Ask the loop to run another turn with `continue` as the next user message. */
export interface AfterTurnContinue {
	continue: string;
}

/** An `afterTurn` handler's decision; `undefined` lets the run finish. */
export type AfterTurnDirective = AfterTurnContinue | undefined;

/** A set of optional phase handlers that customize an SDK agent run. */
export interface AgentMiddleware {
	/** Runs when the model stops calling tools. The first `continue` wins. */
	afterTurn?: (
		turn: TurnSummary
	) => AfterTurnDirective | Promise<AfterTurnDirective>;
	/** Optional label, useful when logging which middleware acted. */
	name?: string;
	/** Wrap each gateway call. Return without calling `next` to skip the model. */
	wrapModelCall?: (
		request: ModelCallRequest,
		next: ModelCallNext
	) => Promise<ModelCallResult>;
	/** Wrap each tool execution. Return without calling `next` to block it. */
	wrapToolCall?: (
		request: ToolCallRequest,
		next: ToolCallNext
	) => Promise<ToolCallResult>;
}

type Wrapper<Req, Res> = (
	request: Req,
	next: (request: Req) => Promise<Res>
) => Promise<Res>;

function compose<Req, Res>(
	wrappers: Wrapper<Req, Res>[],
	inner: (request: Req) => Promise<Res>
): (request: Req) => Promise<Res> {
	let next = inner;
	for (const wrapper of [...wrappers].reverse()) {
		const downstream = next;
		next = (request) => wrapper(request, downstream);
	}
	return next;
}

/** Chain every `wrapModelCall` around the gateway call, first entry outermost. */
export function composeModelCall(
	middleware: readonly AgentMiddleware[],
	inner: ModelCallNext
): ModelCallNext {
	const wrappers: Wrapper<ModelCallRequest, ModelCallResult>[] = [];
	for (const entry of middleware) {
		if (entry.wrapModelCall) {
			wrappers.push(entry.wrapModelCall.bind(entry));
		}
	}
	return compose(wrappers, inner);
}

/** Chain every `wrapToolCall` around tool execution, first entry outermost. */
export function composeToolCall(
	middleware: readonly AgentMiddleware[],
	inner: ToolCallNext
): ToolCallNext {
	const wrappers: Wrapper<ToolCallRequest, ToolCallResult>[] = [];
	for (const entry of middleware) {
		if (entry.wrapToolCall) {
			wrappers.push(entry.wrapToolCall.bind(entry));
		}
	}
	return compose(wrappers, inner);
}

/** Run `afterTurn` handlers in order; the first non-empty `continue` wins. */
export async function runAfterTurn(
	middleware: readonly AgentMiddleware[],
	turn: TurnSummary
): Promise<string | undefined> {
	for (const entry of middleware) {
		if (!entry.afterTurn) {
			continue;
		}
		const directive = await entry.afterTurn(turn);
		const text = directive?.continue.trim();
		if (text) {
			return directive?.continue;
		}
	}
	return;
}
