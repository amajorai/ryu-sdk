import { describe, expect, test } from "bun:test";
import { createBoxClient } from "@ryuhq/client";
import { deprecationHeaders } from "../../../../apps/server/src/deprecation.ts";
import type { RyuDeprecationEvent, RyuRetryEvent } from "../config.ts";
import {
	RyuAbortError,
	RyuConnectionError,
	type RyuError,
	RyuPaymentRequiredError,
	RyuQuotaExceededError,
	RyuRateLimitError,
	RyuRedirectError,
	RyuServerError,
	RyuTimeoutError,
	RyuUnavailableError,
	withRyuErrorFields,
} from "../errors.ts";
import type { ServiceRouteTable } from "../routes.ts";
import {
	type CallOptions,
	createCallContext,
	createServiceFetch,
	DEFAULT_ACCEPT,
	linkSignals,
	routeTemplate,
	type ServiceFetchConfig,
} from "./fetch-shim.ts";
import { serverUserAgent } from "./user-agent.ts";

interface Recorded {
	body: BodyInit | null;
	headers: Headers;
	method: string;
	redirect: RequestRedirect | undefined;
	signal: AbortSignal | null;
	url: string;
}

type Step =
	| Response
	| Error
	| ((request: Recorded) => Response | Promise<Response>);

function stubFetch(steps: Step[]) {
	const calls: Recorded[] = [];
	const fetch = async (
		input: RequestInfo | URL,
		init?: RequestInit
	): Promise<Response> => {
		const request: Recorded = {
			body: init?.body ?? null,
			headers: new Headers(init?.headers),
			method: init?.method ?? "GET",
			redirect: init?.redirect,
			signal: init?.signal ?? null,
			url: String(input),
		};
		calls.push(request);
		const step = steps[Math.min(calls.length - 1, steps.length - 1)];
		if (step instanceof Error) {
			throw step;
		}
		if (typeof step === "function") {
			return step(request);
		}
		if (!step) {
			throw new Error("no stub response");
		}
		return step.clone();
	};
	return { calls, fetch };
}

const BOX_TABLE: ServiceRouteTable = {
	idempotent: [
		{ method: "POST", path: "/v1/boxes", required: true },
		{ method: "POST", path: "/v1/boxes/{id}/fork", required: true },
	],
	mount: "",
	service: "box",
};
const BASE = "https://box.example.com";

function setup(
	steps: Step[],
	overrides: Partial<ServiceFetchConfig> = {},
	options: CallOptions = {},
	boundKey?: { spent: boolean }
) {
	const stub = stubFetch(steps);
	const delays: number[] = [];
	const config: ServiceFetchConfig = {
		apiKey: "box_key",
		auth: "bearer",
		autoIdempotency: true,
		baseUrl: BASE,
		errors: "throw",
		fetch: stub.fetch,
		maxRetries: 2,
		maxRetryDelayMs: 30_000,
		routes: BOX_TABLE,
		service: "box",
		sleep: (ms) => {
			delays.push(ms);
			return Promise.resolve();
		},
		random: () => 1,
		timeoutMs: 5000,
		userAgent: null,
		...overrides,
	};
	const ctx = createCallContext(options, boundKey);
	return {
		...stub,
		config,
		ctx,
		delays,
		fetch: createServiceFetch(config, ctx),
	};
}

function ok(
	body: unknown = { ok: true },
	headers: Record<string, string> = {}
): Response {
	return Response.json(body, { headers, status: 200 });
}

function boxError(
	code: string,
	status: number,
	headers: Record<string, string> = {}
): Response {
	return Response.json(
		{
			code,
			error: { code, message: code, requestId: "req_1", status },
			ok: false,
			type: "box.error",
		},
		{ headers, status }
	);
}

/** Settles with `promise`, or fails the test instead of hanging when it never settles. */
function within<T>(promise: Promise<T>, ms = 1000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new Error(`did not settle within ${ms} ms`)),
			ms
		);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Counts the abort listeners currently attached to `signal`. */
function countListeners(signal: AbortSignal): { active(): number } {
	let active = 0;
	const add = signal.addEventListener.bind(signal);
	const remove = signal.removeEventListener.bind(signal);
	const listeners = new Set<unknown>();
	signal.addEventListener = ((
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: AddEventListenerOptions | boolean
	) => {
		if (type === "abort" && !listeners.has(listener)) {
			listeners.add(listener);
			active += 1;
		}
		add(type, listener, options);
	}) as AbortSignal["addEventListener"];
	signal.removeEventListener = ((
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: EventListenerOptions | boolean
	) => {
		if (type === "abort" && listeners.delete(listener)) {
			active -= 1;
		}
		remove(type, listener, options);
	}) as AbortSignal["removeEventListener"];
	return { active: () => active };
}

async function rejection(promise: Promise<unknown>): Promise<RyuError> {
	try {
		await promise;
	} catch (error) {
		return error as RyuError;
	}
	throw new Error("expected a rejection");
}

const post = (body = "{}"): RequestInit => ({
	body,
	headers: {
		authorization: "Bearer box_key",
		"content-type": "application/json",
	},
	method: "POST",
});

