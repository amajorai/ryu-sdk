/**
 * Native tool-calling model call for the Ryu agent runtime.
 *
 * The gateway-mandatory `ModelClient` (packages/sdk/src/model/client.ts) only
 * exposes text `chat`/`stream` — it cannot pass a `tools` array or receive
 * `tool_calls`. The autonomous agent loop needs both, so this module makes a
 * direct request to the node's gateway `POST /v1/chat/completions` endpoint
 * with the caller's own `tools` and reads back `message.tool_calls`.
 *
 * The no-direct-provider guarantee is preserved: `assertAllowedEgressUrl` (the
 * same Rust-cored blocklist the ModelClient uses) is called before every fetch,
 * so a direct provider base URL throws exactly as it would elsewhere in the SDK.
 *
 * `x-ryu-raw-tools: on` is always sent. On a plain gateway it is a harmless
 * no-op; on a Composio-on managed node it forces the plain completion branch so
 * the caller's `tool_calls` are returned verbatim instead of being intercepted
 * and executed by Core's own tool loop (see apps/gateway/src/pipeline/mod.rs).
 */

import type { z } from "zod";
import { assertAllowedEgressUrl } from "../model/gateway.ts";
import { appToolJsonObjectSchema } from "../runnable/app.ts";
import {
	chatCompletionResponseSchema,
	chatCompletionStreamChunkSchema,
} from "./model-response-contracts.ts";

// ── OpenAI-compatible wire types (function-calling subset) ────────────────────

/** An OpenAI function tool definition passed to the model. */
export interface ToolFunctionDef {
	function: {
		description?: string;
		name: string;
		/** JSON Schema for the function's arguments. */
		parameters: z.output<typeof appToolJsonObjectSchema>;
	};
	type: "function";
}

/** A single tool call emitted by the model. */
export interface ToolCall {
	function: {
		/** JSON-encoded arguments string (per the OpenAI wire format). */
		arguments: string;
		name: string;
	};
	id: string;
	type: "function";
}

/** An assistant turn — may carry text, tool calls, or both. */
export interface AssistantMessage {
	content: string | null;
	role: "assistant";
	tool_calls?: ToolCall[];
}

/** A message in the loop's running transcript. */
export type LoopMessage =
	| { content: string; role: "system" | "user" }
	| AssistantMessage
	| { content: string; role: "tool"; tool_call_id: string };

/** Token usage as reported by the gateway (optional — gateway may omit). */
export interface ModelUsage {
	completionTokens: number;
	promptTokens: number;
	totalTokens: number;
}

/** Options for a single native tool-calling completion. */
export interface ModelCallOptions {
	/** Gateway base URL (no trailing `/v1`). */
	baseUrl: string;
	/** Running transcript. */
	messages: LoopMessage[];
	/** Model id routed by the gateway (provider is derived from the id). */
	model: string;
	/** Optional OpenAI-compatible response format for structured output. */
	responseFormat?: z.output<typeof appToolJsonObjectSchema>;
	/** Abort signal for cancellation. */
	signal?: AbortSignal;
	/** Bearer token forwarded to the gateway (never a provider key). */
	token?: string;
	/** How the model should choose tools; defaults to gateway/provider default. */
	toolChoice?: "auto" | "none" | "required";
	/** Function tool definitions the model may call. */
	tools?: ToolFunctionDef[];
}

/** Result of a single completion. */
export interface ModelCallResult {
	finishReason: string | null;
	message: AssistantMessage;
	usage?: ModelUsage;
}

/** A chunk from a streaming OpenAI-compatible completion. */
export type ModelStreamEvent =
	| { delta: string; type: "text_delta" }
	| { result: ModelCallResult; type: "done" };

// ── Internal response shape (minimal subset we read) ──────────────────────────

type ChatCompletionResponse = z.output<typeof chatCompletionResponseSchema>;

const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

/** Strip a trailing slash so `baseUrl + path` never doubles up. */
function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

/** The Gateway's scheme, host and port: never a path, query or credential. */
export function gatewayOrigin(base: string): string {
	try {
		const origin = new URL(base).origin;
		return origin === "null" ? "the configured gateway URL" : origin;
	} catch {
		return "the configured gateway URL";
	}
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : "";
}

/**
 * Why a fetch failed. Node's undici rejects every network failure with
 * `TypeError: fetch failed` and puts the real reason (`connect ECONNREFUSED
 * 127.0.0.1:7981`, `getaddrinfo ENOTFOUND ...`) in `cause`, so that generic
 * message is replaced by the cause's message or code.
 */
function failureReason(error: unknown): string {
	if (!(error instanceof Error)) {
		return String(error);
	}
	if (error.message === "fetch failed" && error.cause instanceof Error) {
		const cause: Error & { code?: unknown } = error.cause;
		const code = typeof cause.code === "string" ? cause.code : "";
		const detail = cause.message || code;
		if (detail) {
			return detail;
		}
	}
	return error.message || error.name;
}

