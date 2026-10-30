// Server conformance for the Notify slice. It runs the real in-process Notify
// service (`createNotifyService` from apps/notify/src/service.ts, with an
// in-memory SQLite store, so no Docker and no credentials) and routes the
// SDK's fetch straight to `service.fetch`. Test-only relative imports: the
// published SDK never depends on apps/notify.
//
// The recorded fixtures in test/fixtures/notify/*.json are the fallback for a
// future Notify that cannot run in-process; here they are replayed through
// the SDK too, and checked against the live service's response shape so they
// cannot silently drift.

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	createNotifyService,
	type NotifyService,
	type NotifyServiceOptions,
} from "../../../../apps/notify/src/service.ts";
import { NotifyStore } from "../../../../apps/notify/src/store.ts";
import type { RyuRetryEvent } from "../../src/config.ts";
import {
	isRyuError,
	RyuConflictError,
	type RyuError,
	RyuInvalidRequestError,
	RyuNotFoundError,
	RyuRateLimitError,
} from "../../src/errors.ts";
import { NOTIFY_ERROR_CODES } from "../../src/notify/codes.ts";
import { NOTIFY_ROUTES } from "../../src/notify/routes.ts";
import { Ryu } from "../../src/ryu.ts";
import { newIdempotencyKey } from "../../src/transport/idempotency.ts";

const NOTIFY_SRC = resolve(import.meta.dir, "../../../../apps/notify/src");
const FIXTURES = resolve(import.meta.dir, "../fixtures/notify");
const ORIGIN = "http://notify.test";
const TOKEN = "conformance-tenant-secret-0001";
const ENV = { RYU_NOTIFY_API_KEY: TOKEN, RYU_NOTIFY_URL: ORIGIN };

interface Harness {
	advance(ms: number): void;
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
	service: NotifyService;
}

const open: NotifyService[] = [];

afterEach(() => {
	for (const service of open.splice(0)) {
		service.close();
	}
});

/** The setup of apps/notify/src/service.test.ts, with the SDK's fetch routed in-process. */
function harness(
	overrides: Partial<Pick<NotifyServiceOptions, "publishRateLimit">> = {}
): Harness {
	let current = new Date("2026-10-01T00:00:00.000Z");
	const service = createNotifyService({
		apiKeys: new Map([[TOKEN, "acme"]]),
		deliveryPollMs: 0,
		now: () => current,
		store: new NotifyStore(":memory:"),
		...overrides,
	});
	open.push(service);
	return {
		advance(ms) {
			current = new Date(current.getTime() + ms);
		},
		fetch: (input, init) => service.fetch(new Request(input, init)),
		service,
	};
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
	throw new Error("expected the call to reject");
}

/** The members of `export type NotifyErrorCode = | "a" | "b" ...;` in apps/notify/src/errors.ts. */
function serverErrorCodes(): string[] {
	const source = readFileSync(resolve(NOTIFY_SRC, "errors.ts"), "utf8");
	const union = /export type NotifyErrorCode\s*=([^;]+);/u.exec(source)?.[1];
	if (!union) {
		throw new Error("NotifyErrorCode union not found in apps/notify");
	}
	return [...union.matchAll(/"([a-z_]+)"/gu)].map((match) => match[1] ?? "");
}

