import { describe, expect, test } from "bun:test";
import {
	BoxError,
	errorResponse as boxErrorResponse,
} from "../../../apps/box/src/errors.ts";
import {
	NotifyError,
	errorResponse as notifyErrorResponse,
} from "../../../apps/notify/src/errors.ts";
import {
	isRyuError,
	RyuAbortError,
	RyuAuthenticationError,
	RyuConfigurationError,
	type RyuError,
	RyuNotFoundError,
	RyuQuotaExceededError,
	RyuResponseValidationError,
	RyuUnavailableError,
} from "./errors.ts";
import { toResult } from "./result.ts";
import { Ryu } from "./ryu.ts";

interface Recorded {
	headers: Headers;
	method: string;
	url: string;
}

function stubFetch(
	respond: (request: Recorded) => Response | Promise<Response>
) {
	const calls: Recorded[] = [];
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = {
			headers: new Headers(init?.headers),
			method: init?.method ?? "GET",
			url: String(input),
		};
		calls.push(request);
		return respond(request);
	};
	return { calls, fetch };
}

const EVENT = {
	acknowledgedAt: null,
	actions: [],
	archivedAt: null,
	attachment: null,
	body: "",
	createdAt: "2026-10-01T00:00:00Z",
	data: {},
	externalId: null,
	fingerprint: null,
	icon: null,
	id: "evt_1",
	level: "success",
	occurredAt: "2026-10-01T00:00:00Z",
	priority: 3,
	project: null,
	recipient: null,
	response: null,
	source: "api",
	tags: [],
	title: "Deploy finished",
	topic: null,
	type: "notification",
	url: null,
};

const NOTIFY_ENV = {
	RYU_NOTIFY_API_KEY: "notify_key",
	RYU_NOTIFY_URL: "http://127.0.0.1:8092",
};

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

/** A fetch stub that never answers on its own and rejects once its signal aborts. */
function hangingFetch() {
	const calls: string[] = [];
	const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push(String(input));
		return new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			if (signal?.aborted) {
				reject(new DOMException("aborted", "AbortError"));
				return;
			}
			signal?.addEventListener("abort", () =>
				reject(new DOMException("aborted", "AbortError"))
			);
		});
	};
	return { calls, fetch };
}

async function rejection(promise: PromiseLike<unknown>): Promise<RyuError> {
	try {
		await promise;
	} catch (error) {
		if (isRyuError(error)) {
			return error;
		}
		throw error;
	}
	throw new Error("expected a rejection");
}

describe("lazy configuration", () => {
	test("constructing does nothing; the first call fails with an error naming the env var", async () => {
		const { calls, fetch } = stubFetch(() => Response.json({}));
		const ryu = new Ryu({ env: {}, fetch });
		const error = await rejection(ryu.notify.publish({ title: "x" }));
		expect(error).toBeInstanceOf(RyuConfigurationError);
		// Notify's URL defaults to the hosted origin; its key has no default.
		expect(error.message).toContain("RYU_NOTIFY_API_KEY");
		expect(error.details).toEqual({
			missing: ["RYU_NOTIFY_API_KEY"],
		});
		expect(calls).toHaveLength(0);
	});

	test("an unawaited config failure raises no unhandled rejection, and iterating it throws", async () => {
		const ryu = new Ryu({ env: {} });
		ryu.notify.publish({ title: "ignored" });
		const iterate = async () => {
			for await (const _item of ryu.notify.events.stream()) {
				// unreachable
			}
		};
		await expect(iterate()).rejects.toBeInstanceOf(RyuConfigurationError);
	});

	test("object mode returns config errors instead of throwing", async () => {
		const ryu = new Ryu({ env: {}, result: "object" });
		const result = await ryu.notify.publish({ title: "x" });
		expect(result.data).toBeNull();
		expect(result.error).toBeInstanceOf(RyuConfigurationError);
		expect(result.meta).toBeNull();
	});

	test("an unknown method fails with unknown_method", async () => {
		const ryu = new Ryu({
			env: NOTIFY_ENV,
			fetch: stubFetch(() => Response.json({})).fetch,
		});
		const notify = ryu.notify as unknown as { nope(): Promise<unknown> };
		expect((await rejection(notify.nope())).code).toBe("unknown_method");
	});
});