/**
 * When a Gateway call fails: `"connect"` while waiting for the response
 * headers, `"read"` while reading the body (the JSON, or the SSE stream).
 */
export type GatewayCallPhase = "connect" | "read";

/**
 * A failed Gateway call, named in full: a refused, unresolvable or reset
 * connection says which origin it tried and the settings that choose it, and
 * a timeout (an `AbortSignal.timeout` signal) says the Gateway did not answer
 * in time, whether it fires before the response headers or while the body
 * streams. The caller's own abort is rethrown unchanged, and so is any other
 * error while reading the body (`phase: "read"`), as Python does. The message
 * never contains the token; the original error is the `cause`. Mirrors
 * `_model_call_failure` in `bindings/python/ryu_sdk/agent.py`, except that a
 * timeout during the connect itself also reads "did not respond in time": an
 * abort signal does not say which phase it interrupted.
 */
export function gatewayFetchFailure(
	error: unknown,
	base: string,
	signal?: AbortSignal,
	phase: GatewayCallPhase = "connect"
): unknown {
	const name = errorName(error);
	const reason = failureReason(error);
	const origin = gatewayOrigin(base);
	if (name === "TimeoutError") {
		return new Error(
			`the Ryu Gateway at ${origin} did not respond in time (${reason}). Check that the Gateway is healthy and its upstream model provider answers, or point the agent at another one with RYU_GATEWAY_URL (or node.baseUrl) and RYU_GATEWAY_TOKEN (or node.token).`,
			{ cause: error }
		);
	}
	if (signal?.aborted || name === "AbortError" || phase === "read") {
		return error;
	}
	return new Error(
		`could not reach the Ryu Gateway at ${origin} (${reason}). Start the Gateway, or point the agent at a running one: set RYU_GATEWAY_URL (or node.baseUrl) to its origin and RYU_GATEWAY_TOKEN (or node.token) to its token.`,
		{ cause: error }
	);
}

/** `fetch` to the Gateway with connection failures named by {@link gatewayFetchFailure}. */
async function fetchGateway(
	base: string,
	init: RequestInit
): Promise<Response> {
	try {
		return await fetch(`${base}${CHAT_COMPLETIONS_PATH}`, init);
	} catch (error) {
		throw gatewayFetchFailure(error, base, init.signal ?? undefined);
	}
}

/** Read part of a Gateway response body, with a stall named by {@link gatewayFetchFailure}. */
async function readGateway<T>(
	base: string,
	signal: AbortSignal | undefined,
	read: () => Promise<T>
): Promise<T> {
	try {
		return await read();
	} catch (error) {
		throw gatewayFetchFailure(error, base, signal, "read");
	}
}

/**
 * A non-2xx Gateway answer. Names the origin only (a base path or userinfo
 * can hold a credential), and on 401/403 the token settings that fix it.
 */
