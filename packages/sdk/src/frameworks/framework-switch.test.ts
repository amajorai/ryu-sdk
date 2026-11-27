/**
 * Wire tests for the framework helpers against a local fake Gateway.
 *
 * Mastra and LangChain are not dependencies of this package, so these tests
 * do not run the frameworks. They send what the frameworks' stock OpenAI
 * compatible clients send, built from nothing but the helper's output: a POST
 * to `<base URL>/chat/completions` with `Authorization: Bearer <key>`, the
 * model id and the extra headers. That pins the part this package owns: the
 * URL joins to the Gateway's route, the key reaches the Gateway, the model id
 * arrives as the Gateway expects it, and the Gateway's answers (plain,
 * streamed, tool call, error, wrong key) come back intact. No network leaves
 * the machine.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RYU_NO_KEY } from "./gateway-target.ts";
import { ryuChatOpenAI } from "./langchain.ts";
import { ryuModel } from "./mastra.ts";
import {
	FAKE_RATE_LIMITED_MODEL,
	FAKE_UNKNOWN_MODEL,
	type FakeGateway,
	startFakeGateway,
} from "./test-support.ts";

const KEY = "test-gateway-key";

/** What a stock OpenAI compatible client needs to place a call. */
interface WireTarget {
	apiKey: string;
	baseUrl: string;
	headers?: Record<string, string>;
	model: string;
}

interface HelperOptions {
	apiKey?: string;
	baseUrl: string;
	headers?: Record<string, string>;
}

/** Mastra sends the part of `id` after the first slash as the model. */
function viaMastra(model: string, options: HelperOptions): WireTarget {
	const config = ryuModel(model, options);
	return {
		apiKey: config.apiKey,
		baseUrl: config.url,
		headers: config.headers,
		model: config.id.slice(config.id.indexOf("/") + 1),
	};
}

/** `ChatOpenAI` hands `configuration` to the OpenAI client as it is. */
function viaLangChain(model: string, options: HelperOptions): WireTarget {
	const fields = ryuChatOpenAI(model, options);
	return {
		apiKey: fields.apiKey,
		baseUrl: fields.configuration.baseURL,
		headers: fields.configuration.defaultHeaders,
		model: fields.model,
	};
}

function chat(
	target: WireTarget,
	body: Record<string, unknown>
): Promise<Response> {
	return fetch(`${target.baseUrl}/chat/completions`, {
		body: JSON.stringify({ model: target.model, ...body }),
		headers: {
			...target.headers,
			authorization: `Bearer ${target.apiKey}`,
			"content-type": "application/json",
		},
		method: "POST",
	});
}

interface Completion {
	choices: {
		finish_reason: string | null;
		message: {
			content: string | null;
			tool_calls?: {
				function: { arguments: string; name: string };
				id: string;
			}[];
		};
	}[];
	model: string;
}

interface StreamChunk {
	choices: {
		delta: { content?: string };
		finish_reason: string | null;
	}[];
}

interface GatewayErrorBody {
	error: { code: string; message: string; type: string };
}

const WEATHER_TOOL = {
	function: {
		description: "Current weather for a city.",
		name: "get_weather",
		parameters: {
			properties: { city: { type: "string" } },
			required: ["city"],
			type: "object",
		},
	},
	type: "function",
};

const HELPERS = [
	["ryuModel (Mastra)", viaMastra],
	["ryuChatOpenAI (LangChain)", viaLangChain],
] as const;

let gateway: FakeGateway;

beforeAll(() => {
	gateway = startFakeGateway({ key: KEY });
});

afterAll(async () => {
	await gateway.stop();
});