describe("idempotency keys", () => {
	test("added only on route-table POST/PATCH, and reused on every retry", async () => {
		const { calls, fetch } = setup([boxError("driver_unavailable", 503), ok()]);
		await fetch(`${BASE}/v1/boxes`, post());
		expect(calls).toHaveLength(2);
		const key = calls[0]?.headers.get("idempotency-key");
		expect(key).toBeTruthy();
		expect(calls[1]?.headers.get("idempotency-key")).toBe(key ?? "");

		const other = setup([ok()]);
		await other.fetch(`${BASE}/v1/boxes/b_1/stop`, post());
		await other.fetch(`${BASE}/v1/boxes`, { method: "GET" });
		await other.fetch(`${BASE}/v1/boxes/b_1`, { method: "DELETE" });
		for (const call of other.calls) {
			expect(call.headers.has("idempotency-key")).toBe(false);
		}
	});

	test("an existing client key is kept, and recorded in meta", async () => {
		const { calls, ctx, fetch } = setup([ok()]);
		await fetch(`${BASE}/v1/boxes`, {
			...post(),
			headers: { "Idempotency-Key": "client-key-1234567" },
		});
		expect(calls[0]?.headers.get("idempotency-key")).toBe("client-key-1234567");
		expect(ctx.meta?.idempotencyKey).toBe("client-key-1234567");
	});

	test("a caller key overrides the Box client's own key, for the first matched request only", async () => {
		const box = { box: { id: "b_1" } };
		const { calls, fetch } = setup(
			[ok(box)],
			{},
			{ idempotencyKey: "caller-key-000001" }
		);
		const client = createBoxClient({ apiKey: "box_key", baseUrl: BASE, fetch });
		await client
			.create({ name: "build", size: "small" })
			.catch(() => undefined);
		await client.fork("b_1").catch(() => undefined);
		expect(calls[0]?.headers.get("idempotency-key")).toBe("caller-key-000001");
		const second = calls[1]?.headers.get("idempotency-key");
		expect(second).toBeTruthy();
		expect(second).not.toBe("caller-key-000001");
	});

	test("autoIdempotency: false adds no key", async () => {
		const { calls, fetch } = setup([ok()], { autoIdempotency: false });
		await fetch(`${BASE}/v1/boxes`, post());
		expect(calls[0]?.headers.has("idempotency-key")).toBe(false);
	});
});

