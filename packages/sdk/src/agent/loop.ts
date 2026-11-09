/**
 * The autonomous agent loop for the Ryu SDK runtime.
 *
 * This is what `defineAgent` never had: a real multi-turn tool-calling loop that
 * runs in TypeScript. Each round calls the node's gateway with the resolved
 * tool definitions; if the model emits `tool_calls`, each is executed (local
 * runnable or Core `/api/mcp/tools/call`), results are fed back, and the loop
 * repeats until the model stops calling tools or `maxSteps` is reached.
 *
 * Emitted events mirror Core's `AcpEvent` categories (see cli/dev.ts) plus an
 * `auth_required` pause — when a remote tool returns Ryu's connection-required
 * envelope (first-run Gmail OAuth), the loop surfaces the connect URL and stops
 * instead of feeding the envelope back as a normal tool result.
 */

import { z } from "zod";
import { appToolJsonObjectSchema } from "../runnable/app.ts";
import { primitiveJsonSchema } from "../runnable/primitive-contracts.ts";
import {
	type JsonSchemaObject,
	normalizeSchema,
	type SchemaLike,
	toJsonSchema,
} from "../schema/json-schema.ts";
import type { SchemaIssue } from "../schema/json-schema-validator.ts";
import type { StandardSchemaV1 } from "../schema/standard-schema.ts";
import {
	buildRepairPrompt,
	DEFAULT_MAX_REPAIR_ATTEMPTS,
	describeStructuredOutputFailure,
	isStrictCompatibleJsonSchema,
	readStructuredReply,
	STRUCTURED_OUTPUT_ERROR_CODE,
} from "../schema/structured-output.ts";
import {
	type AgentMiddleware,
	composeModelCall,
	composeToolCall,
	type ModelCallRequest,
	runAfterTurn,
	type ToolCallRequest,
} from "./middleware.ts";
import {
	type AssistantMessage,
	type LoopMessage,
	type ModelCallResult,
	type ModelUsage,
	streamModelWithTools,
	type ToolCall,
	type ToolFunctionDef,
} from "./model-call.ts";
import { describeSdkError as describeError } from "./runtime-values.ts";
import {
	type AgentApprovalHandler,
	type AgentApprovalOption,
	type AgentApprovalRequest,
	type AgentTool,
	detectElicitation,
	executeTool,
	resolveToolDefs,
	type ToolExecContext,
} from "./tools.ts";

// ── Events ────────────────────────────────────────────────────────────────────

/** A streamed text fragment from the assistant. */
export interface AgentEventText {
	content: string;
	type: "text";
}

/** The model initiated a tool call. */
export interface AgentEventToolCall {
	id: string;
	input: unknown;
	name: string;
	type: "tool_call";
}

/** A tool finished (or failed with an error output the model can recover from). */
export interface AgentEventToolResult {
	id: string;
	name: string;
	output: unknown;
	type: "tool_result";
}

/** A remote tool needs an account connection — the loop paused. */
export interface AgentEventAuthRequired {
	message?: string;
	tool: string;
	type: "auth_required";
	url?: string;
}

/** A durable harness run paused behind a human approval decision. */
export interface AgentEventApprovalRequested {
	approvalId: string;
	input?: unknown;
	name?: string;
	options?: AgentApprovalOption[];
	summary: string;
	type: "approval_requested";
}

/** A fatal loop error — the stream ends after this. */
export interface AgentEventError {
	/** Structured-output failures only: model rounds that produced a reply. */
	attempts?: number;
	/** Stable machine code; `structured_output_invalid` for schema failures. */
	code?: typeof STRUCTURED_OUTPUT_ERROR_CODE;
	/** Structured-output failures only: problems with the last reply. */
	issues?: SchemaIssue[];
	message: string;
	/** Structured-output failures only: the last raw reply. */
	text?: string;
	type: "error";
}

/**
 * The final reply did not satisfy `outputSchema`; the loop is re-asking the
 * model with these issues (repair attempt `attempt` of `maxRepairAttempts`).
 */
export interface AgentEventOutputRepair {
	attempt: number;
	issues: SchemaIssue[];
	type: "output_repair";
}

/** Terminal event carrying the final text, step count, and aggregate usage. */
export interface AgentEventResult {
	output?: unknown;
	steps: number;
	text: string;
	type: "result";
	usage?: ModelUsage;
}

/** Union of everything the loop yields. */
export type AgentEvent =
	| AgentEventApprovalRequested
	| AgentEventAuthRequired
	| AgentEventError
	| AgentEventOutputRepair
	| AgentEventResult
	| AgentEventText
	| AgentEventToolCall
	| AgentEventToolResult;

