/**
 * A2A client tests over an in-memory transport: the injected `fetch` routes
 * requests to handlers and records them, so every wire detail (paths, headers,
 * JSON-RPC envelopes, SSE framing, redirects) is asserted without a network.
 * Live round-trips against third-party A2A servers are not exercised here.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import { Agent } from "../agent/agent.ts";
import type { PrimitiveJsonValue } from "../runnable/primitive-contracts.ts";
import {
	fixtureSigningKey,
	sampleCard,
	signCard,
} from "./card-signing.fixtures.ts";
import { A2AClient, discoverAgentCard } from "./client.ts";
import { A2AEndpointError } from "./endpoint.ts";
import { A2AError } from "./errors.ts";
import { runA2ATask } from "./tool.ts";
import type { A2AStreamResponse } from "./types.ts";

const ORIGIN = "https://agent.example.com";
const RPC_URL = `${ORIGIN}/a2a`;
const JKU = `${ORIGIN}/a2a-card/jwks.json`;

interface Recorded {
	body?: string;
	headers: Headers;
	method: string;
	redirect?: RequestRedirect;
	signal?: AbortSignal;
	url: string;
}

type Handler = (request: Recorded) => Response | Promise<Response>;

let routes: Map<string, Handler[]>;
let recorded: Recorded[];

function route(method: string, url: string, ...handlers: Handler[]) {
	routes.set(`${method} ${url}`, [
		...(routes.get(`${method} ${url}`) ?? []),
		...handlers,
	]);
}

const fakeFetch: typeof globalThis.fetch = Object.assign(
	async (
		input: Parameters<typeof globalThis.fetch>[0],
		init?: Parameters<typeof globalThis.fetch>[1]
	) => {
		const request: Recorded = {
			url: String(input),
			method: init?.method ?? "GET",
			headers: new Headers(init?.headers),
			body: init?.body === undefined ? undefined : String(init.body),
		};
		recorded.push(request);
		request.redirect = init?.redirect;
		request.signal = init?.signal ?? undefined;
		const queue = routes.get(`${request.method} ${request.url}`);
		const handler = queue && queue.length > 1 ? queue.shift() : queue?.[0];
		if (!handler) {
			return new Response(`no route for ${request.method} ${request.url}`, {
				status: 404,
			});
		}
		return await handler(request);
	},
	{ preconnect: globalThis.fetch.preconnect }
);

function json(value: PrimitiveJsonValue, status = 200, headers = {}) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/a2a+json", ...headers },
	});
}

const rpcRequestSchema = z.object({
	jsonrpc: z.literal("2.0"),
	id: z.string(),
	method: z.string(),
	params: z.record(z.string(), z.json()),
});

function rpcBody(request: Recorded) {
	return rpcRequestSchema.parse(JSON.parse(request.body ?? "{}"));
}

/** Answer a JSON-RPC call with `result`, echoing the request id. */
function rpcResult(result: PrimitiveJsonValue): Handler {
	return (request) => json({ jsonrpc: "2.0", id: rpcBody(request).id, result });
}

function sse(chunks: string[], contentType = "text/event-stream") {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const chunk of chunks) {
					controller.enqueue(encoder.encode(chunk));
				}
				controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": contentType } }
	);
}

/**
 * An SSE response that sends `chunks` and then stays open, as a peer that never
 * ends the stream would; it errors only when the request is aborted.
 */
function openSse(request: Recorded, chunks: string[]) {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const chunk of chunks) {
					controller.enqueue(encoder.encode(chunk));
				}
				request.signal?.addEventListener(
					"abort",
					() => controller.error(request.signal?.reason),
					{ once: true }
				);
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } }
	);
}

function task(state: string, extra: Record<string, PrimitiveJsonValue> = {}) {
	return { id: "t1", contextId: "ctx1", status: { state }, ...extra };
}

