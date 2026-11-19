/**
 * Unit tests for in-process agent middleware.
 *
 * Same transport stub as loop.test.ts: `globalThis.fetch` answers gateway
 * completions from a queue and records every request body, so each test can
 * assert both what the loop emitted and what actually reached the gateway.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	type PrimitiveJsonValue,
	primitiveJsonObjectSchema,
} from "../runnable/primitive-contracts.ts";
import { defineTool } from "../runnable/tool.ts";
import { Agent } from "./agent.ts";
import type { AgentEvent } from "./loop.ts";
import type { AgentMiddleware } from "./middleware.ts";
import type { ModelRequestBody, ToolCall } from "./model-call.ts";
import { modelBodyFixtureSchema } from "./transport-fixtures.ts";

const NODE = "http://127.0.0.1:7981";

let modelQueue: unknown[] = [];
let gatewayBodies: ModelRequestBody[] = [];
let originalFetch: typeof globalThis.fetch;

function modelResponse(opts: { content?: string; toolCalls?: ToolCall[] }) {
	const toolCalls = opts.toolCalls ?? [];
	return {
		choices: [
			{
				finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
				message: {
					content: opts.content ?? null,
					tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
				},
			},
		],
	};
}

function toolCall(
	id: string,
	name: string,
	args: PrimitiveJsonValue
): ToolCall {
	return {
		id,
		type: "function",
		function: { name, arguments: JSON.stringify(args) },
	};
}

beforeEach(() => {
	originalFetch = globalThis.fetch;
	modelQueue = [];
	gatewayBodies = [];
	globalThis.fetch = Object.assign(
		(
			input: Parameters<typeof globalThis.fetch>[0],
			init?: Parameters<typeof globalThis.fetch>[1]
		) => {
			const url = String(input);
			if (!url.includes("/v1/chat/completions")) {
				return Promise.resolve(new Response("not found", { status: 404 }));
			}
			gatewayBodies.push(
				modelBodyFixtureSchema.parse(JSON.parse(String(init?.body ?? "{}")))
			);
			const next = modelQueue.shift() ?? modelResponse({ content: "done" });
			return Promise.resolve(
				new Response(JSON.stringify(next), { status: 200 })
			);
		},
		{ preconnect: originalFetch.preconnect }
	);
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of gen) {
		events.push(event);
	}
	return events;
}

function resultText(events: AgentEvent[]): string | undefined {
	const result = events.find((event) => event.type === "result");
	return result?.type === "result" ? result.text : undefined;
}

function agentWith(middleware: AgentMiddleware[], extra = {}) {
	return new Agent({
		name: "middleware",
		model: "gpt-4o",
		node: { baseUrl: NODE },
		middleware,
		...extra,
	});
}

function echoTool(onRun: (text: string) => void) {
	return defineTool<{ text: string }, { echoed: string; secret: string }>({
		id: "echo",
		name: "Echo the input",
		schema: {
			type: "object",
			properties: { text: { type: "string" } },
			required: ["text"],
		},
		run: (input) => {
			onRun(input.text);
			return Promise.resolve({ echoed: input.text, secret: "redact-me" });
		},
	});
}

describe("agent middleware", () => {
	it("composes wrapModelCall onion-style and rewrites the outbound request", async () => {
		const order: string[] = [];
		const outer: AgentMiddleware = {
			wrapModelCall: async (request, next) => {
				order.push("outer:before");
				const result = await next({
					...request,
					messages: [
						{ role: "system", content: "Answer tersely." },
						...request.messages,
					],
				});
				order.push("outer:after");
				return result;
			},
		};
		const inner: AgentMiddleware = {
			wrapModelCall: async (request, next) => {
				order.push("inner:before");
				const result = await next({ ...request, model: "small-model" });
				order.push("inner:after");
				return result;
			},
		};

		const events = await collect(agentWith([outer, inner]).stream("hi"));

		expect(order).toEqual([
			"outer:before",
			"inner:before",
			"inner:after",
			"outer:after",
		]);
		expect(gatewayBodies[0]?.model).toBe("small-model");
		expect(gatewayBodies[0]?.messages).toEqual([
			{ role: "system", content: "Answer tersely." },
			{ role: "user", content: "hi" },
		]);
		expect(resultText(events)).toBe("done");
	});

	it("answers a turn without calling the gateway when wrapModelCall short-circuits", async () => {
		const cached: AgentMiddleware = {
			wrapModelCall: () =>
				Promise.resolve({
					finishReason: "stop",
					message: { role: "assistant", content: "from cache" },
				}),
		};

		const events = await collect(agentWith([cached]).stream("hi"));

		expect(gatewayBodies).toHaveLength(0);
		expect(events.filter((event) => event.type === "text")).toEqual([
			{ type: "text", content: "from cache" },
		]);
		expect(resultText(events)).toBe("from cache");
	});

	it("blocks a tool call and returns the reason to the model", async () => {
		let ran = false;
		modelQueue = [
			modelResponse({ toolCalls: [toolCall("c1", "echo", { text: "x" })] }),
			modelResponse({ content: "understood" }),
		];
		const firewall: AgentMiddleware = {
			wrapToolCall: (request, next) =>
				request.name === "echo"
					? Promise.resolve({ output: { error: "echo is blocked" } })
					: next(request),
		};

		const events = await collect(
			agentWith([firewall], {
				tools: {
					echo: echoTool(() => {
						ran = true;
					}),
				},
			}).stream("go")
		);

		expect(ran).toBe(false);
		expect(events.find((event) => event.type === "tool_result")).toEqual({
			type: "tool_result",
			id: "c1",
			name: "echo",
			output: { error: "echo is blocked" },
		});
		const toolRow = gatewayBodies[1]?.messages.find(
			(message) => message.role === "tool"
		);
		expect(toolRow?.content).toBe('{"error":"echo is blocked"}');
		expect(resultText(events)).toBe("understood");
	});

	it("rewrites tool input and redacts the output before the model sees it", async () => {
		let received: unknown;
		modelQueue = [
			modelResponse({ toolCalls: [toolCall("c1", "echo", { text: "raw" })] }),
			modelResponse({ content: "ok" }),
		];
		const redact: AgentMiddleware = {
			wrapToolCall: async (request, next) => {
				const { output } = await next({
					...request,
					input: { text: "normalized" },
				});
				const { secret: _secret, ...rest } =
					primitiveJsonObjectSchema.parse(output);
				return { output: rest };
			},
		};

		const events = await collect(
			agentWith([redact], {
				tools: {
					echo: echoTool((text) => {
						received = text;
					}),
				},
			}).stream("go")
		);

		expect(received).toBe("normalized");
		const serialized = JSON.stringify(gatewayBodies[1]?.messages);
		expect(serialized).not.toContain("redact-me");
		expect(events.find((event) => event.type === "tool_result")).toEqual({
			type: "tool_result",
			id: "c1",
			name: "echo",
			output: { echoed: "normalized" },
		});
	});

	it("continues with a follow-up user turn from afterTurn, bounded by maxSteps", async () => {
		modelQueue = [
			modelResponse({ content: "draft" }),
			modelResponse({ content: "final" }),
		];
		let calls = 0;
		const goal: AgentMiddleware = {
			afterTurn: (turn) => {
				calls += 1;
				return turn.text === "draft" ? { continue: "Keep going." } : undefined;
			},
		};

		const events = await collect(agentWith([goal]).stream("start"));

		expect(calls).toBe(2);
		expect(gatewayBodies).toHaveLength(2);
		const second = gatewayBodies[1]?.messages;
		expect(second?.at(-1)).toEqual({ role: "user", content: "Keep going." });
		expect(resultText(events)).toBe("final");

		modelQueue = [modelResponse({ content: "loop" })];
		gatewayBodies = [];
		const endless: AgentMiddleware = {
			afterTurn: () => ({ continue: "again" }),
		};
		const bounded = await collect(
			agentWith([endless], { maxSteps: 3 }).stream("start")
		);
		expect(gatewayBodies).toHaveLength(3);
		const result = bounded.find((event) => event.type === "result");
		expect(result?.type === "result" && result.steps).toBe(3);
	});

	it("reports a middleware failure as a terminal error", async () => {
		const broken: AgentMiddleware = {
			wrapModelCall: () => Promise.reject(new Error("policy unavailable")),
		};

		const events = await collect(agentWith([broken]).stream("hi"));

		expect(events).toEqual([{ type: "error", message: "policy unavailable" }]);
	});

	it("refuses middleware on a Core-owned session run", async () => {
		const events = await collect(
			agentWith([{ afterTurn: () => undefined }], {
				sessionId: "session-1",
			}).stream("hi")
		);

		expect(events).toHaveLength(1);
		expect(events[0]?.type).toBe("error");
		expect(gatewayBodies).toHaveLength(0);
	});
});