// ── Config ────────────────────────────────────────────────────────────────────

/** Inputs for a single loop run. */
export interface LoopConfig {
	/** Optional human decision callback for tools marked `needsApproval`. */
	approvalHandler?: AgentApprovalHandler;
	/** Gateway base URL for inference (the target node). */
	gatewayBaseUrl: string;
	/** Gateway bearer token. */
	gatewayToken?: string;
	/**
	 * Times the model is re-asked (with the validation issues) after a final
	 * reply that fails `outputSchema`, before the loop ends with a
	 * `structured_output_invalid` error. Default 2. Repair rounds do not consume
	 * `maxSteps`.
	 */
	maxRepairAttempts?: number;
	/** Hard ceiling on model→tool rounds. */
	maxSteps: number;
	/** Seed transcript (system + user messages already assembled). */
	messages: LoopMessage[];
	/** In-process middleware, first entry outermost (see middleware.ts). */
	middleware?: AgentMiddleware[];
	/** Model id routed by the gateway. */
	model: string;
	/**
	 * Optional schema for the final structured output: a JSON Schema object or
	 * any Standard Schema (zod, valibot, arktype, …). The reply is parsed and
	 * validated; `result.output` carries the validated value.
	 */
	outputSchema?: SchemaLike;
	/** Abort signal. */
	signal?: AbortSignal;
	/** Context for resolving + executing tools. */
	toolCtx: ToolExecContext;
	/** Tools keyed by model-facing name. */
	tools: Record<string, AgentTool>;
}

function safeParse(json: string) {
	try {
		return primitiveJsonSchema.parse(JSON.parse(json));
	} catch {
		return json;
	}
}

function addUsage(a: ModelUsage | undefined, b: ModelUsage | undefined) {
	if (!(a || b)) {
		return undefined;
	}
	return {
		promptTokens: (a?.promptTokens ?? 0) + (b?.promptTokens ?? 0),
		completionTokens: (a?.completionTokens ?? 0) + (b?.completionTokens ?? 0),
		totalTokens: (a?.totalTokens ?? 0) + (b?.totalTokens ?? 0),
	};
}

/** The normalized output contract: validator + wire JSON Schema + budget. */
interface OutputContract {
	jsonSchema: JsonSchemaObject;
	maxRepairAttempts: number;
	schema: StandardSchemaV1;
}

function resolveRepairBudget(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) {
		return DEFAULT_MAX_REPAIR_ATTEMPTS;
	}
	return Math.max(0, Math.floor(value));
}

function resolveOutputContract(config: LoopConfig): OutputContract | undefined {
	if (!config.outputSchema) {
		return undefined;
	}
	const schema = normalizeSchema(config.outputSchema);
	return {
		schema,
		jsonSchema: toJsonSchema(schema, "input"),
		maxRepairAttempts: resolveRepairBudget(config.maxRepairAttempts),
	};
}

/** Look at a tool output (object or JSON string) for the elicitation envelope. */
function findElicitation(output: Parameters<typeof detectElicitation>[0]) {
	const direct = detectElicitation(output);
	if (direct) {
		return direct;
	}
	const text = z.string().safeParse(output);
	if (text.success) {
		return detectElicitation(safeParse(text.data));
	}
	return null;
}

function requiresApproval(tool: AgentTool): boolean {
	return tool.needsApproval === true;
}

function approvalId(): string {
	const random =
		globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
	return `sdk_approval_${random}`;
}

/**
 * Run the autonomous loop, yielding events as they occur. The generator returns
 * after a terminal `result`, `auth_required`, or `error` event.
 */
