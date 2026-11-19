/**
 * Gateway connection failures in the SDK-owned model call: a refused or
 * stalled Gateway names its origin and the settings that choose it, never the
 * token, matching `_model_call_failure` in `bindings/python/ryu_sdk/agent.py`.
 * Real sockets on loopback; egress enforcement is real (loopback passes).
 */

import { afterEach, describe, expect, it } from "bun:test";
import { createServer } from "node:net";
import { Agent } from "./agent.ts";
import {
	callModelWithTools,
	gatewayFetchFailure,
	gatewayOrigin,
	streamModelWithTools,
} from "./model-call.ts";

const TOKEN = "gw_model_call_secret_0123456789";
const REACH =
	/^could not reach the Ryu Gateway at http:\/\/127\.0\.0\.1:\d+ \(/;
const STALL =
	/^the Ryu Gateway at http:\/\/127\.0\.0\.1:\d+ did not respond in time \(/;

/** A loopback port with nothing listening on it. */
async function closedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

const stalled: { stop(): void }[] = [];
afterEach(() => {
	for (const server of stalled.splice(0)) {
		server.stop();
	}
});

/** A Gateway that accepts the request and never answers. */
function stalledGateway(): string {
	const server = Bun.serve({
		fetch: () => new Promise<Response>(() => undefined),
		hostname: "127.0.0.1",
		port: 0,
	});
	stalled.push({ stop: () => server.stop(true) });
	return `http://127.0.0.1:${server.port}`;
}

/**
 * A Gateway that sends its response headers and one partial chunk, then
 * stalls: a Gateway waiting on a slow upstream provider mid-answer.
 */
function headersThenStall(contentType: string, chunk: string): string {
	const server = Bun.serve({
		fetch: () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(chunk));
					},
				}),
				{ headers: { "content-type": contentType } }
			),
		hostname: "127.0.0.1",
		port: 0,
	});
	stalled.push({ stop: () => server.stop(true) });
	return `http://127.0.0.1:${server.port}`;
}

/** A Gateway that answers every call with `status` and `body`. */
function answeringGateway(status: number, body: string): string {
	const server = Bun.serve({
		fetch: () => new Response(body, { status }),
		hostname: "127.0.0.1",
		port: 0,
	});
	stalled.push({ stop: () => server.stop(true) });
	return `127.0.0.1:${server.port}`;
}

async function drain(stream: AsyncGenerator<unknown>): Promise<void> {
	for await (const _ of stream) {
		// drained
	}
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Error) {
			return error;
		}
		throw error;
	}
	throw new Error("expected a rejection");
}

function options(baseUrl: string, signal?: AbortSignal) {
	return {
		baseUrl: `${baseUrl}/`,
		messages: [{ content: "hi", role: "user" as const }],
		model: "m",
		signal,
		token: TOKEN,
	};
}