function card(
	binding = "JSONRPC",
	url = RPC_URL,
	extra: Record<string, PrimitiveJsonValue> = {}
) {
	return {
		...sampleCard(url),
		supportedInterfaces: [
			{ url, protocolBinding: binding, protocolVersion: "1.0" },
		],
		...extra,
	};
}

function client(
	binding: "HTTP+JSON" | "JSONRPC" = "JSONRPC",
	options: ConstructorParameters<typeof A2AClient>[1] = {}
) {
	return new A2AClient(
		{ url: new URL(RPC_URL), binding },
		{ fetch: fakeFetch, ...options }
	);
}

async function failure(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Error) {
			return error;
		}
	}
	throw new Error("expected a rejection");
}

beforeEach(() => {
	routes = new Map();
	recorded = [];
});

describe("discoverAgentCard", () => {
	it("resolves the well-known path and verifies a same-origin signed card", async () => {
		const signer = await fixtureSigningKey(0x41);
		route("GET", `${ORIGIN}/.well-known/agent-card.json`, async () =>
			json(await signCard(card(), signer, JKU))
		);
		route("GET", JKU, () => json(signer.jwks));

		const discovered = await discoverAgentCard(`${ORIGIN}/ignored?x=1`, {
			fetch: fakeFetch,
			requireVerifiedSignature: true,
		});
		expect(discovered.signature).toEqual({
			status: "verified",
			kid: signer.kid,
			jku: JKU,
		});
		expect(discovered.card.name).toBe("Ryu");
		// Redirects are never followed by fetch itself; the client vets each hop.
		expect(recorded.every((request) => request.redirect === "manual")).toBe(
			true
		);
		const [cardRequest, jwksRequest] = recorded;
		expect(cardRequest?.headers.get("A2A-Version")).toBe("1.0");
		expect(cardRequest?.headers.get("accept")).toBe("application/a2a+json");
		expect(jwksRequest?.headers.get("accept")).toBe(
			"application/jwk-set+json, application/json"
		);
	});

	it("does not trust a key set from another origin", async () => {
		const signer = await fixtureSigningKey(0x41);
		const foreignJku = "https://keys.example.net/jwks.json";
		route("GET", `${ORIGIN}/card.json`, async () =>
			json(await signCard(card(), signer, foreignJku))
		);
		route("GET", foreignJku, () => json(signer.jwks));

		const discovered = await discoverAgentCard(`${ORIGIN}/card.json`, {
			fetch: fakeFetch,
		});
		expect(discovered.signature).toEqual({
			status: "unverifiable",
			reason: "signature jku is not on the Agent Card's origin",
		});
		expect(recorded.map((request) => request.url)).toEqual([
			`${ORIGIN}/card.json`,
		]);
		const error = await failure(
			discoverAgentCard(`${ORIGIN}/card.json`, {
				fetch: fakeFetch,
				requireVerifiedSignature: true,
			})
		);
		expect(error).toBeInstanceOf(A2AError);
		expect(error.message).toContain(
			"a verified Agent Card signature is required"
		);
	});

	it("rejects a card whose signature does not match", async () => {
		const signer = await fixtureSigningKey(0x41);
		route("GET", `${ORIGIN}/card.json`, async () =>
			json({ ...(await signCard(card(), signer, JKU)), name: "Impostor" })
		);
		route("GET", JKU, () => json(signer.jwks));
		const error = await failure(
			discoverAgentCard(`${ORIGIN}/card.json`, { fetch: fakeFetch })
		);
		expect(error.message).toContain(
			"signature verification failed: signature does not match the card"
		);
	});

	it("accepts unsigned cards and follows same-origin redirects only", async () => {
		route(
			"GET",
			`${ORIGIN}/old.json`,
			() =>
				new Response(null, { status: 302, headers: { location: "/card.json" } })
		);
		route("GET", `${ORIGIN}/card.json`, () => json(card()));
		const discovered = await discoverAgentCard(`${ORIGIN}/old.json`, {
			fetch: fakeFetch,
		});
		expect(discovered.signature).toEqual({ status: "unsigned" });

		route("GET", `${ORIGIN}/moved.json`, () =>
			Response.redirect("https://evil.example.net/card.json", 301)
		);
		const error = await failure(
			discoverAgentCard(`${ORIGIN}/moved.json`, { fetch: fakeFetch })
		);
		expect(error).toBeInstanceOf(A2AError);
		expect(error instanceof A2AError && error.code).toBe(
			"cross_origin_redirect"
		);
	});

	it("fetches the key set without following redirects, like Core", async () => {
		const signer = await fixtureSigningKey(0x41);
		route("GET", `${ORIGIN}/card.json`, async () =>
			json(await signCard(card(), signer, JKU))
		);
		route(
			"GET",
			JKU,
			() =>
				new Response(null, {
					status: 302,
					headers: { location: "/keys.json" },
				})
		);
		route("GET", `${ORIGIN}/keys.json`, () => json(signer.jwks));
		const discovered = await discoverAgentCard(`${ORIGIN}/card.json`, {
			fetch: fakeFetch,
		});
		expect(discovered.signature).toEqual({
			status: "unverifiable",
			reason: "signature key set could not be fetched",
		});
		expect(recorded.map((request) => request.url)).toEqual([
			`${ORIGIN}/card.json`,
			JKU,
		]);
	});

	it("refuses a redirect whose target fetch hides", async () => {
		route("GET", `${ORIGIN}/card.json`, () => {
			// A real opaque redirect has status 0 and no body; a card body here
			// proves the response is refused for its type alone.
			const response = json(card());
			Object.defineProperty(response, "type", { value: "opaqueredirect" });
			return response;
		});
		const error = await failure(
			discoverAgentCard(`${ORIGIN}/card.json`, { fetch: fakeFetch })
		);
		expect(error instanceof A2AError && error.code).toBe("invalid_protocol");
	});

	it("rejects cards that point at private endpoints or are oversized", async () => {
		route("GET", `${ORIGIN}/private.json`, () =>
			json(card("JSONRPC", "https://10.0.0.5/a2a"))
		);
		expect(
			await failure(
				discoverAgentCard(`${ORIGIN}/private.json`, { fetch: fakeFetch })
			)
		).toBeInstanceOf(A2AEndpointError);

		route("GET", `${ORIGIN}/huge.json`, () =>
			json(card(), 200, { "content-length": String(600 * 1024) })
		);
		const error = await failure(
			discoverAgentCard(`${ORIGIN}/huge.json`, { fetch: fakeFetch })
		);
		expect(error instanceof A2AError && error.code).toBe("response_too_large");
	});

	it("refuses plain HTTP unless loopback development is enabled", async () => {
		expect(
			await failure(
				discoverAgentCard("http://agent.example.com", { fetch: fakeFetch })
			)
		).toBeInstanceOf(A2AEndpointError);
		route("GET", "http://127.0.0.1:7980/.well-known/agent-card.json", () =>
			json(card("JSONRPC", "http://127.0.0.1:7980/a2a"))
		);
		const local = await A2AClient.connect("http://127.0.0.1:7980", {
			fetch: fakeFetch,
			policy: { allowLoopbackHttp: true },
		});
		expect(local.endpoint.url.href).toBe("http://127.0.0.1:7980/a2a");
	});
});