describe("retries", () => {
	test("a non-idempotent POST is not retried on a 5xx or a network error", async () => {
		const server = setup([boxError("driver_failed", 502), ok()]);
		const error = await rejection(
			server.fetch(`${BASE}/v1/boxes/b_1/commands`, post())
		);
		expect(error).toBeInstanceOf(RyuServerError);
		expect(server.calls).toHaveLength(1);

		const network = setup([new TypeError("fetch failed"), ok()]);
		const failure = await rejection(
			network.fetch(`${BASE}/v1/boxes/b_1/commands`, post())
		);
		expect(failure).toBeInstanceOf(RyuConnectionError);
		expect(failure.attempts).toBe(1);
		// The message names the service the way its hint does ("Ryu Box"),
		// never by its lowercase id.
		expect(failure.message).toStartWith(
			"Ryu Box: POST request failed before a response:"
		);
		expect(failure.message).toContain("Could not reach Ryu Box");
		expect(network.calls).toHaveLength(1);
	});

	test("a GET is retried on a network error and a 5xx, with backoff", async () => {
		const retries: RyuRetryEvent[] = [];
		const { calls, delays, fetch } = setup(
			[new TypeError("reset"), boxError("request_failed", 500), ok()],
			{ hooks: { onRetry: (event) => retries.push(event) } }
		);
		const response = await fetch(`${BASE}/v1/boxes`);
		expect(response.status).toBe(200);
		expect(calls).toHaveLength(3);
		expect(delays).toEqual([500, 1000]);
		expect(retries.map((event) => event.code)).toEqual([
			"connection_error",
			"request_failed",
		]);
	});

	test("gives up after maxRetries and reports the attempts", async () => {
		const { calls, fetch } = setup([boxError("request_failed", 503)], {
			maxRetries: 1,
		});
		const error = await rejection(fetch(`${BASE}/v1/boxes`));
		expect(error.attempts).toBe(2);
		expect(calls).toHaveLength(2);
	});

	test("429 honours Retry-After, for any method", async () => {
		const { calls, delays, fetch } = setup([
			boxError("rate_limited", 429, { "Retry-After": "2" }),
			ok(),
		]);
		await fetch(`${BASE}/v1/boxes/b_1/commands`, post());
		expect(calls).toHaveLength(2);
		expect(delays).toEqual([2000]);
	});

	test("429 honours RateLimit r=0;t", async () => {
		const { delays, fetch } = setup([
			boxError("rate_limited", 429, { RateLimit: '"burst";r=0;t=3' }),
			ok(),
		]);
		await fetch(`${BASE}/v1/boxes`);
		expect(delays).toEqual([3000]);
	});

	test("429 without any hint is not retried", async () => {
		const { calls, fetch } = setup([boxError("rate_limited", 429), ok()]);
		const error = await rejection(fetch(`${BASE}/v1/boxes`));
		expect(error).toBeInstanceOf(RyuRateLimitError);
		expect(calls).toHaveLength(1);
	});

	test.each([
		["quota_exceeded", 429, RyuQuotaExceededError],
		["insufficient_credits", 402, RyuPaymentRequiredError],
		["managed_agents_disabled", 503, RyuUnavailableError],
	] as const)("%s is not retried", async (code, status, ErrorClass) => {
		const { calls, fetch } = setup([
			boxError(code, status, { "Retry-After": "1" }),
			ok(),
		]);
		const error = await rejection(fetch(`${BASE}/v1/boxes`, post()));
		expect(error.code).toBe(code);
		expect(error).toBeInstanceOf(ErrorClass);
		expect(calls).toHaveLength(1);
	});

	test("409 idempotency_in_progress is retried with the same key", async () => {
		const { calls, delays, fetch } = setup([
			boxError("idempotency_in_progress", 409, { "Retry-After": "1" }),
			ok(),
		]);
		await fetch(`${BASE}/v1/boxes`, post());
		expect(calls).toHaveLength(2);
		expect(delays).toEqual([1000]);
		expect(calls[1]?.headers.get("idempotency-key")).toBe(
			calls[0]?.headers.get("idempotency-key") ?? ""
		);
	});

	test("a requested delay above maxRetryDelayMs is surfaced instead of waited out", async () => {
		const header = setup([
			boxError("rate_limited", 429, { "Retry-After": "120" }),
			ok(),
		]);
		const error = await rejection(header.fetch(`${BASE}/v1/boxes`));
		expect(error.retryAfterSeconds).toBe(120);
		expect(header.calls).toHaveLength(1);
		expect(header.delays).toEqual([]);

		const rateLimit = setup([
			boxError("rate_limited", 429, { RateLimit: '"day";r=0;t=90' }),
			ok(),
		]);
		const limited = await rejection(rateLimit.fetch(`${BASE}/v1/boxes`));
		expect(limited).toBeInstanceOf(RyuRateLimitError);
		expect(limited.retryAfterSeconds).toBe(90);
		expect(rateLimit.calls).toHaveLength(1);
	});

	test("SDK backoff above maxRetryDelayMs is not reported as a server Retry-After", async () => {
		const { calls, delays, fetch } = setup([boxError("request_failed", 503)], {
			maxRetryDelayMs: 0,
		});
		const error = await rejection(fetch(`${BASE}/v1/boxes`));
		expect(error).toBeInstanceOf(RyuUnavailableError);
		expect(error.retryAfterSeconds).toBeNull();
		expect(calls).toHaveLength(1);
		expect(delays).toEqual([]);
	});

	test("an SSE request is never retried by the shim", async () => {
		const { calls, fetch } = setup([boxError("request_failed", 503), ok()]);
		await rejection(
			fetch(`${BASE}/v1/boxes/b_1/events`, {
				headers: { accept: "text/event-stream" },
			})
		);
		expect(calls).toHaveLength(1);
	});

	test("a stream body is never retried", async () => {
		const { calls, fetch } = setup([boxError("request_failed", 503), ok()]);
		await rejection(
			fetch(`${BASE}/v1/boxes`, { body: new ReadableStream(), method: "POST" })
		);
		expect(calls).toHaveLength(1);
	});
});

describe("origin scoping and auth", () => {
	test("foreign-origin requests get no auth, headers, retries or error mapping", async () => {
		const { calls, fetch } = setup([new Response("nope", { status: 500 })]);
		const response = await fetch("https://s3.example.com/signed?sig=abc", {
			headers: { Authorization: "Bearer box_key" },
		});
		expect(response.status).toBe(500);
		expect(calls).toHaveLength(1);
		const headers = calls[0]?.headers;
		expect(headers?.has("authorization")).toBe(false);
		expect(headers?.has("accept")).toBe(false);
		expect(headers?.has("idempotency-key")).toBe(false);
		expect(calls[0]?.url).toBe("https://s3.example.com/signed?sig=abc");
	});

	test("hosted Mail: Bearer is rewritten to x-gateway-key and Authorization is removed", async () => {
		const { calls, fetch } = setup([ok()], {
			apiKey: "gw_key",
			auth: "x-gateway-key",
			baseUrl: "https://api.ryuhq.com",
			routes: { idempotent: [], mount: "/api/mail", service: "mail" },
			service: "mail",
		});
		await fetch("https://api.ryuhq.com/api/mail/inboxes", {
			headers: {
				Authorization: "Bearer gw_key",
				"x-api-key": "ryu_should_not_leak",
			},
		});
		const headers = calls[0]?.headers;
		expect(headers?.get("x-gateway-key")).toBe("gw_key");
		expect(headers?.has("authorization")).toBe(false);
		expect(headers?.has("x-api-key")).toBe(false);
	});

	test("x-api-key services drop any Authorization header", async () => {
		const { calls, fetch } = setup([ok()], { auth: "x-api-key" });
		await fetch(`${BASE}/v1/boxes`, {
			headers: { authorization: "Bearer x", "x-api-key": "ryu_k" },
		});
		expect(calls[0]?.headers.get("x-api-key")).toBe("ryu_k");
		expect(calls[0]?.headers.has("authorization")).toBe(false);
	});

	test("x-api-key services turn a client Bearer into x-api-key (hosted Mail on a ryu_ key)", async () => {
		const { calls, fetch } = setup([ok(), ok()], {
			auth: "x-api-key",
			apiKey: "ryu_config",
		});
		await fetch(`${BASE}/api/mail/inboxes`, {
			headers: { authorization: "Bearer ryu_from_client" },
		});
		await fetch(`${BASE}/api/mail/inboxes`);
		expect(calls[0]?.headers.get("x-api-key")).toBe("ryu_from_client");
		expect(calls[0]?.headers.has("authorization")).toBe(false);
		expect(calls[1]?.headers.get("x-api-key")).toBe("ryu_config");
	});

	test("selectKey swaps the bearer for matching routes", async () => {
		const { calls, fetch } = setup([ok()], {
			selectKey: ({ path }) =>
				path?.startsWith("/v1/runtime/") ? "runtime_key" : undefined,
		});
		await fetch(`${BASE}/v1/runtime/connections`, {
			headers: { authorization: "Bearer admin" },
		});
		await fetch(`${BASE}/v1/connections`, {
			headers: { authorization: "Bearer admin" },
		});
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer runtime_key");
		expect(calls[1]?.headers.get("authorization")).toBe("Bearer admin");
	});
});