describe("Gateway connection failures", () => {
	it("a refused connection names the origin and the settings, never the token", async () => {
		const base = `http://127.0.0.1:${await closedPort()}`;
		const error = await rejection(callModelWithTools(options(base)));
		expect(error.message).toMatch(REACH);
		expect(error.message).toContain(
			"set RYU_GATEWAY_URL (or node.baseUrl) to its origin and RYU_GATEWAY_TOKEN (or node.token) to its token."
		);
		expect(error.message).not.toContain(TOKEN);
		expect(error.message).not.toContain("/v1/chat/completions");
		expect(error.cause).toBeDefined();
	});

	it("the streaming call names it the same way", async () => {
		const base = `http://127.0.0.1:${await closedPort()}`;
		const error = await rejection(
			(async () => {
				for await (const _ of streamModelWithTools(options(base))) {
					// drained
				}
			})()
		);
		expect(error.message).toMatch(REACH);
	});

	it("a timeout signal on a stalled Gateway says it did not respond in time", async () => {
		const base = stalledGateway();
		const error = await rejection(
			callModelWithTools(options(base, AbortSignal.timeout(50)))
		);
		expect(error.message).toMatch(STALL);
		expect(error.message).not.toContain(TOKEN);
	});

	it("the caller's own abort is rethrown unchanged", async () => {
		const base = stalledGateway();
		const controller = new AbortController();
		const pending = rejection(
			callModelWithTools(options(base, controller.signal))
		);
		controller.abort();
		const error = await pending;
		expect(error.name).toBe("AbortError");
		expect(error.message).not.toContain("Ryu Gateway");
	});

	it("an unparseable base keeps the token out of the message", () => {
		const failure = gatewayFetchFailure(new TypeError("bad"), "not a url");
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain(
			"could not reach the Ryu Gateway at the configured gateway URL (bad)."
		);
	});

	it("agent.generate() without a Gateway names it and RYU_GATEWAY_URL", async () => {
		const base = `http://127.0.0.1:${await closedPort()}`;
		const agent = new Agent({
			model: "m",
			name: "no-gateway",
			node: { baseUrl: base, token: TOKEN },
		});
		const error = await rejection(agent.generate("hi"));
		expect(error.message).toContain(
			'agent "no-gateway": could not reach the Ryu Gateway at'
		);
		expect(error.message).toContain("RYU_GATEWAY_URL");
		expect(error.message).not.toContain(TOKEN);
	});
	it("a Gateway that sends headers then stalls on the JSON body says it did not respond in time", async () => {
		const base = headersThenStall("application/json", '{"choices":');
		const error = await rejection(
			callModelWithTools(options(base, AbortSignal.timeout(150)))
		);
		expect(error.message).toMatch(STALL);
		expect(error.message).toContain("RYU_GATEWAY_URL");
		expect(error.message).not.toContain(TOKEN);
		expect((error.cause as Error).name).toBe("TimeoutError");
	});

	it("a Gateway that stalls mid-stream says it did not respond in time", async () => {
		const base = headersThenStall(
			"text/event-stream",
			'data: {"choices":[{"delta":{"content":"he"}}]}\n\n'
		);
		const deltas: string[] = [];
		const error = await rejection(
			(async () => {
				for await (const event of streamModelWithTools(
					options(base, AbortSignal.timeout(150))
				)) {
					if (event.type === "text_delta") {
						deltas.push(event.delta);
					}
				}
			})()
		);
		expect(deltas).toEqual(["he"]);
		expect(error.message).toMatch(STALL);
		expect(error.message).not.toContain(TOKEN);
	});

	it("a stalled SSE body with no deadline still yields its deltas before the caller aborts", async () => {
		const base = headersThenStall(
			"text/event-stream",
			'data: {"choices":[{"delta":{"content":"x"}}]}\n\n'
		);
		const controller = new AbortController();
		const pending = rejection(
			(async () => {
				for await (const event of streamModelWithTools(
					options(base, controller.signal)
				)) {
					if (event.type === "text_delta") {
						controller.abort();
					}
				}
			})()
		);
		const error = await pending;
		expect(error.message).not.toContain("Ryu Gateway");
	});

	it("a body read failure that is not a timeout is rethrown unchanged", () => {
		const original = new SyntaxError("Unexpected end of JSON input");
		expect(
			gatewayFetchFailure(original, "http://127.0.0.1:7981", undefined, "read")
		).toBe(original);
	});

	it("Node's generic 'fetch failed' names the cause instead", () => {
		const failure = gatewayFetchFailure(
			new TypeError("fetch failed", {
				cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:7981"), {
					code: "ECONNREFUSED",
				}),
			}),
			"http://127.0.0.1:7981"
		);
		expect((failure as Error).message).toContain(
			"could not reach the Ryu Gateway at http://127.0.0.1:7981 (connect ECONNREFUSED 127.0.0.1:7981)."
		);
		// A cause with a code and no message of its own.
		const bare = Object.assign(new Error("replaced below"), {
			code: "ENOTFOUND",
		});
		bare.message = "";
		const codeOnly = gatewayFetchFailure(
			new TypeError("fetch failed", { cause: bare }),
			"http://gw.invalid"
		);
		expect((codeOnly as Error).message).toContain("(ENOTFOUND)");
	});

	it("the origin drops userinfo, path and query", () => {
		expect(gatewayOrigin("http://u:pw@127.0.0.1:7981/x/?k=v")).toBe(
			"http://127.0.0.1:7981"
		);
		expect(gatewayOrigin("not a url")).toBe("the configured gateway URL");
	});
});

describe("Gateway status errors", () => {
	it("a 401 names the origin only and the token setting", async () => {
		const hostPort = answeringGateway(401, "bad token");
		const base = `http://u:pw@${hostPort}/x`;
		for (const call of [
			() => callModelWithTools(options(base)),
			() => drain(streamModelWithTools(options(base))),
		]) {
			const error = await rejection(call());
			expect(error.message).toBe(
				`[ryu-sdk] gateway 401 Unauthorized at http://${hostPort}; check RYU_GATEWAY_TOKEN (or node.token): bad token`
			);
			expect(error.message).not.toContain("pw");
			expect(error.message).not.toContain("/x");
			expect(error.message).not.toContain(TOKEN);
		}
	});

	it("a 503 names the status and origin without the token hint", async () => {
		const hostPort = answeringGateway(503, "");
		const error = await rejection(
			callModelWithTools(options(`http://${hostPort}`))
		);
		expect(error.message).toBe(
			`[ryu-sdk] gateway 503 Service Unavailable at http://${hostPort}`
		);
	});
});