describe("A2AClient JSON-RPC binding", () => {
	it("connects to the preferred interface and sends a message", async () => {
		route("GET", `${ORIGIN}/.well-known/agent-card.json`, () =>
			json({
				...card(),
				supportedInterfaces: [
					{
						url: `${ORIGIN}/rest`,
						protocolBinding: "HTTP+JSON",
						protocolVersion: "1.0",
					},
					{
						url: RPC_URL,
						protocolBinding: "JSONRPC",
						protocolVersion: "1.0",
						tenant: "acme",
					},
				],
			})
		);
		route("POST", RPC_URL, rpcResult({ task: task("TASK_STATE_SUBMITTED") }));

		const peer = await A2AClient.connect(ORIGIN, {
			fetch: fakeFetch,
			credential: { kind: "bearer", token: "secret-token" },
			extensions: ["https://example.com/ext/v1"],
		});
		expect(peer.endpoint.binding).toBe("JSONRPC");
		const response = await peer.sendMessage("hello");
		expect(response).toMatchObject({
			kind: "task",
			task: { id: "t1", status: { state: "TASK_STATE_SUBMITTED" } },
		});

		const sent = recorded.at(-1);
		expect(sent?.headers.get("authorization")).toBe("Bearer secret-token");
		expect(sent?.headers.get("content-type")).toBe("application/a2a+json");
		expect(sent?.headers.get("A2A-Extensions")).toBe(
			"https://example.com/ext/v1"
		);
		const body = rpcBody(sent ?? never());
		expect(body.method).toBe("SendMessage");
		expect(body.params).toMatchObject({
			tenant: "acme",
			message: { role: "ROLE_USER", parts: [{ text: "hello" }] },
		});
	});

	it("rejects mismatched ids and surfaces JSON-RPC errors", async () => {
		route("POST", RPC_URL, () =>
			json({
				jsonrpc: "2.0",
				id: "other",
				result: { task: task("TASK_STATE_WORKING") },
			})
		);
		const mismatch = await failure(client().getTask("t1"));
		expect(mismatch instanceof A2AError && mismatch.code).toBe(
			"invalid_protocol"
		);

		routes.clear();
		route("POST", RPC_URL, (request) =>
			json({
				jsonrpc: "2.0",
				id: rpcBody(request).id,
				error: { code: -32_001, message: "Task not found" },
			})
		);
		const error = await failure(
			client().getTask("missing", { historyLength: 3 })
		);
		expect(error instanceof A2AError && error.rpcCode).toBe(-32_001);
		expect(error.message).toContain("Task not found");
		expect(rpcBody(recorded.at(-1) ?? never()).params).toEqual({
			id: "missing",
			historyLength: 3,
		});
	});

	it("reports HTTP failures with the peer's detail", async () => {
		route("POST", RPC_URL, () => new Response("overloaded", { status: 503 }));
		const error = await failure(client().cancelTask("t1"));
		expect(error instanceof A2AError && error.status).toBe(503);
		expect(error.message).toContain("overloaded");
	});

	it("streams SSE events split across chunks", async () => {
		const envelope = (result: PrimitiveJsonValue) =>
			JSON.stringify({ jsonrpc: "2.0", id: "s", result });
		const first = envelope({ task: task("TASK_STATE_WORKING") });
		const second = envelope({
			artifactUpdate: {
				taskId: "t1",
				contextId: "ctx1",
				artifact: { artifactId: "a1", parts: [{ text: "Hel" }] },
			},
		});
		const third = envelope({
			statusUpdate: {
				taskId: "t1",
				contextId: "ctx1",
				status: { state: "TASK_STATE_COMPLETED" },
			},
		});
		route("POST", RPC_URL, (request) => {
			expect(request.headers.get("accept")).toBe("text/event-stream");
			expect(rpcBody(request).method).toBe("SendStreamingMessage");
			return sse([
				": keep-alive\r\n",
				`data: ${first.slice(0, 10)}`,
				`${first.slice(10)}\r\n\r\n`,
				`event: update\ndata: ${second}\n\n`,
				`data: ${third}`,
			]);
		});

		const events: A2AStreamResponse[] = [];
		for await (const event of client().sendStreamingMessage("go")) {
			events.push(event);
		}
		expect(events.map((event) => event.kind)).toEqual([
			"task",
			"artifact_update",
			"status_update",
		]);
	});

	it("rejects a stream with the wrong content type or an error event", async () => {
		route("POST", RPC_URL, () => sse(["data: {}\n\n"], "application/json"));
		const wrongType = await failure(client().sendStreamingMessage("go").next());
		expect(wrongType instanceof A2AError && wrongType.code).toBe(
			"invalid_content_type"
		);

		routes.clear();
		route("POST", RPC_URL, () =>
			sse([
				`data: ${JSON.stringify({ jsonrpc: "2.0", id: "s", error: { code: -32_603, message: "boom" } })}\n\n`,
			])
		);
		const rpcError = await failure(client().subscribeToTask("t1").next());
		expect(rpcError instanceof A2AError && rpcError.code).toBe("json_rpc");
	});

	it("bounds SSE event size", async () => {
		route("POST", RPC_URL, () => sse([`data: ${"x".repeat(64)}\n\n`]));
		const peer = client("JSONRPC", { limits: { maxSseEventBytes: 16 } });
		const error = await failure(peer.sendStreamingMessage("go").next());
		expect(error instanceof A2AError && error.code).toBe("event_too_large");
	});
});