describe("headers", () => {
	test("Accept defaults to JSON; call headers merge; redirects are manual", async () => {
		const { calls, fetch } = setup(
			[ok()],
			{},
			{ headers: { "x-trace": "t1" } }
		);
		await fetch(`${BASE}/v1/boxes`);
		expect(calls[0]?.headers.get("accept")).toBe(DEFAULT_ACCEPT);
		// Services that negotiate RFC 9457 answer errors as problem+json.
		expect(DEFAULT_ACCEPT).toBe(
			"application/problem+json, application/json;q=0.9, */*;q=0.8"
		);
		expect(calls[0]?.headers.get("x-trace")).toBe("t1");
		expect(calls[0]?.redirect).toBe("manual");
	});

	test("a client's own Accept (an event stream) is kept", async () => {
		const { calls, fetch } = setup([ok()]);
		await fetch(`${BASE}/v1/boxes`, {
			headers: { accept: "text/event-stream" },
		});
		expect(calls[0]?.headers.get("accept")).toBe("text/event-stream");
	});

	test("User-Agent is sent on server runtimes and never when the runtime looks like a browser", async () => {
		const browser = {
			document: {},
			navigator: { userAgent: "Mozilla/5.0" },
			window: {},
		};
		expect(serverUserAgent(undefined, browser)).toBeNull();
		const inBrowser = setup([ok()], {
			userAgent: serverUserAgent(undefined, browser),
		});
		await inBrowser.fetch(`${BASE}/v1/boxes`);
		expect(inBrowser.calls[0]?.headers.has("user-agent")).toBe(false);

		const userAgent = serverUserAgent("my-app/1.0");
		expect(userAgent).toMatch(
			/^ryu-services\/0\.1\.0 \(bun\/[^)]+\) my-app\/1\.0$/u
		);
		const onServer = setup([ok()], { userAgent });
		await onServer.fetch(`${BASE}/v1/boxes`);
		expect(onServer.calls[0]?.headers.get("user-agent")).toBe(userAgent ?? "");
		expect(serverUserAgent(false)).toBeNull();
	});
});

describe("redirects", () => {
	test("a 3xx raises redirect_refused with only the target origin", async () => {
		const { fetch } = setup([
			Response.redirect("https://evil.example.com/steal?k=1", 307),
		]);
		const error = await rejection(fetch(`${BASE}/v1/boxes`));
		expect(error).toBeInstanceOf(RyuRedirectError);
		expect(error.code).toBe("redirect_refused");
		expect(error.status).toBe(307);
		expect(error.details).toEqual({ location: "https://evil.example.com" });
	});

	test("passthrough mode hands the 3xx back to the client", async () => {
		const { fetch } = setup([new Response(null, { status: 302 })], {
			errors: "passthrough",
		});
		const response = await fetch(`${BASE}/v1/boxes`);
		expect(response.status).toBe(302);
	});
});