describe("Notify conformance: codes and routes", () => {
	test("codes.ts equals the NotifyErrorCode union", () => {
		expect<string[]>([...NOTIFY_ERROR_CODES]).toEqual(serverErrorCodes());
	});

	test("the route table matches the server's Idempotency-Key call sites", () => {
		const source = readFileSync(resolve(NOTIFY_SRC, "service.ts"), "utf8");
		const reads = source.match(/headers\.get\("idempotency-key"\)/gu) ?? [];
		// publishEvent (events and topics) and the activity create.
		expect(reads).toHaveLength(2);
		expect(source).toContain(
			"POST /v1/activities requires an Idempotency-Key header."
		);
		expect(NOTIFY_ROUTES.idempotent.filter((route) => route.required)).toEqual([
			{ method: "POST", path: "/v1/activities", required: true },
		]);
	});

	test("every table route dedupes by key in-process; a non-table POST does not", async () => {
		const notify = harness();
		const post = (path: string, body: unknown, key?: string) => {
			const headers = new Headers({
				authorization: `Bearer ${TOKEN}`,
				"content-type": "application/json",
			});
			if (key !== undefined) {
				headers.set("idempotency-key", key);
			}
			return notify.service.fetch(
				new Request(`${ORIGIN}${path}`, {
					body: JSON.stringify(body),
					headers,
					method: "POST",
				})
			);
		};
		const concrete: Record<string, string> = {
			"/v1/events": "/v1/events",
			"/v1/topics/{topic}": "/v1/topics/builds",
			"/v1/activities": "/v1/activities",
		};
		expect(NOTIFY_ROUTES.idempotent.map((route) => route.path).sort()).toEqual(
			Object.keys(concrete).sort()
		);
		for (const route of NOTIFY_ROUTES.idempotent) {
			const path = concrete[route.path] ?? "";
			const key = `route-${route.path}`;
			const first = await post(path, { title: "t" }, key);
			const second = await post(path, { title: "t" }, key);
			expect(`${route.path} ${first.status}`).toBe(`${route.path} 201`);
			expect(`${route.path} ${second.status}`).toBe(`${route.path} 200`);
			expect(
				((await second.json()) as { idempotent?: unknown }).idempotent
			).toBe(true);
			if (route.required) {
				const keyless = await post(path, { title: "t" });
				expect(`${route.path} ${keyless.status}`).toBe(`${route.path} 400`);
			} else {
				// Without a key the server publishes twice: the key is optional, not implied.
				const a = await post(path, { title: "keyless" });
				const b = await post(path, { title: "keyless" });
				expect([a.status, b.status]).toEqual([201, 201]);
			}
		}
		const created = (await (
			await post("/v1/events", { title: "ack" })
		).json()) as {
			event: { id: string };
		};
		const ackPath = `/v1/events/${created.event.id}/ack`;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const ack = await post(ackPath, {}, "ack-key");
			expect(ack.status).toBe(200);
			const body = (await ack.json()) as { idempotent?: unknown };
			expect(body.idempotent).toBeUndefined();
		}
	});

	test("SDK keys fit Notify's 128-character limit", () => {
		for (let index = 0; index < 20; index += 1) {
			const key = newIdempotencyKey();
			expect(key.length).toBeGreaterThan(0);
			expect(key.length).toBeLessThanOrEqual(128);
		}
	});
});