export async function* runAgentLoop(
	config: LoopConfig
): AsyncGenerator<AgentEvent> {
	const messages = [...config.messages];
	let toolDefs: Awaited<ReturnType<typeof resolveToolDefs>>;
	let output: OutputContract | undefined;
	try {
		output = resolveOutputContract(config);
		toolDefs = await resolveToolDefs(config.tools, config.toolCtx);
	} catch (err) {
		yield { type: "error", message: describeError(err) };
		return;
	}

	let usage: ModelUsage | undefined;
	let lastText = "";
	const middleware = config.middleware ?? [];
	let repairsUsed = 0;

	// Structured-output repair rounds extend the budget instead of consuming it.
	for (let step = 1; step <= config.maxSteps + repairsUsed; step++) {
		let result: ModelCallResult;
		let roundText = "";
		try {
			result = yield* streamRound(
				config,
				messages,
				toolDefs,
				step,
				output?.jsonSchema,
				(delta) => {
					roundText += delta;
				}
			);
		} catch (err) {
			yield { type: "error", message: describeError(err) };
			return;
		}

		usage = addUsage(usage, result.usage);
		const assistant: AssistantMessage = result.message;
		messages.push(assistant);

		if (assistant.content && assistant.content !== roundText) {
			// JSON fallback responses, streamed tool-call preambles without text
			// deltas, and middleware-supplied replies all surface the completed
			// assistant content as one text event.
			lastText = assistant.content;
			if (!roundText) {
				yield { type: "text", content: assistant.content };
			}
		} else if (roundText) {
			lastText = roundText;
		}

		const toolCalls = assistant.tool_calls ?? [];
		if (toolCalls.length === 0) {
			let followUp: string | undefined;
			try {
				followUp =
					step < config.maxSteps
						? await runAfterTurn(middleware, { messages, step, text: lastText })
						: undefined;
			} catch (err) {
				yield { type: "error", message: describeError(err) };
				return;
			}
			if (followUp !== undefined) {
				messages.push({ role: "user", content: followUp });
				continue;
			}
			if (!output) {
				yield { type: "result", text: lastText, steps: step, usage };
				return;
			}
			const replyText = assistant.content || roundText;
			const reply = await readStructuredReply(replyText, output.schema);
			if (reply.ok) {
				yield {
					type: "result",
					text: lastText,
					steps: step,
					usage,
					output: reply.value,
				};
				return;
			}
			if (repairsUsed < output.maxRepairAttempts) {
				repairsUsed += 1;
				yield {
					type: "output_repair",
					attempt: repairsUsed,
					issues: reply.issues,
				};
				messages.push({
					role: "user",
					content: buildRepairPrompt(reply.issues, output.jsonSchema),
				});
				continue;
			}
			const attempts = repairsUsed + 1;
			yield {
				type: "error",
				code: STRUCTURED_OUTPUT_ERROR_CODE,
				message: describeStructuredOutputFailure(reply.issues, attempts),
				issues: reply.issues,
				attempts,
				text: replyText,
			};
			return;
		}

		const paused = yield* runToolCalls(toolCalls, messages, config, step);
		if (paused) {
			return;
		}
	}

	// Ran out of steps — surface what we have rather than hang. With an output
	// contract the caller asked for a validated value, so the last text must
	// still satisfy it; a run that never produced one ends in the typed error
	// instead of a result whose `output` is silently missing.
	const steps = config.maxSteps + repairsUsed;
	if (!output) {
		yield { type: "result", text: lastText, steps, usage };
		return;
	}
	const reply = await readStructuredReply(lastText, output.schema);
	if (reply.ok) {
		yield { type: "result", text: lastText, steps, usage, output: reply.value };
		return;
	}
	const attempts = repairsUsed + 1;
	yield {
		type: "error",
		code: STRUCTURED_OUTPUT_ERROR_CODE,
		message: `step budget (${steps}) exhausted; ${describeStructuredOutputFailure(reply.issues, attempts)}`,
		issues: reply.issues,
		attempts,
		text: lastText,
	};
}

/**
 * Run one model round through the `wrapModelCall` chain. The innermost call
 * streams the gateway response; its text deltas are yielded as they arrive even
 * though the chain itself is promise-based, and are also reported to
 * `onDelta` so the caller can tell streamed text from a middleware reply.
 */
async function* streamRound(
	config: LoopConfig,
	messages: LoopMessage[],
	toolDefs: ToolFunctionDef[],
	step: number,
	responseSchema: JsonSchemaObject | undefined,
	onDelta: (delta: string) => void
): AsyncGenerator<AgentEventText, ModelCallResult> {
	const pending: string[] = [];
	let wake: (() => void) | undefined;
	let settled = false;

	const callGateway = async (
		request: ModelCallRequest
	): Promise<ModelCallResult> => {
		const tools =
			request.tools && request.tools.length > 0 ? request.tools : undefined;
		let result: ModelCallResult | undefined;
		const options: Parameters<typeof streamModelWithTools>[0] = {
			baseUrl: config.gatewayBaseUrl,
			token: config.gatewayToken,
			model: request.model,
			messages: request.messages,
			tools,
			toolChoice: tools ? "auto" : undefined,
			signal: config.signal,
		};
		if (responseSchema) {
			options.responseFormat = appToolJsonObjectSchema.parse({
				type: "json_schema",
				json_schema: {
					name: "ryu_output",
					strict: isStrictCompatibleJsonSchema(responseSchema),
					schema: responseSchema,
				},
			});
		}
		for await (const modelEvent of streamModelWithTools(options)) {
			if (modelEvent.type === "text_delta") {
				pending.push(modelEvent.delta);
				wake?.();
			} else {
				result = modelEvent.result;
			}
		}
		if (!result) {
			throw new Error("gateway stream ended without a result");
		}
		return result;
	};

	const call = composeModelCall(config.middleware ?? [], callGateway);
	const request: ModelCallRequest = {
		messages: [...messages],
		model: config.model,
		step,
	};
	if (toolDefs.length > 0) {
		request.tools = toolDefs;
	}
	const running = call(request).finally(() => {
		settled = true;
		wake?.();
	});
	// The rejection is re-thrown by the `await` below; this only keeps the
	// runtime from reporting it as unhandled while deltas are still draining.
	running.catch(() => undefined);

	for (;;) {
		let delta = pending.shift();
		while (delta !== undefined) {
			onDelta(delta);
			yield { type: "text", content: delta };
			delta = pending.shift();
		}
		if (settled) {
			break;
		}
		await new Promise<void>((resolve) => {
			wake = resolve;
		});
		wake = undefined;
	}
	return await running;
}