describe("timeouts and aborts", () => {
	const hang = (request: Recorded) =>
		new Promise<Response>((_resolve, reject) => {
			request.signal?.addEventListener("abort", () =>
				reject(new DOMException("aborted", "AbortError"))
			);
		});

	test("the timeout fires before headers arrive", async () => {
		const { calls, fetch } = setup([hang], { maxRetries: 0, timeoutMs: 20 });
		const error = await rejection(fetch(`${BASE}/v1/boxes`));
		expect(error).toBeInstanceOf(RyuTimeoutError);
		expect(error.code).toBe("timeout");
		expect(calls).toHaveLength(1);
	});

	test("a timed-out GET is retried", async () => {
		const { calls, fetch } = setup([hang, ok()], {
			maxRetries: 1,
			timeoutMs: 20,
		});
		expect((await fetch(`${BASE}/v1/boxes`)).status).toBe(200);
		expect(calls).toHaveLength(2);
	});

	test("the timeout does not cut off a streamed body", async () => {
		const streamed = () =>
			new Response(
				new ReadableStream({
					start(controller) {
						setTimeout(() => {
							controller.enqueue(new TextEncoder().encode("late chunk"));
							controller.close();
						}, 60);
					},
				}),
				{ status: 200 }
			);
		const { fetch } = setup([streamed], { timeoutMs: 20 });
		const response = await fetch(`${BASE}/v1/boxes/b_1/events`, {
			headers: { accept: "text/event-stream" },
		});
		expect(await response.text()).toBe("late chunk");
	});

	test("a caller abort raises RyuAbortError and is not retried", async () => {
		const controller = new AbortController();
		const { calls, fetch } = setup(
			[hang, ok()],
			{},
			{ signal: controller.signal }
		);
		const pending = rejection(fetch(`${BASE}/v1/boxes`));
		setTimeout(() => controller.abort(), 5);
		const error = await pending;
		expect(error).toBeInstanceOf(RyuAbortError);
		expect(error.retryable).toBe(false);
		expect(calls).toHaveLength(1);
	});

	test("a non-idempotent POST that times out is not retried", async () => {
		const { calls, fetch } = setup([hang, ok()], {
			maxRetries: 2,
			timeoutMs: 20,
		});
		const error = await rejection(
			fetch(`${BASE}/v1/boxes/b_1/exec`, post('{"cmd":"rm -rf build"}'))
		);
		expect(error).toBeInstanceOf(RyuTimeoutError);
		expect(error.status).toBe(0);
		expect(calls).toHaveLength(1);
	});

	test("connection and timeout errors keep query strings and keys out of message and toJSON", async () => {
		const url = `${BASE}/v1/boxes?token=sekrit_token`;
		const refused = setup(
			[new TypeError(`connect ECONNREFUSED ${url} (key box_key)`)],
			{ maxRetries: 0 }
		);
		const connection = await rejection(
			refused.fetch(url, { headers: { authorization: "Bearer box_key" } })
		);
		const timedOut = setup([hang], { maxRetries: 0, timeoutMs: 20 });
		const timeout = await rejection(timedOut.fetch(url));
		expect(connection).toBeInstanceOf(RyuConnectionError);
		expect(timeout).toBeInstanceOf(RyuTimeoutError);
		for (const error of [connection, timeout]) {
			const serialized = `${error.message} ${JSON.stringify(error.toJSON())}`;
			expect(serialized).not.toContain("sekrit_token");
			expect(serialized).not.toContain("box_key");
			expect(error.url).toBe(`${BASE}/v1/boxes`);
		}
	});

	test("connection and timeout errors hint the target origin, RYU_BOX_URL and doctor", async () => {
		const url = `${BASE}/v1/boxes?token=sekrit_token`;
		const refused = setup([new TypeError("fetch failed")], { maxRetries: 0 });
		const connection = await rejection(refused.fetch(url));
		const timedOut = setup([hang], { maxRetries: 0, timeoutMs: 20 });
		const timeout = await rejection(timedOut.fetch(url));
		expect(connection.hint).toBe(
			`Could not reach Ryu Box at ${BASE}. Check RYU_BOX_URL (or box.baseUrl). Run \`ryu-services doctor --check\` to test the connection.`
		);
		expect(timeout.hint).toContain(
			`Ryu Box at ${BASE} did not respond in time`
		);
		for (const error of [connection, timeout]) {
			expect(error.hint).toContain("RYU_BOX_URL");
			expect(error.hint).toContain("ryu-services doctor --check");
			expect(error.hint).not.toContain("/v1/boxes");
			expect(error.hint).not.toContain("sekrit_token");
		}
	});

	test("the request's own signal cuts a retry wait short even when the call has a signal", async () => {
		const requestAbort = new AbortController();
		const callAbort = new AbortController();
		const { calls, fetch } = setup(
			[boxError("request_failed", 503, { "Retry-After": "10" }), ok()],
			{ sleep: undefined },
			{ signal: callAbort.signal }
		);
		const pending = rejection(
			fetch(`${BASE}/v1/boxes`, { signal: requestAbort.signal })
		);
		setTimeout(() => requestAbort.abort(), 10);
		const error = await within(pending);
		expect(error).toBeInstanceOf(RyuAbortError);
		expect(calls).toHaveLength(1);
	});

	test("a long-lived caller signal collects no listeners across calls", async () => {
		const shared = new AbortController();
		const tracked = countListeners(shared.signal);
		for (let index = 0; index < 20; index += 1) {
			const { fetch } = setup(
				[ok(), new Response(null, { status: 204 })],
				{},
				{ signal: shared.signal }
			);
			await (await fetch(`${BASE}/v1/boxes`)).text();
			await fetch(`${BASE}/v1/boxes/b_1`, { method: "DELETE" });
		}
		expect(tracked.active()).toBe(0);
	});

	test("linkSignals without AbortSignal.any links inputs and removes its listeners on dispose", () => {
		const original = AbortSignal.any;
		const first = new AbortController();
		const second = new AbortController();
		const tracked = countListeners(first.signal);
		try {
			Reflect.set(AbortSignal, "any", undefined);
			const linked = linkSignals([first.signal, second.signal]);
			expect(tracked.active()).toBe(1);
			linked.dispose();
			expect(tracked.active()).toBe(0);
			const live = linkSignals([first.signal, second.signal]);
			second.abort();
			expect(live.signal?.aborted).toBe(true);
			live.dispose();
		} finally {
			Reflect.set(AbortSignal, "any", original);
		}
		expect(linkSignals([]).signal).toBeUndefined();
		expect(linkSignals([first.signal]).signal).toBe(first.signal);
	});

	test("a request signal that is already aborted never reaches the network", async () => {
		const controller = new AbortController();
		controller.abort();
		const { calls, fetch } = setup([ok()]);
		const error = await rejection(
			fetch(`${BASE}/v1/boxes`, { signal: controller.signal })
		);
		expect(error).toBeInstanceOf(RyuAbortError);
		expect(calls).toHaveLength(0);
	});
});