describe("Notify conformance: in-process service", () => {
	test("an auto key, then a replay with that key, reports idempotent:true", async () => {
		const notify = harness();
		const ryu = new Ryu({ env: ENV, fetch: notify.fetch, result: "object" });
		const first = await ryu.notify.publish({
			title: "Deploy finished",
			level: "success",
		});
		expect(first.error).toBeNull();
		expect(first.meta?.status).toBe(201);
		expect(first.meta?.replayed).toBe(false);
		const key = first.meta?.idempotencyKey;
		expect(typeof key).toBe("string");

		const replay = await ryu.notify
			.with({ idempotencyKey: key ?? "" })
			.publish({ title: "Deploy finished", level: "success" });
		expect(replay.meta?.status).toBe(200);
		expect(replay.meta?.replayed).toBe(true);
		expect(replay.data?.id).toBe(first.data?.id ?? "missing");
		expect(replay.meta?.requestId).toMatch(/^req_/u);
	});

	test("the same key with a different body is a RyuConflictError (idempotency_conflict)", async () => {
		const notify = harness();
		const ryu = new Ryu({ env: ENV, fetch: notify.fetch });
		await ryu.notify
			.with({ idempotencyKey: "deploy-4821" })
			.publish({ title: "Deployed" });
		const error = await rejection(
			ryu.notify
				.with({ idempotencyKey: "deploy-4821" })
				.publish({ title: "Deploy failed" })
		);
		expect(error).toBeInstanceOf(RyuConflictError);
		expect(error.code).toBe("idempotency_conflict");
		expect(error.status).toBe(409);
		// The SDK asks for problem+json, which Notify now negotiates.
		expect(error.envelope).toBe("problem+json");
		expect(error.type).toBe(
			"https://docs.ryuhq.com/docs/standalone/notify-api#idempotency_conflict"
		);
		expect(error.requestId).toMatch(/^req_/u);
		expect(error.idempotencyKey).toBe("deploy-4821");
		expect(error.attempts).toBe(1);
	});

	test("429 rate_limited is retried after Retry-After with the same key", async () => {
		const notify = harness({ publishRateLimit: { burst: 1, perSecond: 1 } });
		const retries: RyuRetryEvent[] = [];
		const ryu = new Ryu({
			env: ENV,
			fetch: notify.fetch,
			result: "object",
			hooks: {
				onRetry(event) {
					retries.push(event);
					// The service clock refills the bucket over the wait the SDK honours.
					notify.advance(event.delayMs);
				},
			},
		});
		expect((await ryu.notify.publish({ title: "first" })).error).toBeNull();
		const second = await ryu.notify.publish({ title: "second" });
		expect(second.error).toBeNull();
		expect(second.meta?.status).toBe(201);
		expect(second.meta?.attempts).toBe(2);
		expect(retries).toHaveLength(1);
		expect(retries[0]).toMatchObject({
			code: "rate_limited",
			delayMs: 1000,
			status: 429,
		});
	});

	test("a 429 longer than maxRetryDelayMs surfaces as RyuRateLimitError", async () => {
		const notify = harness({
			publishRateLimit: { burst: 1, perSecond: 0.001 },
		});
		const ryu = new Ryu({ env: ENV, fetch: notify.fetch });
		await ryu.notify.publish({ title: "first" });
		const error = await rejection(ryu.notify.publish({ title: "second" }));
		expect(error).toBeInstanceOf(RyuRateLimitError);
		expect(error.code).toBe("rate_limited");
		expect(error.retryAfterSeconds).toBe(1000);
		expect(error.attempts).toBe(1);
	});

	test("events.list pagination: events.iterate walks every page", async () => {
		const notify = harness();
		const ryu = new Ryu({ env: ENV, fetch: notify.fetch });
		const published: string[] = [];
		for (let index = 0; index < 5; index += 1) {
			notify.advance(1000);
			published.push((await ryu.notify.publish({ title: `e${index}` })).id);
		}
		const firstPage = await ryu.notify.events.list({ limit: 2 });
		expect(firstPage.events).toHaveLength(2);
		expect(firstPage.nextCursor).not.toBeNull();

		const iterated = ryu.notify.events.iterate({ limit: 2 });
		const pages: number[] = [];
		for await (const page of iterated.pages()) {
			pages.push(page.events.length);
		}
		expect(pages).toEqual([2, 2, 1]);
		const all = await ryu.notify.events.iterate({ limit: 2 }).collect();
		expect(all.map((item) => item.id)).toEqual([...published].reverse());
	});

	test("a bad cursor is RyuInvalidRequestError, a missing event RyuNotFoundError", async () => {
		const notify = harness();
		const ryu = new Ryu({ env: ENV, fetch: notify.fetch });
		const cursor = await rejection(
			ryu.notify.events.list({ before: "not-a-cursor" })
		);
		expect(cursor).toBeInstanceOf(RyuInvalidRequestError);
		expect(cursor.code).toBe("invalid_cursor");
		const missing = await rejection(ryu.notify.events.get("evt_missing"));
		expect(missing).toBeInstanceOf(RyuNotFoundError);
		expect(missing.message).toBe("Event not found.");
	});

	test("activities.create sends the required key; a replay is idempotent", async () => {
		const notify = harness();
		const ryu = new Ryu({ env: ENV, fetch: notify.fetch, result: "object" });
		const first = await ryu.notify.activities.create(
			{ title: "Build" },
			"build-77"
		);
		const again = await ryu.notify.activities.create(
			{ title: "Build" },
			"build-77"
		);
		expect(first.meta?.status).toBe(201);
		expect(again.meta?.replayed).toBe(true);
		expect(again.data?.id).toBe(first.data?.id ?? "missing");
	});

	test("requestApproval resolves once the event is answered", async () => {
		const notify = harness();
		const ryu = new Ryu({ env: ENV, fetch: notify.fetch });
		const answered = ryu.notify.requestApproval(
			{ title: "Ship v2?", prompt: "Ship build 184?", timeoutMs: 60_000 },
			{
				pollIntervalMs: 250,
				onPublished: (event) => {
					void ryu.notify.events.respond(event.id, { status: "approved" });
				},
			}
		);
		const result = await answered;
		expect(result).toMatchObject({
			approved: true,
			status: "approved",
			timedOut: false,
		});
		expect(result.event.response?.type).toBe("approval");
	});
});

interface Fixture {
	body: Record<string, unknown>;
	headers: Record<string, string>;
	status: number;
}

function fixture(name: string): Fixture {
	return JSON.parse(
		readFileSync(resolve(FIXTURES, `${name}.json`), "utf8")
	) as Fixture;
}

function replay(fixtures: readonly string[]) {
	let index = 0;
	return async (): Promise<Response> => {
		const next = fixture(fixtures[Math.min(index, fixtures.length - 1)] ?? "");
		index += 1;
		return Response.json(next.body, {
			headers: next.headers,
			status: next.status,
		});
	};
}

/**
 * The keys of `value`, recursively; values are ignored. An array becomes the
 * sorted distinct shapes of all its items, so every item is compared.
 */
function shape(value: unknown): unknown {
	if (Array.isArray(value)) {
		const variants = new Map<string, unknown>();
		for (const item of value) {
			const itemShape = shape(item);
			variants.set(JSON.stringify(itemShape), itemShape);
		}
		return [...variants.keys()].sort().map((key) => variants.get(key));
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, shape((value as Record<string, unknown>)[key])])
		);
	}
	return value === null ? "null" : typeof value;
}