/**
 * Execute the model's tool calls, appending results to `messages`. Yields
 * tool_call/tool_result/auth_required events. Returns `true` when the loop must
 * stop (an elicitation pause was surfaced).
 */
async function* runToolCalls(
	toolCalls: ToolCall[],
	messages: LoopMessage[],
	config: LoopConfig,
	step: number
): AsyncGenerator<AgentEvent, boolean> {
	// Execute the final middleware input, including in-place edits. Invalid model
	// arguments remain errors rather than being converted into an empty object.
	const invalidArguments = new Map<string, string>();
	const execute = composeToolCall(
		config.middleware ?? [],
		async (request: ToolCallRequest) => {
			const invalid = invalidArguments.get(request.id);
			if (invalid !== undefined) {
				throw new Error(
					`[ryu-sdk] tool "${request.name}" arguments were not valid JSON: ${invalid}`
				);
			}
			const argumentsJson = JSON.stringify(request.input);
			if (argumentsJson === undefined) {
				throw new Error(
					`[ryu-sdk] tool "${request.name}" input is not JSON serializable`
				);
			}
			const res = await executeTool(
				request.name,
				argumentsJson,
				config.tools,
				config.toolCtx
			);
			return { output: res.output };
		}
	);
	for (const call of toolCalls) {
		const name = call.function.name;
		let input: unknown;
		try {
			input =
				call.function.arguments.trim() === ""
					? {}
					: JSON.parse(call.function.arguments);
		} catch {
			input = call.function.arguments;
			invalidArguments.set(call.id, call.function.arguments);
		}
		yield { type: "tool_call", id: call.id, name, input };

		let output: unknown;
		const tool = config.tools[name];
		if (tool && requiresApproval(tool)) {
			const approval: AgentApprovalRequest = {
				approvalId: approvalId(),
				input,
				name,
				summary: `The agent requested permission to run ${name}.`,
			};
			yield { type: "approval_requested", ...approval };
			if (!config.approvalHandler) {
				return true;
			}
			let decision: Awaited<ReturnType<AgentApprovalHandler>> = false;
			try {
				decision = await config.approvalHandler(approval);
			} catch (error) {
				const approvalError = { error: describeError(error) };
				messages.push({
					role: "tool",
					tool_call_id: call.id,
					content: JSON.stringify(approvalError),
				});
				yield {
					type: "tool_result",
					id: call.id,
					name,
					output: approvalError,
				};
				continue;
			}
			const approved =
				decision === true || (decision !== false && decision.trim().length > 0);
			if (!approved) {
				const denied = { error: "tool execution was not approved" };
				messages.push({
					role: "tool",
					tool_call_id: call.id,
					content: JSON.stringify(denied),
				});
				yield { type: "tool_result", id: call.id, name, output: denied };
				continue;
			}
		}
		try {
			const res = await execute({ id: call.id, input, name, step });
			output = res.output;
		} catch (err) {
			// Recoverable: feed the error back so the model can adjust.
			const errPayload = { error: describeError(err) };
			messages.push({
				role: "tool",
				tool_call_id: call.id,
				content: JSON.stringify(errPayload),
			});
			yield { type: "tool_result", id: call.id, name, output: errPayload };
			continue;
		}

		const elicitation = findElicitation(output);
		if (elicitation) {
			yield {
				type: "auth_required",
				tool: name,
				url: elicitation.url,
				message: elicitation.message,
			};
			return true;
		}

		const printableOutput = z.string().safeParse(output);
		messages.push({
			role: "tool",
			tool_call_id: call.id,
			content: printableOutput.success
				? printableOutput.data
				: JSON.stringify(output),
		});
		yield { type: "tool_result", id: call.id, name, output };
	}
	return false;
}