describe("error modes and meta", () => {
	test("passthrough mode returns non-2xx responses unchanged", async () => {
		const body = {
			error: {
				code: "unauthenticated",
				message: "Bad key.",
				requestId: "req_9",
			},
		};
		const { calls, ctx, fetch } = setup(
			[
				Response.json(body, {
					headers: { "x-request-id": "req_9" },
					status: 401,
				}),
			],
			{
				errors: "passthrough",
			}
		);
		const response = await fetch(`${BASE}/v1/boxes`);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual(body);
		expect(calls).toHaveLength(1);
		expect(ctx.meta?.status).toBe(401);
		expect(ctx.meta?.requestId).toBe("req_9");
	});

	test("throw mode raises the typed error from inside fetch", async () => {
		const { fetch } = setup([boxError("box_busy", 409)]);
		const error = await rejection(fetch(`${BASE}/v1/boxes`, post()));
		expect(error.code).toBe("box_busy");
		expect(error.idempotencyKey).toBeTruthy();
	});

	test("meta records status, request id, replay, rate limit and deprecation; onDeprecation fires once per route", async () => {
		const events: RyuDeprecationEvent[] = [];
		const headers = new Headers({
			"Idempotent-Replayed": "true",
			RateLimit: '"day";r=9;t=60',
			"RateLimit-Policy": '"day";q=10;w=86400',
			"X-Request-ID": "req_meta",
		});
		for (const [name, value] of deprecationHeaders({
			deprecatedAt: new Date("2026-01-01T00:00:00Z"),
			path: "/v1/boxes",
		})) {
			headers.append(name, value);
		}
		const response = () => new Response("{}", { headers, status: 200 });
		const seen = new Set<string>();
		const first = setup([response], {
			deprecationSeen: seen,
			hooks: { onDeprecation: (event) => events.push(event) },
		});
		await first.fetch(`${BASE}/v1/boxes`, post());
		await first.fetch(`${BASE}/v1/boxes`, post());
		expect(first.ctx.meta).toMatchObject({
			attempts: 1,
			rateLimit: {
				limit: 10,
				policy: "day",
				remaining: 9,
				resetSeconds: 60,
				windowSeconds: 86_400,
			},
			replayed: true,
			requestId: "req_meta",
			status: 200,
		});
		expect(first.ctx.meta?.deprecation?.deprecatedAt?.toISOString()).toBe(
			"2026-01-01T00:00:00.000Z"
		);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			method: "POST",
			service: "box",
			url: `${BASE}/v1/boxes`,
		});
	});

	test("onDeprecation fires once per route template, not once per resource id", async () => {
		const events: RyuDeprecationEvent[] = [];
		const headers = new Headers();
		for (const [name, value] of deprecationHeaders({
			deprecatedAt: new Date("2026-01-01T00:00:00Z"),
			path: "/v1/boxes/{id}",
		})) {
			headers.append(name, value);
		}
		const seen = new Set<string>();
		const { fetch } = setup(
			[() => new Response("{}", { headers, status: 200 })],
			{
				deprecationSeen: seen,
				hooks: { onDeprecation: (event) => events.push(event) },
			}
		);
		await fetch(`${BASE}/v1/boxes/b_1`);
		await fetch(`${BASE}/v1/boxes/b_2?expand=true`);
		await fetch(`${BASE}/v1/boxes/0f8fad5b-d9cb-469f-a165-70867728950e`);
		expect(events).toHaveLength(1);
		expect([...seen]).toEqual(["GET /v1/boxes/{id}"]);
	});

	test("the onDeprecation memory is bounded", async () => {
		const headers = new Headers();
		for (const [name, value] of deprecationHeaders({
			deprecatedAt: new Date("2026-01-01T00:00:00Z"),
			path: "/v1/x",
		})) {
			headers.append(name, value);
		}
		const seen = new Set<string>();
		const { fetch } = setup(
			[() => new Response("{}", { headers, status: 200 })],
			{ deprecationSeen: seen, hooks: { onDeprecation: () => undefined } }
		);
		const letters = "abcdefghijklmnopqrstuvwxyz";
		for (let index = 0; index < 300; index += 1) {
			const word = `${letters[index % 26]}${letters[Math.floor(index / 26) % 26]}`;
			await fetch(`${BASE}/v1/${word}`);
		}
		expect(seen.size).toBeLessThanOrEqual(256);
	});

	test("routeTemplate folds id-like segments only", () => {
		expect(routeTemplate("/v1/boxes/b_123/fork")).toBe("/v1/boxes/{id}/fork");
		expect(routeTemplate("/v1/api-keys")).toBe("/v1/api-keys");
		expect(routeTemplate("/v1/mail/inbox%40example.com")).toBe("/v1/mail/{id}");
		expect(routeTemplate("/v1/topics/abcdefghijklmnopqrstuvwxyz")).toBe(
			"/v1/topics/{id}"
		);
	});

	test("a replayedBodyField marks replays from the body, leaving the body for the client", async () => {
		const table: ServiceRouteTable = {
			...BOX_TABLE,
			replayedBodyField: "idempotent",
		};
		const replay = setup([ok({ event: { id: "e_1" }, idempotent: true })], {
			routes: table,
		});
		const response = await replay.fetch(`${BASE}/v1/boxes`, post());
		expect(replay.ctx.meta?.replayed).toBe(true);
		expect(await response.json()).toEqual({
			event: { id: "e_1" },
			idempotent: true,
		});

		const fresh = setup([ok({ idempotent: false })], { routes: table });
		await fresh.fetch(`${BASE}/v1/boxes`, post());
		expect(fresh.ctx.meta?.replayed).toBe(false);

		// Off the idempotent routes the body is never inspected.
		const other = setup([ok({ idempotent: true })], { routes: table });
		await other.fetch(`${BASE}/v1/boxes/b_1`);
		expect(other.ctx.meta?.replayed).toBe(false);
	});

	test("successful bodies are never consumed by the shim", async () => {
		const { fetch } = setup([ok({ box: { id: "b_1" } })]);
		const response = await fetch(`${BASE}/v1/boxes/b_1`);
		expect(response.bodyUsed).toBe(false);
		expect(await response.json()).toEqual({ box: { id: "b_1" } });
	});

	test("a throwing hook never fails the request", async () => {
		const { fetch } = setup([ok()], {
			hooks: {
				onRequest: () => {
					throw new Error("hook bug");
				},
			},
		});
		expect((await fetch(`${BASE}/v1/boxes`)).status).toBe(200);
	});
});