describe("A2AClient HTTP+JSON binding", () => {
	it("maps operations onto the REST paths Core serves", async () => {
		route("POST", `${RPC_URL}/message:send`, () =>
			json({
				message: {
					messageId: "m1",
					role: "ROLE_AGENT",
					parts: [{ text: "hi" }],
				},
			})
		);
		route("GET", `${RPC_URL}/tasks/t%201?historyLength=2`, () =>
			json(task("TASK_STATE_WORKING"))
		);
		route("POST", `${RPC_URL}/tasks/t1:cancel`, () =>
			json(task("TASK_STATE_CANCELED"))
		);
		route(
			"GET",
			`${RPC_URL}/tasks?contextId=ctx1&status=TASK_STATE_WORKING&pageSize=5`,
			() =>
				json({
					tasks: [task("TASK_STATE_WORKING")],
					nextPageToken: "",
					pageSize: 5,
					totalSize: 1,
				})
		);
		route(
			"DELETE",
			`${RPC_URL}/tasks/t1/pushNotificationConfigs/p1`,
			() => new Response(null, { status: 204 })
		);
		const peer = client("HTTP+JSON");

		expect(await peer.sendMessage("hi")).toMatchObject({
			kind: "message",
			message: { messageId: "m1" },
		});
		expect(JSON.parse(recorded.at(-1)?.body ?? "{}")).toMatchObject({
			message: { role: "ROLE_USER", parts: [{ text: "hi" }] },
		});
		expect((await peer.getTask("t 1", { historyLength: 2 })).id).toBe("t1");
		expect((await peer.cancelTask("t1")).status.state).toBe(
			"TASK_STATE_CANCELED"
		);
		expect(recorded.at(-1)?.body).toBeUndefined();
		const listed = await peer.listTasks({
			contextId: "ctx1",
			status: "TASK_STATE_WORKING",
			pageSize: 5,
		});
		expect(listed.totalSize).toBe(1);
		await peer.deletePushConfig("t1", "p1");
	});

	it("refuses ids that would resolve as dot path segments", async () => {
		const peer = client("HTTP+JSON");
		for (const id of [".", ".."]) {
			const error = await failure(peer.getTask(id));
			expect(error instanceof A2AError && error.code).toBe("invalid_protocol");
		}
		expect(recorded).toEqual([]);
	});
});