describe("results", () => {
	test("throw mode returns data; object mode returns { data, error, meta }", async () => {
		const respond = () =>
			Response.json(
				{ event: EVENT },
				{ headers: { "x-request-id": "req_pub" }, status: 201 }
			);
		const thrower = new Ryu({
			env: NOTIFY_ENV,
			fetch: stubFetch(respond).fetch,
		});
		expect(
			(await thrower.notify.publish({ title: "Deploy finished" })).id
		).toBe("evt_1");

		const objects = new Ryu({
			env: NOTIFY_ENV,
			fetch: stubFetch(respond).fetch,
			result: "object",
		});
		const result = await objects.notify.publish({ title: "Deploy finished" });
		expect(result.error).toBeNull();
		expect(result.data?.id).toBe("evt_1");
		expect(result.meta).toMatchObject({
			attempts: 1,
			requestId: "req_pub",
			status: 201,
		});
		expect(result.meta?.idempotencyKey).toBeTruthy();
	});

	test("ryu.safe gives the object form for one call in throw mode", async () => {
		const { fetch } = stubFetch((request) =>
			request.url.endsWith("/v1/events/missing")
				? notifyErrorResponse(
						new NotifyError("not_found", "No such event.", 404),
						"req_404"
					)
				: Response.json({ event: EVENT })
		);
		const ryu = new Ryu({ env: NOTIFY_ENV, fetch });
		const found = await ryu.safe.notify.events.get("evt_1");
		expect(found.data?.id).toBe("evt_1");
		const missing = await ryu.safe.notify.events.get("missing");
		expect(missing.data).toBeNull();
		expect(missing.error).toBeInstanceOf(RyuNotFoundError);
		expect(missing.meta?.status).toBe(404);
		expect(missing.meta?.requestId).toBe("req_404");
		expect(ryu.safe.notify).toBe(ryu.safe.notify);
	});

	test("toResult reads the call's meta; Notify replays come from the body's `idempotent`", async () => {
		// apps/notify/src/service.ts answers a replay with `idempotent: true` and no header.
		const { fetch } = stubFetch(() =>
			Response.json({
				event: EVENT,
				idempotent: true,
				ok: true,
				requestId: "req_1",
				type: "event.existing",
			})
		);
		const ryu = new Ryu({ env: NOTIFY_ENV, fetch });
		const result = await toResult(ryu.notify.publish({ title: "x" }));
		expect(result.meta?.replayed).toBe(true);
		expect(result.data?.id).toBe("evt_1");
	});

	test("a first Notify write reports replayed: false", async () => {
		const { fetch } = stubFetch(() =>
			Response.json({ event: EVENT, idempotent: false, ok: true })
		);
		const ryu = new Ryu({ env: NOTIFY_ENV, fetch });
		const result = await ryu.safe.notify.publish({ title: "x" });
		expect(result.meta?.replayed).toBe(false);
		expect(result.data?.id).toBe("evt_1");
	});

	test("aborting a Notify stream mid-body ends it with RyuAbortError", async () => {
		const controller = new AbortController();
		const fetch = (_input: RequestInfo | URL, init?: RequestInit) =>
			Promise.resolve(
				new Response(
					new ReadableStream({
						start(stream) {
							init?.signal?.addEventListener("abort", () =>
								stream.error(new DOMException("aborted", "AbortError"))
							);
						},
					}),
					{ headers: { "content-type": "text/event-stream" } }
				)
			);
		const ryu = new Ryu({ env: NOTIFY_ENV, fetch });
		const iterator = ryu.notify
			.with({ signal: controller.signal })
			.stream()
			[Symbol.asyncIterator]();
		const next = iterator.next();
		setTimeout(() => controller.abort(), 5);
		const error = await within(next).then(
			() => null,
			(failure: unknown) => failure
		);
		expect(error).toBeInstanceOf(RyuAbortError);
	});

	test("a malformed 2xx body is a RyuResponseValidationError", async () => {
		const { fetch } = stubFetch(() => Response.json({ event: { id: 1 } }));
		const ryu = new Ryu({ env: NOTIFY_ENV, fetch });
		const error = await rejection(ryu.notify.events.get("evt_1"));
		expect(error).toBeInstanceOf(RyuResponseValidationError);
		expect(error.code).toBe("invalid_response");
	});
});