describe("route-table replay rules", () => {
	const GATED_TABLE: ServiceRouteTable = {
		...BOX_TABLE,
		capabilityIdempotent: [
			{
				capability: "idempotency_keys",
				method: "POST",
				path: "/v1/things",
				required: false,
			},
		],
		nonReplaySafe: [
			{ method: "PUT", path: "/v1/settings", reason: "one-time secret" },
		],
	};
	const unavailable = () => Response.json({ error: "down" }, { status: 503 });

	test("a non-replay-safe PUT is not retried on a 5xx or network error", async () => {
		const server = setup([unavailable(), ok()], { routes: GATED_TABLE });
		await expect(
			server.fetch(`${BASE}/v1/settings`, { body: "{}", method: "PUT" })
		).rejects.toBeInstanceOf(RyuUnavailableError);
		expect(server.calls).toHaveLength(1);
		const network = setup([new TypeError("fetch failed"), ok()], {
			routes: GATED_TABLE,
		});
		await expect(
			network.fetch(`${BASE}/v1/settings`, { body: "{}", method: "PUT" })
		).rejects.toBeInstanceOf(RyuConnectionError);
		expect(network.calls).toHaveLength(1);
	});

	test("a non-replay-safe PUT is still retried on a 429 that names a wait", async () => {
		const server = setup(
			[
				Response.json(
					{ error: "slow" },
					{ status: 429, headers: { "retry-after": "1" } }
				),
				ok(),
			],
			{ routes: GATED_TABLE }
		);
		const response = await server.fetch(`${BASE}/v1/settings`, {
			body: "{}",
			method: "PUT",
		});
		expect(response.status).toBe(200);
		expect(server.calls).toHaveLength(2);
	});

	test("a PUT elsewhere is still replayed as an idempotent method", async () => {
		const server = setup([unavailable(), ok()], { routes: GATED_TABLE });
		await server.fetch(`${BASE}/v1/other`, { body: "{}", method: "PUT" });
		expect(server.calls).toHaveLength(2);
	});

	test("a gated route is keyed and retried only when the capability resolves true", async () => {
		const asked: string[] = [];
		const supported = setup([unavailable(), ok()], {
			capability: (name) => {
				asked.push(name);
				return Promise.resolve(true);
			},
			routes: GATED_TABLE,
		});
		await supported.fetch(`${BASE}/v1/things`, { body: "{}", method: "POST" });
		expect(asked).toEqual(["idempotency_keys"]);
		const keys = supported.calls.map((call) =>
			call.headers.get("idempotency-key")
		);
		expect(keys).toHaveLength(2);
		expect(keys[0]).not.toBeNull();
		expect(keys[1]).toBe(keys[0] ?? "");
		expect(supported.ctx.meta?.idempotencyKey).toBe(keys[0] ?? "");
	});

	for (const [label, capability] of [
		["false", () => Promise.resolve(false)],
		["a rejection", () => Promise.reject(new Error("probe exploded"))],
		["absent", undefined],
	] as const) {
		test(`a gated route with the capability ${label} gets no key and no replay`, async () => {
			const server = setup([unavailable(), ok()], {
				capability,
				routes: GATED_TABLE,
			});
			await expect(
				server.fetch(`${BASE}/v1/things`, { body: "{}", method: "POST" })
			).rejects.toBeInstanceOf(RyuUnavailableError);
			expect(server.calls).toHaveLength(1);
			expect(server.calls[0]?.headers.get("idempotency-key")).toBeNull();
		});
	}

	for (const [label, capability] of [
		["false", () => Promise.resolve(false)],
		["unknown", () => Promise.reject(new Error("probe failed"))],
	] as const) {
		test(`a caller key on a gated route whose capability is ${label} is sent but never replayed`, async () => {
			const server = setup(
				[unavailable(), ok()],
				{ capability, routes: GATED_TABLE },
				{ idempotencyKey: "caller-key-0123456789" }
			);
			await expect(
				server.fetch(`${BASE}/v1/things`, { body: "{}", method: "POST" })
			).rejects.toBeInstanceOf(RyuUnavailableError);
			expect(server.calls).toHaveLength(1);
			expect(server.calls[0]?.headers.get("idempotency-key")).toBe(
				"caller-key-0123456789"
			);
			expect(server.ctx.callerKeyUsed).toBe(true);
		});
	}

	test("a raw Idempotency-Key header on an unsupported gated route is forwarded but never replayed", async () => {
		const server = setup(
			[unavailable(), ok()],
			{ capability: () => Promise.resolve(false), routes: GATED_TABLE },
			{ headers: { "Idempotency-Key": "header-key-0123456789" } }
		);
		await expect(
			server.fetch(`${BASE}/v1/things`, { body: "{}", method: "POST" })
		).rejects.toBeInstanceOf(RyuUnavailableError);
		expect(server.calls).toHaveLength(1);
		expect(server.calls[0]?.headers.get("idempotency-key")).toBe(
			"header-key-0123456789"
		);
	});

	test("a bound key on an unsupported gated route is spent like on any keyed route", async () => {
		const boundKey = { spent: false };
		const first = setup(
			[ok()],
			{ capability: () => Promise.resolve(false), routes: GATED_TABLE },
			{ idempotencyKey: "bound-key-0123456789" },
			boundKey
		);
		await first.fetch(`${BASE}/v1/things`, { body: "{}", method: "POST" });
		expect(boundKey.spent).toBe(true);
		const second = setup(
			[ok()],
			{ capability: () => Promise.resolve(false), routes: GATED_TABLE },
			{ idempotencyKey: "bound-key-0123456789" },
			boundKey
		);
		await expect(
			second.fetch(`${BASE}/v1/things`, { body: "{}", method: "POST" })
		).rejects.toMatchObject({ code: "idempotency_key_reused" });
		expect(second.calls).toHaveLength(0);
	});

	test("no capability lookup when no key would be sent", async () => {
		let asked = 0;
		const server = setup([ok()], {
			autoIdempotency: false,
			capability: () => {
				asked += 1;
				return Promise.resolve(true);
			},
			routes: GATED_TABLE,
		});
		await server.fetch(`${BASE}/v1/things`, { body: "{}", method: "POST" });
		expect(asked).toBe(0);
	});
});