describe.each(HELPERS)("%s against a fake Gateway", (_name, via) => {
	test("plain chat reaches /v1/chat/completions with the key and the model", async () => {
		const seen = gateway.requests.length;
		const target = via("gpt-4o", {
			apiKey: KEY,
			baseUrl: gateway.baseUrl,
			headers: { "x-trace-id": "trace-1" },
		});
		const response = await chat(target, {
			messages: [{ content: "hello", role: "user" }],
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as Completion;
		expect(body.choices[0]?.message.content).toBe("echo: hello");
		expect(body.choices[0]?.finish_reason).toBe("stop");

		const request = gateway.requests[seen];
		expect(gateway.requests.length).toBe(seen + 1);
		expect(request?.path).toBe("/v1/chat/completions");
		expect(request?.authorization).toBe(`Bearer ${KEY}`);
		expect(request?.body?.model).toBe("gpt-4o");
		expect(request?.headers.get("x-trace-id")).toBe("trace-1");
	});

	test("a base URL that already ends in /v1 does not double the segment", async () => {
		const seen = gateway.requests.length;
		const target = via("gpt-4o", {
			apiKey: KEY,
			baseUrl: `${gateway.baseUrl}/v1/`,
		});
		const response = await chat(target, {
			messages: [{ content: "hi", role: "user" }],
		});
		expect(response.status).toBe(200);
		expect(gateway.requests[seen]?.path).toBe("/v1/chat/completions");
	});

	test("a model id with a slash arrives whole", async () => {
		const seen = gateway.requests.length;
		const target = via("anthropic/claude-sonnet-4", {
			apiKey: KEY,
			baseUrl: gateway.baseUrl,
		});
		await chat(target, { messages: [{ content: "hi", role: "user" }] });
		expect(gateway.requests[seen]?.body?.model).toBe(
			"anthropic/claude-sonnet-4"
		);
	});

	test("streaming delivers the deltas and the [DONE] frame", async () => {
		const target = via("gpt-4o", { apiKey: KEY, baseUrl: gateway.baseUrl });
		const response = await chat(target, {
			messages: [{ content: "hello there friend", role: "user" }],
			stream: true,
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const frames = (await response.text())
			.split("\n\n")
			.filter((frame) => frame.startsWith("data: "))
			.map((frame) => frame.slice("data: ".length));
		expect(frames.at(-1)).toBe("[DONE]");
		const chunks = frames
			.slice(0, -1)
			.map((frame) => JSON.parse(frame) as StreamChunk);
		expect(chunks.length).toBeGreaterThan(3);
		const text = chunks
			.map((chunk) => chunk.choices[0]?.delta.content ?? "")
			.join("");
		expect(text).toBe("echo: hello there friend");
		expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop");
	});

	test("a tool call round trip: the call comes back, the result goes in", async () => {
		const target = via("gpt-4o", { apiKey: KEY, baseUrl: gateway.baseUrl });
		const question = { content: "Weather in Singapore?", role: "user" };
		const first = await chat(target, {
			messages: [question],
			tools: [WEATHER_TOOL],
		});
		const firstBody = (await first.json()) as Completion;
		const call = firstBody.choices[0]?.message.tool_calls?.[0];
		expect(firstBody.choices[0]?.finish_reason).toBe("tool_calls");
		expect(call?.function.name).toBe("get_weather");
		expect(JSON.parse(call?.function.arguments ?? "{}")).toEqual({
			city: "Singapore",
		});

		const second = await chat(target, {
			messages: [
				question,
				{ content: null, role: "assistant", tool_calls: [call] },
				{ content: "31C and humid", role: "tool", tool_call_id: call?.id },
			],
			tools: [WEATHER_TOOL],
		});
		const secondBody = (await second.json()) as Completion;
		expect(secondBody.choices[0]?.message.content).toBe(
			"tool said: 31C and humid"
		);
		expect(secondBody.choices[0]?.finish_reason).toBe("stop");
	});

	test("a Gateway error keeps its status, type and message", async () => {
		const unknown = await chat(
			via(FAKE_UNKNOWN_MODEL, { apiKey: KEY, baseUrl: gateway.baseUrl }),
			{ messages: [{ content: "hi", role: "user" }] }
		);
		expect(unknown.status).toBe(404);
		const unknownBody = (await unknown.json()) as GatewayErrorBody;
		expect(unknownBody.error.type).toBe("model_not_found");
		expect(unknownBody.error.message).toContain(FAKE_UNKNOWN_MODEL);

		const limited = await chat(
			via(FAKE_RATE_LIMITED_MODEL, { apiKey: KEY, baseUrl: gateway.baseUrl }),
			{ messages: [{ content: "hi", role: "user" }] }
		);
		expect(limited.status).toBe(429);
		const limitedBody = (await limited.json()) as GatewayErrorBody;
		expect(limitedBody.error.type).toBe("rate_limit_exceeded");
	});

	test("a wrong key is refused with 401 invalid_api_key", async () => {
		const response = await chat(
			via("gpt-4o", { apiKey: "wrong-key", baseUrl: gateway.baseUrl }),
			{ messages: [{ content: "hi", role: "user" }] }
		);
		expect(response.status).toBe(401);
		const body = (await response.json()) as GatewayErrorBody;
		expect(body.error.type).toBe("invalid_api_key");
		expect(body.error.code).toBe("invalid_api_key");
	});

	test("no key sends the placeholder, which a keyed Gateway refuses", async () => {
		const savedToken = process.env.RYU_GATEWAY_TOKEN;
		delete process.env.RYU_GATEWAY_TOKEN;
		try {
			const seen = gateway.requests.length;
			const response = await chat(via("gpt-4o", { baseUrl: gateway.baseUrl }), {
				messages: [{ content: "hi", role: "user" }],
			});
			expect(response.status).toBe(401);
			expect(gateway.requests[seen]?.authorization).toBe(
				`Bearer ${RYU_NO_KEY}`
			);
		} finally {
			if (savedToken !== undefined) {
				process.env.RYU_GATEWAY_TOKEN = savedToken;
			}
		}
	});
});

describe("a Gateway that needs no key (require_auth = false)", () => {
	test("accepts the placeholder key from both helpers", async () => {
		const open = startFakeGateway();
		const savedToken = process.env.RYU_GATEWAY_TOKEN;
		delete process.env.RYU_GATEWAY_TOKEN;
		try {
			for (const [, via] of HELPERS) {
				const response = await chat(via("gpt-4o", { baseUrl: open.baseUrl }), {
					messages: [{ content: "hi", role: "user" }],
				});
				expect(response.status).toBe(200);
			}
			expect(open.requests.map((request) => request.authorization)).toEqual([
				`Bearer ${RYU_NO_KEY}`,
				`Bearer ${RYU_NO_KEY}`,
			]);
		} finally {
			if (savedToken !== undefined) {
				process.env.RYU_GATEWAY_TOKEN = savedToken;
			}
			await open.stop();
		}
	});
});