describe("typed errors from wrapped clients", () => {
	test("Notify surfaces typed codes, not plain Error strings", async () => {
		const { fetch } = stubFetch(() =>
			notifyErrorResponse(
				new NotifyError("invalid_request", "title is required.", 400),
				"req_n"
			)
		);
		const ryu = new Ryu({ env: NOTIFY_ENV, fetch });
		const error = await rejection(ryu.notify.publish({ title: "" }));
		expect(error.code).toBe("invalid_request");
		expect(error.requestId).toBe("req_n");
		expect(error.message).toBe("title is required.");
		expect(error.message).not.toContain("Ryu Notify:");
	});

	test("Box surfaces typed codes and quota errors are not retried", async () => {
		const { calls, fetch } = stubFetch(() =>
			boxErrorResponse(
				new BoxError("quota_exceeded", "Quota reached.", 429),
				"req_b"
			)
		);
		const ryu = new Ryu({
			env: { RYU_BOX_API_KEY: "box_key", RYU_BOX_URL: "http://127.0.0.1:8090" },
			fetch,
		});
		const error = await rejection(
			ryu.box.create({ name: "build", size: "small" })
		);
		expect(error).toBeInstanceOf(RyuQuotaExceededError);
		expect(error.code).toBe("quota_exceeded");
		expect(calls).toHaveLength(1);
	});
});

describe("Managed Agents (passthrough)", () => {
	const MA_ENV = { RYU_API_KEY: "ryu_test_key", RYU_ORGANIZATION_ID: "org_1" };

	test("sends x-api-key and X-Ryu-Organization to the control plane", async () => {
		const { calls, fetch } = stubFetch(() =>
			Response.json({ data: [], hasMore: false, nextCursor: null })
		);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		await ryu.managedAgents.agents.list().catch(() => undefined);
		expect(calls[0]?.url).toStartWith(
			"https://api.ryuhq.com/api/v1/managed-agents/agents"
		);
		expect(calls[0]?.headers.get("x-api-key")).toBe("ryu_test_key");
		expect(calls[0]?.headers.get("x-ryu-organization")).toBe("org_1");
		expect(calls[0]?.headers.has("authorization")).toBe(false);
	});

	test("a stream that gets a 401 throws RyuAuthenticationError after exactly one fetch", async () => {
		const { calls, fetch } = stubFetch(() =>
			Response.json(
				{
					error: {
						code: "unauthenticated",
						message: "Invalid API key.",
						requestId: "req_401",
					},
				},
				{ headers: { "WWW-Authenticate": 'Bearer realm="ryu"' }, status: 401 }
			)
		);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const consume = async () => {
			for await (const _event of ryu.managedAgents.sessions.stream("s_1")) {
				// unreachable
			}
		};
		const error = await consume().then(
			() => {
				throw new Error("expected the stream to fail");
			},
			(failure: unknown) => failure as RyuError
		);
		expect(error).toBeInstanceOf(RyuAuthenticationError);
		expect(error.code).toBe("unauthenticated");
		expect(error.requestId).toBe("req_401");
		expect(error.envelope).toBe("managed-agents");
		expect(error.url).toBe(
			"https://api.ryuhq.com/api/v1/managed-agents/sessions/s_1/stream"
		);
		expect(calls).toHaveLength(1);
	});

	test(".with({ signal }) already aborted ends a stream with RyuAbortError and no fetch", async () => {
		const { calls, fetch } = hangingFetch();
		const controller = new AbortController();
		controller.abort();
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const stream = ryu.managedAgents
			.with({ signal: controller.signal })
			.sessions.stream("s_1");
		const error = await within(stream.next()).then(
			() => null,
			(failure: unknown) => failure
		);
		expect(error).toBeInstanceOf(RyuAbortError);
		expect(calls).toHaveLength(0);
	});

	test("aborting .with({ signal }) mid-stream ends it with RyuAbortError instead of reconnecting", async () => {
		const { calls, fetch } = hangingFetch();
		const controller = new AbortController();
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const consume = async () => {
			for await (const _event of ryu.managedAgents
				.with({ signal: controller.signal })
				.sessions.stream("s_1")) {
				// unreachable
			}
		};
		const done = consume().then(
			() => null,
			(failure: unknown) => failure
		);
		setTimeout(() => controller.abort(), 5);
		const error = await within(done);
		expect(error).toBeInstanceOf(RyuAbortError);
		expect((error as RyuError).service).toBe("managedAgents");
		// Give a reconnect loop a chance to show itself.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(calls).toHaveLength(1);
	});

	test("503 managed_agents_disabled is not retried and maps to RyuUnavailableError", async () => {
		const { calls, fetch } = stubFetch(() =>
			Response.json(
				{
					error: {
						code: "managed_agents_disabled",
						message: "Off.",
						requestId: "req_off",
					},
				},
				{ headers: { "Retry-After": "1" }, status: 503 }
			)
		);
		const ryu = new Ryu({ env: MA_ENV, fetch });
		const error = await rejection(ryu.managedAgents.sessions.get("s_1"));
		expect(error).toBeInstanceOf(RyuUnavailableError);
		expect(error.code).toBe("managed_agents_disabled");
		expect(calls).toHaveLength(1);
	});
});