describe("refineError", () => {
	test("sees the JSON body before the retry decision and can make a failure final", async () => {
		const bodies: unknown[] = [];
		const server = setup(
			[
				Response.json(
					{ error: { code: "provider_error", upstream_status: 400 } },
					{ status: 502 }
				),
				ok(),
			],
			{
				refineError: (error, body) => {
					bodies.push(body);
					return withRyuErrorFields(error, { retryable: false });
				},
			}
		);
		const error = (await server
			.fetch(`${BASE}/v1/boxes/b1`)
			.catch((caught: unknown) => caught)) as RyuError;
		expect(error).toBeInstanceOf(RyuServerError);
		expect(error.retryable).toBe(false);
		expect(server.calls).toHaveLength(1);
		expect(bodies).toEqual([
			{ error: { code: "provider_error", upstream_status: 400 } },
		]);
	});

	test("gets undefined for a JSON body over 64 KiB without parsing it", async () => {
		const bodies: unknown[] = [];
		const large = JSON.stringify({
			error: { code: "provider_error", upstream_status: 400 },
			padding: "x".repeat(256 * 1024),
		});
		const server = setup(
			[
				new Response(large, {
					headers: { "content-type": "application/json" },
					status: 502,
				}),
			],
			{
				refineError: (error, body) => {
					bodies.push(body);
					return error;
				},
			}
		);
		await expect(server.fetch(`${BASE}/v1/boxes/b1`)).rejects.toBeInstanceOf(
			RyuServerError
		);
		expect(bodies).toEqual([undefined]);
	});

	test("gets undefined for a body that is not JSON, and passthrough still returns the response", async () => {
		const bodies: unknown[] = [];
		const server = setup([new Response("upstream down", { status: 400 })], {
			errors: "passthrough",
			refineError: (error, body) => {
				bodies.push(body);
				return error;
			},
		});
		const response = await server.fetch(`${BASE}/v1/boxes/b1`);
		expect(response.status).toBe(400);
		expect(await response.text()).toBe("upstream down");
		expect(bodies).toEqual([undefined]);
		expect(server.ctx.lastFailure?.status).toBe(400);
	});
});
