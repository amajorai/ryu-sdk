/**
 * A local fake Ryu Gateway for the framework helper tests. It listens on a
 * loopback port, speaks the OpenAI Chat Completions wire the real Gateway
 * serves at `/v1/chat/completions` (plain, streaming and tool calls), and
 * answers errors in the Gateway's own shape (`apps/gateway/src/error.rs`).
 * No network leaves the machine.
 */

/** One request the fake Gateway received. */
export interface FakeGatewayRequest {
	authorization: string | null;
	body: FakeChatBody | null;
	/** A copy of the request headers. Read one with `headers.get(name)`. */
	headers: Headers;
	method: string;
	path: string;
}

/** The parts of a Chat Completions request body the fake reads. */
export interface FakeChatBody {
	messages?: FakeChatMessage[];
	model?: string;
	stream?: boolean;
	stream_options?: { include_usage?: boolean };
	tools?: { function?: { name?: string } }[];
}

/** A Chat Completions message as the frameworks send it. */
export interface FakeChatMessage {
	content?: string | { text?: string; type?: string }[] | null;
	role?: string;
}

/** Options of {@link startFakeGateway}. */
export interface FakeGatewayOptions {
	/** The one key the Gateway accepts. Omit to accept every request. */
	key?: string;
	/** Arguments of the tool call the fake model makes. */
	toolArgs?: Record<string, unknown>;
}

/** A running fake Gateway. */
export interface FakeGateway {
	/** Base URL without `/v1`, for example `http://127.0.0.1:53124`. */
	baseUrl: string;
	requests: FakeGatewayRequest[];
	stop: () => Promise<void>;
}

/** A model id the fake Gateway has no provider for (404 `model_not_found`). */
export const FAKE_UNKNOWN_MODEL = "no-such-model";
/** A model id the fake Gateway rate limits (429 `rate_limit_exceeded`). */
export const FAKE_RATE_LIMITED_MODEL = "rate-limited-model";

const CHAT_PATH = "/v1/chat/completions";
const MODELS_PATH = "/v1/models";
const WORD_BREAK = /(?<=\s)/;

function gatewayError(status: number, type: string, message: string): Response {
	return Response.json({ error: { code: type, message, type } }, { status });
}

function textOf(message: FakeChatMessage | undefined): string {
	const content = message?.content;
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content.map((part) => part.text ?? "").join("");
	}
	return "";
}

function lastWithRole(
	messages: FakeChatMessage[],
	role: string
): FakeChatMessage | undefined {
	return messages.findLast((message) => message.role === role);
}

interface Plan {
	text: string | null;
	tool: { arguments: string; name: string } | null;
}

function planReply(body: FakeChatBody, options: FakeGatewayOptions): Plan {
	const messages = body.messages ?? [];
	const toolResult = lastWithRole(messages, "tool");
	if (toolResult) {
		return { text: `tool said: ${textOf(toolResult)}`, tool: null };
	}
	const toolName = body.tools?.[0]?.function?.name;
	if (toolName) {
		return {
			text: null,
			tool: {
				arguments: JSON.stringify(options.toolArgs ?? { city: "Singapore" }),
				name: toolName,
			},
		};
	}
	return {
		text: `echo: ${textOf(lastWithRole(messages, "user"))}`,
		tool: null,
	};
}

const USAGE = { completion_tokens: 3, prompt_tokens: 5, total_tokens: 8 };

function completion(model: string, plan: Plan): Response {
	const message = plan.tool
		? {
				content: null,
				role: "assistant",
				tool_calls: [
					{ function: plan.tool, id: "call_fake_1", type: "function" },
				],
			}
		: { content: plan.text, role: "assistant" };
	return Response.json(
		{
			choices: [
				{
					finish_reason: plan.tool ? "tool_calls" : "stop",
					index: 0,
					message,
				},
			],
			created: 1,
			id: "chatcmpl-fake-1",
			model,
			object: "chat.completion",
			usage: USAGE,
		},
		{ headers: { "x-provider": "fake" } }
	);
}

function streamed(model: string, plan: Plan, includeUsage: boolean): Response {
	const chunk = (delta: unknown, finish: string | null) => ({
		choices: [{ delta, finish_reason: finish, index: 0 }],
		created: 1,
		id: "chatcmpl-fake-1",
		model,
		object: "chat.completion.chunk",
	});
	const events: unknown[] = [chunk({ content: "", role: "assistant" }, null)];
	if (plan.tool) {
		events.push(
			chunk(
				{
					tool_calls: [
						{
							function: { arguments: "", name: plan.tool.name },
							id: "call_fake_1",
							index: 0,
							type: "function",
						},
					],
				},
				null
			),
			chunk(
				{
					tool_calls: [
						{ function: { arguments: plan.tool.arguments }, index: 0 },
					],
				},
				null
			),
			chunk({}, "tool_calls")
		);
	} else {
		for (const word of (plan.text ?? "").split(WORD_BREAK)) {
			events.push(chunk({ content: word }, null));
		}
		events.push(chunk({}, "stop"));
	}
	if (includeUsage) {
		events.push({
			choices: [],
			created: 1,
			id: "chatcmpl-fake-1",
			model,
			object: "chat.completion.chunk",
			usage: USAGE,
		});
	}
	const frames = events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
	frames.push("data: [DONE]\n\n");
	return new Response(frames.join(""), {
		headers: {
			"cache-control": "no-cache",
			"content-type": "text/event-stream",
			"x-provider": "fake",
		},
	});
}

function answerChat(body: FakeChatBody, options: FakeGatewayOptions): Response {
	const model = body.model ?? "";
	if (model === FAKE_UNKNOWN_MODEL) {
		return gatewayError(
			404,
			"model_not_found",
			`No provider serves model "${model}".`
		);
	}
	if (model === FAKE_RATE_LIMITED_MODEL) {
		return gatewayError(
			429,
			"rate_limit_exceeded",
			"Rate limit exceeded. Please retry after a moment."
		);
	}
	const plan = planReply(body, options);
	return body.stream
		? streamed(model, plan, body.stream_options?.include_usage === true)
		: completion(model, plan);
}

/** Start a fake Gateway on a free loopback port. Call `stop()` when done. */
export function startFakeGateway(
	options: FakeGatewayOptions = {}
): FakeGateway {
	const requests: FakeGatewayRequest[] = [];
	const server = Bun.serve({
		fetch: async (request) => {
			const path = new URL(request.url).pathname;
			const authorization = request.headers.get("authorization");
			const body =
				request.method === "POST"
					? ((await request.json().catch(() => null)) as FakeChatBody | null)
					: null;
			requests.push({
				authorization,
				body,
				headers: new Headers(request.headers),
				method: request.method,
				path,
			});
			if (options.key && authorization !== `Bearer ${options.key}`) {
				return gatewayError(401, "invalid_api_key", "Invalid API key.");
			}
			if (request.method === "GET" && path === MODELS_PATH) {
				return Response.json({
					data: [{ id: "gpt-4o", object: "model", owned_by: "fake" }],
					object: "list",
				});
			}
			if (request.method === "POST" && path === CHAT_PATH && body) {
				return answerChat(body, options);
			}
			return gatewayError(404, "not_found", `No route for ${path}.`);
		},
		hostname: "127.0.0.1",
		port: 0,
	});
	return {
		baseUrl: `http://127.0.0.1:${server.port}`,
		requests,
		stop: () => server.stop(true),
	};
}