describe("per-call options", () => {
	test(".with({ idempotencyKey }) reaches the wire", async () => {
		const { calls, fetch } = stubFetch(() => Response.json({ event: EVENT }));
		const ryu = new Ryu({ env: NOTIFY_ENV, fetch });
		await ryu.notify
			.with({ idempotencyKey: "deploy-4821" })
			.publish({ title: "Deployed" });
		await ryu.notify.publish({ title: "Again" });
		expect(calls[0]?.headers.get("idempotency-key")).toBe("deploy-4821");
		expect(calls[1]?.headers.get("idempotency-key")).not.toBe("deploy-4821");
	});

	test("a stored .with({ idempotencyKey }) namespace spends its key on the first write", async () => {
		const { calls, fetch } = stubFetch(() => Response.json({ event: EVENT }));
		const ryu = new Ryu({ env: NOTIFY_ENV, fetch });
		const bound = ryu.notify.with({ idempotencyKey: "deploy-4821" });
		await bound.getEvent("evt_1");
		await bound.publish({ title: "First" });
		// Reads after the write still work through the bound namespace.
		await bound.getEvent("evt_1");
		const error = await rejection(bound.publish({ title: "Second" }));
		expect(error).toBeInstanceOf(RyuConfigurationError);
		expect(error.code).toBe("idempotency_key_reused");
		// Rebinding the same key is how a caller retries the same operation.
		await ryu.notify
			.with({ idempotencyKey: "deploy-4821" })
			.publish({ title: "First" });
		expect(calls.map((call) => call.method)).toEqual([
			"GET",
			"POST",
			"GET",
			"POST",
		]);
	});

	test(".with() headers and timeouts compose", async () => {
		const { calls, fetch } = stubFetch(() => Response.json({ event: EVENT }));
		const ryu = new Ryu({ env: NOTIFY_ENV, fetch });
		await ryu.notify
			.with({ headers: { "x-a": "1" } })
			.with({ headers: { "x-b": "2" }, timeoutMs: 1000 })
			.getEvent("evt_1");
		expect(calls[0]?.headers.get("x-a")).toBe("1");
		expect(calls[0]?.headers.get("x-b")).toBe("2");
	});

	test("RYU_API_KEY is never sent to Notify", async () => {
		const { calls, fetch } = stubFetch(() => Response.json({ event: EVENT }));
		const ryu = new Ryu({
			env: { ...NOTIFY_ENV, RYU_API_KEY: "ryu_secret" },
			fetch,
		});
		await ryu.notify.events.get("evt_1");
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer notify_key");
		expect([...(calls[0]?.headers.values() ?? [])].join(" ")).not.toContain(
			"ryu_secret"
		);
	});

	test("hooks observe requests and responses", async () => {
		const seen: string[] = [];
		const { fetch } = stubFetch(() => Response.json({ event: EVENT }));
		const ryu = new Ryu({
			env: NOTIFY_ENV,
			fetch,
			hooks: {
				onRequest: (event) =>
					seen.push(`request ${event.method} ${event.attempt}`),
				onResponse: (event) => seen.push(`response ${event.status}`),
			},
		});
		await ryu.notify.events.get("evt_1");
		expect(seen).toEqual(["request GET 1", "response 200"]);
	});
});

describe("misc", () => {
	test("webhooks.verify dispatches to the webhooks module", async () => {
		const ryu = new Ryu({ env: {} });
		const error = await rejection(
			ryu.webhooks.verify({
				headers: {},
				payload: "{}",
				secret: "whsec_x",
				service: "mail",
			})
		);
		expect(error.service).toBe("mail");
	});

	test("webhooks.verify resolves to { data, error, meta } in object mode", async () => {
		const ryu = new Ryu({ env: {}, result: "object" });
		const result = await ryu.webhooks.verify({
			headers: {},
			payload: "{}",
			secret: "whsec_x",
			service: "mail",
		});
		expect(result.data).toBeNull();
		expect(result.error?.code).toBe("webhook_missing_headers");
	});

	test("iterate exposes the pagination helper", async () => {
		const ryu = new Ryu({ env: {} });
		const items = await ryu
			.iterate<number[], number>({
				fetchPage: () => Promise.resolve([1, 2]),
				items: (page) => page,
				nextCursor: () => null,
			})
			.collect();
		expect(items).toEqual([1, 2]);
	});

	test("resultMode reports the option", () => {
		expect(new Ryu({ env: {} }).resultMode).toBe("throw");
		expect(new Ryu({ env: {}, result: "object" }).resultMode).toBe("object");
	});
});