describe("credentials", () => {
	it("sends basic and API-key credentials and refuses unsafe headers", async () => {
		route("POST", RPC_URL, rpcResult(task("TASK_STATE_WORKING")));
		await client("JSONRPC", {
			credential: { kind: "basic", username: "ryu", password: "pässword" },
		}).getTask("t1");
		expect(recorded.at(-1)?.headers.get("authorization")).toBe(
			`Basic ${Buffer.from("ryu:pässword").toString("base64")}`
		);

		await client("JSONRPC", {
			credential: { kind: "api_key", header: "x-api-key", value: "k1" },
		}).getTask("t1");
		expect(recorded.at(-1)?.headers.get("x-api-key")).toBe("k1");

		const error = await failure(
			client("JSONRPC", {
				credential: { kind: "api_key", header: "Host", value: "evil" },
			}).getTask("t1")
		);
		expect(error instanceof A2AError && error.code).toBe("invalid_credential");
	});

	it("exchanges OAuth2 client credentials for a bearer token", async () => {
		route("POST", "https://auth.example.com/token", (request) => {
			expect(request.body).toBe("grant_type=client_credentials&scope=a2a.send");
			expect(request.headers.get("authorization")).toBe(
				`Basic ${btoa("client:secret")}`
			);
			return json({ access_token: "issued", token_type: "Bearer" });
		});
		route("POST", RPC_URL, rpcResult(task("TASK_STATE_WORKING")));
		await client("JSONRPC", {
			credential: {
				kind: "oauth2_client_credentials",
				tokenUrl: "https://auth.example.com/token",
				clientId: "client",
				clientSecret: "secret",
				scopes: ["a2a.send"],
			},
		}).getTask("t1");
		expect(recorded.at(-1)?.headers.get("authorization")).toBe("Bearer issued");
	});
});