export async function gatewayStatusError(
	res: Response,
	base: string
): Promise<Error> {
	const text = await res.text().catch(() => "");
	const status = `${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
	const auth =
		res.status === 401 || res.status === 403
			? "; check RYU_GATEWAY_TOKEN (or node.token)"
			: "";
	return new Error(
		`[ryu-sdk] gateway ${status} at ${gatewayOrigin(base)}${auth}${text ? `: ${text}` : ""}`
	);
}

export interface ModelRequestBody {
	messages: LoopMessage[];
	model: string;
	response_format?: ModelCallOptions["responseFormat"];
	stream: boolean;
	tool_choice?: ModelCallOptions["toolChoice"];
	tools?: ToolFunctionDef[];
}
function requestBody(options: ModelCallOptions, stream: boolean) {
	const body: ModelRequestBody = {
		model: options.model,
		messages: options.messages,
		stream,
	};
	if (options.tools && options.tools.length > 0) {
		body.tools = options.tools.map((tool) => ({
			...tool,
			function: {
				...tool.function,
				parameters: appToolJsonObjectSchema.parse(tool.function.parameters),
			},
		}));
		if (options.toolChoice) {
			body.tool_choice = options.toolChoice;
		}
	}
	if (options.responseFormat) {
		body.response_format = appToolJsonObjectSchema.parse(
			options.responseFormat
		);
	}
	return body;
}

function requestHeaders(options: ModelCallOptions) {
	const headers = new Headers({
		"content-type": "application/json",
		"x-ryu-raw-tools": "on",
	});
	if (options.token) {
		headers.set("authorization", `Bearer ${options.token}`);
	}
	return headers;
}

function parseModelCallResponse(json: ChatCompletionResponse): ModelCallResult {
	const choice = json.choices?.[0];
	const rawMessage = choice?.message;
	const message: AssistantMessage = {
		role: "assistant",
		content: rawMessage?.content ?? null,
	};

	if (rawMessage?.tool_calls?.length) {
		message.tool_calls = rawMessage.tool_calls;
	}

	const usage: ModelUsage | undefined = json.usage
		? {
				promptTokens: json.usage.prompt_tokens ?? 0,
				completionTokens: json.usage.completion_tokens ?? 0,
				totalTokens: json.usage.total_tokens ?? 0,
			}
		: undefined;

	return {
		message,
		finishReason: choice?.finish_reason ?? null,
		usage,
	};
}

/**
 * Call the node's gateway with the caller's own tools and return the first
 * choice, including any `tool_calls`.
 *
 * Throws when the base URL is a direct provider (egress enforcement) or when
 * the gateway returns a non-2xx status.
 */
export async function callModelWithTools(
	options: ModelCallOptions
): Promise<ModelCallResult> {
	const base = normalizeBaseUrl(options.baseUrl);
	// Preserve the BYOK-at-the-gateway rule — same blocklist as ModelClient.
	assertAllowedEgressUrl(base);

	const body = requestBody(options, false);
	const headers = requestHeaders(options);

	const res = await fetchGateway(base, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: options.signal,
	});

	if (!res.ok) {
		throw await gatewayStatusError(res, base);
	}

	const json: unknown = await readGateway(base, options.signal, () =>
		res.json()
	);
	return parseModelCallResponse(chatCompletionResponseSchema.parse(json));
}

function streamDataFrames(buffer: string) {
	const frames: string[] = [];
	let rest = buffer;
	while (true) {
		const match = /\r?\n\r?\n/.exec(rest);
		if (!match || match.index === undefined) {
			break;
		}
		const raw = rest.slice(0, match.index);
		rest = rest.slice(match.index + match[0].length);
		const data = raw
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n");
		if (data) {
			frames.push(data);
		}
	}
	return { frames, rest };
}

/**
 * Stream a gateway completion and assemble tool-call deltas into one final
 * assistant message. Providers that do not expose SSE are accepted through a
 * JSON fallback, which keeps older gateways and deterministic test doubles
 * compatible while preserving real deltas whenever the gateway supports them.
 */
export async function* streamModelWithTools(
	options: ModelCallOptions
): AsyncGenerator<ModelStreamEvent> {
	const base = normalizeBaseUrl(options.baseUrl);
	assertAllowedEgressUrl(base);
	const res = await fetchGateway(base, {
		method: "POST",
		headers: requestHeaders(options),
		body: JSON.stringify(requestBody(options, true)),
		signal: options.signal,
	});
	if (!res.ok) {
		throw await gatewayStatusError(res, base);
	}

	const contentType = res.headers.get("content-type") ?? "";
	if (!(contentType.includes("text/event-stream") && res.body)) {
		const json: unknown = await readGateway(base, options.signal, () =>
			res.json()
		);
		const fallback = parseModelCallResponse(
			chatCompletionResponseSchema.parse(json)
		);
		yield { type: "done", result: fallback };
		return;
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let content = "";
	let finishReason: string | null = null;
	let usage: ModelUsage | undefined;
	const toolCalls = new Map<
		number,
		{ arguments: string; id: string; name: string }
	>();

	try {
		while (true) {
			const { done, value } = await readGateway(base, options.signal, () =>
				reader.read()
			);
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const parsed = streamDataFrames(buffer);
			buffer = parsed.rest;
			for (const frame of parsed.frames) {
				if (frame === "[DONE]") {
					continue;
				}
				const chunk = chatCompletionStreamChunkSchema.parse(JSON.parse(frame));
				const choice = chunk.choices?.[0];
				finishReason = choice?.finish_reason ?? finishReason;
				if (chunk.usage) {
					usage = {
						promptTokens: chunk.usage.prompt_tokens ?? 0,
						completionTokens: chunk.usage.completion_tokens ?? 0,
						totalTokens: chunk.usage.total_tokens ?? 0,
					};
				}
				const delta = choice?.delta;
				if (delta?.content) {
					content += delta.content;
					yield { type: "text_delta", delta: delta.content };
				}
				for (const [fallbackIndex, tool] of (
					delta?.tool_calls ?? []
				).entries()) {
					const index = tool.index ?? fallbackIndex;
					const current = toolCalls.get(index) ?? {
						arguments: "",
						id: tool.id ?? `call_${index}`,
						name: tool.function?.name ?? "",
					};
					if (tool.id) {
						current.id = tool.id;
					}
					if (tool.function?.name) {
						current.name = tool.function.name;
					}
					current.arguments += tool.function?.arguments ?? "";
					toolCalls.set(index, current);
				}
			}
		}
	} finally {
		reader.releaseLock();
	}

	const message: AssistantMessage = {
		role: "assistant",
		content: content || null,
	};
	if (toolCalls.size > 0) {
		message.tool_calls = [...toolCalls.entries()]
			.sort(([a], [b]) => a - b)
			.map(([, call]) => ({
				id: call.id,
				type: "function",
				function: { arguments: call.arguments, name: call.name },
			}));
	}

	yield {
		result: { finishReason, message, usage },
		type: "done",
	};
}