describe("Notify conformance: recorded fixtures", () => {
	test("every fixture is listed here", () => {
		expect(
			readdirSync(FIXTURES)
				.filter((name) => name.endsWith(".json"))
				.sort()
		).toEqual([
			"events-page-1.json",
			"events-page-2.json",
			"fallthrough.json",
			"publish-conflict.json",
			"publish-created.json",
			"publish-rate-limited.json",
			"publish-replayed.json",
		]);
	});

	test("fixtures still match the live service's response shape", async () => {
		const call = (notify: Harness, path: string, init: RequestInit = {}) => {
			const headers = new Headers(init.headers);
			headers.set("authorization", `Bearer ${TOKEN}`);
			return notify.service.fetch(
				new Request(`${ORIGIN}${path}`, { ...init, headers })
			);
		};
		const post = (notify: Harness, key: string, body: unknown) =>
			call(notify, "/v1/events", {
				body: JSON.stringify(body),
				headers: { "content-type": "application/json", "idempotency-key": key },
				method: "POST",
			});
		const unlimited = harness();
		const limited = harness({ publishRateLimit: { burst: 1, perSecond: 1 } });
		const live: Record<string, Response> = {
			"publish-created": await post(unlimited, "shape-1", { title: "a" }),
			"publish-replayed": await post(unlimited, "shape-1", { title: "a" }),
			"publish-conflict": await post(unlimited, "shape-1", { title: "b" }),
		};
		await post(unlimited, "shape-2", { title: "c" });
		live["events-page-1"] = await call(unlimited, "/v1/events?limit=1");
		const firstPage = (await live["events-page-1"].clone().json()) as {
			nextCursor: string | null;
		};
		expect(typeof firstPage.nextCursor).toBe("string");
		live["events-page-2"] = await call(
			unlimited,
			`/v1/events?limit=1&before=${encodeURIComponent(firstPage.nextCursor ?? "")}`
		);
		live.fallthrough = await call(unlimited, "/v1/nope");
		await post(limited, "shape-3", { title: "d" });
		live["publish-rate-limited"] = await post(limited, "shape-4", {
			title: "e",
		});
		expect(Object.keys(live).sort()).toEqual(
			readdirSync(FIXTURES)
				.filter((name) => name.endsWith(".json"))
				.map((name) => name.slice(0, -".json".length))
				.sort()
		);
		for (const [name, response] of Object.entries(live)) {
			const recorded = fixture(name);
			expect(`${name} ${response.status}`).toBe(`${name} ${recorded.status}`);
			expect(shape(await response.json())).toEqual(shape(recorded.body));
		}
	});

	test("the fall-through fixture is the router's unmatched-route answer", () => {
		const fallthrough = fixture("fallthrough");
		expect(fallthrough.status).toBe(404);
		expect(fallthrough.body).toMatchObject({
			code: "not_found",
			message: "Not found.",
			type: "notify.error",
		});
	});

	test("replayed fixtures decode through the SDK: created, replay, conflict", async () => {
		const ryu = new Ryu({
			env: ENV,
			fetch: replay([
				"publish-created",
				"publish-replayed",
				"publish-conflict",
			]),
			result: "object",
		});
		const created = await ryu.notify.publish({ title: "Deploy finished" });
		expect(created.meta?.replayed).toBe(false);
		const replayed = await ryu.notify.publish({ title: "Deploy finished" });
		expect(replayed.meta?.replayed).toBe(true);
		expect(replayed.data?.id).toBe(created.data?.id ?? "missing");
		const conflict = await ryu.notify.publish({ title: "Deploy failed" });
		expect(conflict.error).toBeInstanceOf(RyuConflictError);
		expect(conflict.error?.code).toBe("idempotency_conflict");
		expect(conflict.error?.requestId).toBe(
			fixture("publish-conflict").headers["x-request-id"] ?? "missing"
		);
	});

	test("the rate-limited fixture carries Retry-After, which the SDK honours", async () => {
		const retries: RyuRetryEvent[] = [];
		const ryu = new Ryu({
			env: ENV,
			fetch: replay(["publish-rate-limited", "publish-created"]),
			hooks: { onRetry: (event) => retries.push(event) },
			result: "object",
		});
		const result = await ryu.notify.publish({ title: "Third" });
		expect(result.error).toBeNull();
		expect(result.meta?.attempts).toBe(2);
		expect(retries.map((event) => event.delayMs)).toEqual([1000]);
	});

	test("the recorded pages iterate through the SDK", async () => {
		const ryu = new Ryu({
			env: ENV,
			fetch: replay(["events-page-1", "events-page-2"]),
		});
		const events = await ryu.notify.events.iterate({ limit: 2 }).collect();
		const page1 = fixture("events-page-1").body.events as unknown[];
		const page2 = fixture("events-page-2").body.events as unknown[];
		expect(events).toHaveLength(page1.length + page2.length);
	});
});