function never(): never {
	throw new Error("missing request");
}

describe("remote agent tool", () => {
	it("polls a non-streaming task until it completes", async () => {
		route("POST", RPC_URL, rpcResult({ task: task("TASK_STATE_WORKING") }));
		route(
			"POST",
			RPC_URL,
			rpcResult(task("TASK_STATE_WORKING")),
			rpcResult(
				task("TASK_STATE_COMPLETED", {
					artifacts: [
						{
							artifactId: "a1",
							parts: [{ text: "Paris" }, { data: { score: 1 } }],
						},
					],
				})
			)
		);
		const outcome = await runA2ATask(client(), "capital?", {
			pollIntervalMs: 1,
		});
		expect(outcome).toMatchObject({
			state: "TASK_STATE_COMPLETED",
			text: "Paris",
			data: [{ score: 1 }],
		});
		const methods = recorded.map((request) => rpcBody(request).method);
		expect(methods).toEqual(["SendMessage", "GetTask", "GetTask"]);
	});

	it("assembles streamed artifact chunks", async () => {
		const frame = (result: PrimitiveJsonValue) =>
			`data: ${JSON.stringify({ jsonrpc: "2.0", id: "s", result })}\n\n`;
		route("POST", RPC_URL, () =>
			sse([
				frame({ task: task("TASK_STATE_WORKING") }),
				frame({
					artifactUpdate: {
						taskId: "t1",
						contextId: "ctx1",
						artifact: { artifactId: "a1", parts: [{ text: "Hello" }] },
					},
				}),
				frame({
					artifactUpdate: {
						taskId: "t1",
						contextId: "ctx1",
						append: true,
						artifact: { artifactId: "a1", parts: [{ text: "world" }] },
					},
				}),
				frame({
					statusUpdate: {
						taskId: "t1",
						contextId: "ctx1",
						status: { state: "TASK_STATE_COMPLETED" },
					},
				}),
			])
		);
		const tool = client().asTool({ name: "remote", stream: true });
		const output = await tool.run(
			{ prompt: "greet" },
			{ gateway: { chat: never, stream: never } }
		);
		expect(output).toBe("Hello\nworld");
	});

	it("stops reading once the streamed task settles", async () => {
		const frame = (result: PrimitiveJsonValue) =>
			`data: ${JSON.stringify({ jsonrpc: "2.0", id: "s", result })}\n\n`;
		route("POST", RPC_URL, (request) =>
			openSse(request, [
				frame({ task: task("TASK_STATE_WORKING") }),
				frame({
					statusUpdate: {
						taskId: "t1",
						contextId: "ctx1",
						status: {
							state: "TASK_STATE_COMPLETED",
							message: {
								messageId: "m",
								role: "ROLE_AGENT",
								parts: [{ text: "done" }],
							},
						},
					},
				}),
			])
		);
		const outcome = await runA2ATask(client(), "go", { stream: true });
		expect(outcome).toMatchObject({
			state: "TASK_STATE_COMPLETED",
			text: "done",
		});
	});

	it("returns a still-running streamed task at the deadline", async () => {
		const frame = (result: PrimitiveJsonValue) =>
			`data: ${JSON.stringify({ jsonrpc: "2.0", id: "s", result })}\n\n`;
		route("POST", RPC_URL, (request) =>
			openSse(request, [frame({ task: task("TASK_STATE_WORKING") })])
		);
		const outcome = await runA2ATask(client(), "go", {
			stream: true,
			timeoutMs: 20,
		});
		expect(outcome).toMatchObject({
			state: "TASK_STATE_WORKING",
			taskId: "t1",
		});

		routes.set(`POST ${RPC_URL}`, [(request) => openSse(request, [])]);
		const error = await failure(
			runA2ATask(client(), "go", { stream: true, timeoutMs: 20 })
		);
		expect(error.message).toContain("produced no task or message");
	});

	it("turns failures into tool errors and continues input-required tasks", async () => {
		route(
			"POST",
			RPC_URL,
			rpcResult({
				task: task("TASK_STATE_INPUT_REQUIRED", {
					status: {
						state: "TASK_STATE_INPUT_REQUIRED",
						message: {
							messageId: "m",
							role: "ROLE_AGENT",
							parts: [{ text: "Which city?" }],
						},
					},
				}),
			}),
			rpcResult({
				task: task("TASK_STATE_FAILED", {
					status: {
						state: "TASK_STATE_FAILED",
						message: {
							messageId: "m2",
							role: "ROLE_AGENT",
							parts: [{ text: "no data" }],
						},
					},
				}),
			})
		);
		const tool = client().asTool({ name: "weather", stream: false });
		const ctx = { gateway: { chat: never, stream: never } };
		expect(await tool.run({ prompt: "weather?" }, ctx)).toEqual({
			state: "TASK_STATE_INPUT_REQUIRED",
			text: "Which city?",
			taskId: "t1",
			contextId: "ctx1",
		});
		await expect(tool.run({ prompt: "Paris" }, ctx)).rejects.toThrow(
			/TASK_STATE_FAILED: no data/
		);
		const followUp = rpcBody(recorded.at(-1) ?? never()).params;
		expect(followUp).toMatchObject({
			message: { contextId: "ctx1", taskId: "t1", parts: [{ text: "Paris" }] },
		});
	});
});

describe("remote agent tool inside an Agent", () => {
	const NODE = "http://127.0.0.1:7981";
	let originalFetch: typeof globalThis.fetch;
	let modelReplies: PrimitiveJsonValue[];

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		modelReplies = [];
		globalThis.fetch = Object.assign(
			() =>
				Promise.resolve(
					new Response(JSON.stringify(modelReplies.shift() ?? null), {
						status: 200,
					})
				),
			{ preconnect: originalFetch.preconnect }
		);
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("lets the model delegate to the remote agent", async () => {
		route(
			"POST",
			RPC_URL,
			rpcResult({
				message: {
					messageId: "r",
					role: "ROLE_AGENT",
					parts: [{ text: "42" }],
				},
			})
		);
		const choice = (message: Record<string, PrimitiveJsonValue>) => ({
			choices: [{ finish_reason: "stop", message }],
		});
		modelReplies = [
			choice({
				content: null,
				tool_calls: [
					{
						id: "c1",
						type: "function",
						function: { name: "oracle", arguments: '{"prompt":"answer?"}' },
					},
				],
			}),
			choice({ content: "The oracle says 42." }),
		];
		const agent = new Agent({
			name: "asker",
			model: "m",
			node: { baseUrl: NODE },
			tools: {
				oracle: client().asTool({
					description: "Ask the oracle",
					metadata: { ryuAgentId: "agent-oracle" },
					stream: false,
				}),
			},
		});
		const result = await agent.generate("What is the answer?");
		expect(result.text).toBe("The oracle says 42.");
		expect(rpcBody(recorded.at(-1) ?? never()).params).toMatchObject({
			metadata: { ryuAgentId: "agent-oracle" },
			message: { parts: [{ text: "answer?" }] },
		});
	});
});
