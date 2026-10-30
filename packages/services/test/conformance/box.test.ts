// Server conformance for the Box slice. It runs the real Box service
// in-process (`createBoxService` from apps/box) with the filesystem driver in a
// temp directory and an in-memory store: no Docker, no network, no
// credentials. The SDK's fetch is routed straight to `service.fetch`.
//
// apps/box is imported at runtime by computed path, in this test only: the
// published SDK never depends on it, and its sources are not part of this
// package's type check. The service needs neither Docker nor credentials, so
// a failure to load it fails this file loudly instead of falling back: a
// silent fallback would turn the live checks into no-ops. The recorded
// responses in test/fixtures/box/*.json are used only on request
// (`RYU_SERVICES_BOX_FIXTURES=1 bun test test/conformance/box.test.ts`), and a
// drift test keeps them in step with the live service.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RyuFetch } from "@ryuhq/client";
import { commandParts } from "../../src/box/helpers.ts";
import {
	isRyuError,
	RyuNotFoundError,
	RyuQuotaExceededError,
} from "../../src/errors.ts";
import { Ryu } from "../../src/ryu.ts";
import { newIdempotencyKey } from "../../src/transport/idempotency.ts";

const BOX_SRC = resolve(import.meta.dir, "../../../../apps/box/src");
const FIXTURES = resolve(import.meta.dir, "../fixtures/box");
const TENANT_KEY = "conformance-tenant-key";
const BASE = "http://box.test";

/** The parts of apps/box this test uses. */
interface BoxServiceLike {
	close(): void;
	fetch(request: Request): Promise<Response>;
}
interface BoxModules {
	BoxStore: new (path: string) => unknown;
	createBoxService(options: {
		admission?: { maxActiveBoxesPerTenant?: number };
		apiKeys: ReadonlyMap<string, string>;
		driver: unknown;
		store: unknown;
	}): BoxServiceLike;
	FilesystemDriver: new (options: {
		allowUnsafeHostExec: boolean;
		root: string;
	}) => unknown;
	parseCommandRequest(value: unknown): { args: string[]; command: string };
}

interface Fixture {
	body: Record<string, unknown>;
	request: { method: string; path: string };
	status: number;
}

const roots: string[] = [];

async function loadBoxModules(): Promise<BoxModules> {
	const load = (name: string) =>
		import(join(BOX_SRC, name)) as Promise<Record<string, unknown>>;
	try {
		const [service, store, driver, contracts] = await Promise.all([
			load("service.ts"),
			load("store.ts"),
			load("drivers/filesystem.ts"),
			load("contracts.ts"),
		]);
		return {
			createBoxService: service.createBoxService,
			BoxStore: store.BoxStore,
			FilesystemDriver: driver.FilesystemDriver,
			parseCommandRequest: contracts.parseCommandRequest,
		} as BoxModules;
	} catch (error) {
		throw new Error(
			`Box conformance: apps/box failed to load from ${BOX_SRC}. Fix it, or set RYU_SERVICES_BOX_FIXTURES=1 to run against the recordings on purpose.`,
			{ cause: error }
		);
	}
}

/** `RYU_SERVICES_BOX_FIXTURES=1` forces the recorded fallback, to test it. */
const FIXTURES_FORCED = process.env.RYU_SERVICES_BOX_FIXTURES === "1";
const modules = FIXTURES_FORCED ? null : await loadBoxModules();

function fixture(name: string): Fixture {
	return JSON.parse(
		readFileSync(join(FIXTURES, `${name}.json`), "utf8")
	) as Fixture;
}

/**
 * A stand-in for the service built from the recordings: it answers the
 * requests the recordings cover, with one-Box quota and key replay.
 */
function fixtureServer(): (request: Request) => Promise<Response> {
	const keys = new Map<string, string>();
	return async (request) => {
		const { pathname } = new URL(request.url);
		const reply = (name: string) => {
			const { body, status } = fixture(name);
			return Response.json(body, {
				status,
				headers: {
					"x-request-id":
						typeof body.requestId === "string"
							? body.requestId
							: "req_00000000000000000000000000000001",
				},
			});
		};
		if (request.method === "POST" && pathname === "/v1/boxes") {
			const key = request.headers.get("idempotency-key") ?? "";
			const body = await request.text();
			if (keys.get(key) === body) {
				return reply("create-replay-200");
			}
			if (keys.size > 0) {
				return reply("create-quota-exceeded-429");
			}
			keys.set(key, body);
			return reply("create-201");
		}
		if (
			request.method === "POST" &&
			pathname === fixture("exec-200").request.path
		) {
			const { stream } = (await request.json()) as { stream?: boolean };
			return stream ? streamReply(fixture("exec-200")) : reply("exec-200");
		}
		return reply("get-not-found-404");
	};
}

/**
 * The streamed form of a recorded command answer, built from its result the
 * way the service streams it: a frame per output stream, then `exit`.
 */
function streamReply({ body }: Fixture): Response {
	const result = body.result as {
		durationMs: number;
		exitCode: number;
		stderr: string;
		stdout: string;
	};
	const frames = [
		["stdout", { data: result.stdout }],
		["stderr", { data: result.stderr }],
		[
			"exit",
			{
				durationMs: result.durationMs,
				exitCode: result.exitCode,
				status: "exited",
			},
		],
	] as const;
	return new Response(
		frames
			.map(
				([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
			)
			.join(""),
		{ headers: { "content-type": "text/event-stream" } }
	);
}

/** One fresh server (live when apps/box loads, recorded otherwise) and a Ryu wired to it. */
function server(options: { maxActiveBoxesPerTenant?: number } = {}) {
	let handle: (request: Request) => Promise<Response>;
	let close: () => void = () => undefined;
	if (modules) {
		const root = mkdtempSync(join(tmpdir(), "ryu-services-box-"));
		roots.push(root);
		const service = modules.createBoxService({
			...(options.maxActiveBoxesPerTenant === undefined
				? {}
				: {
						admission: {
							maxActiveBoxesPerTenant: options.maxActiveBoxesPerTenant,
						},
					}),
			apiKeys: new Map([[TENANT_KEY, "tenant-conformance"]]),
			driver: new modules.FilesystemDriver({ allowUnsafeHostExec: true, root }),
			store: new modules.BoxStore(":memory:"),
		});
		handle = (request) => service.fetch(request);
		close = () => service.close();
	} else {
		handle = fixtureServer();
	}
	const requests: Request[] = [];
	const fetch: RyuFetch = (input, init) => {
		const request = new Request(input, init);
		requests.push(request.clone());
		return handle(request);
	};
	const env = { RYU_BOX_URL: BASE, RYU_BOX_API_KEY: TENANT_KEY };
	return {
		close,
		raw: handle,
		requests,
		ryu: new Ryu({ env, fetch }),
		safe: new Ryu({ env, fetch, result: "object" }),
	};
}

afterAll(() => {
	for (const root of roots) {
		rmSync(root, { force: true, recursive: true });
	}
});

describe(`Box conformance (${modules ? "in-process service" : "recorded fixtures"})`, () => {
	test("create returns a typed Box with the SDK's key", async () => {
		const box = server();
		const { data, error, meta } = await box.safe.box.create({
			name: "conformance",
		});
		expect(error).toBeNull();
		expect(data?.id).toMatch(/^bx_[0-9a-f]{32}$/u);
		expect(data?.status).toBe("ready");
		expect(data?.name).toBe("conformance");
		expect(meta?.status).toBe(201);
		expect(meta?.idempotencyKey).toBe(
			box.requests[0]?.headers.get("idempotency-key") ?? null
		);
		expect(meta?.requestId).toMatch(/^req_/u);
		box.close();
	});

	test("replaying the same idempotency key returns 200 and the same Box", async () => {
		const box = server();
		const key = `conformance-${newIdempotencyKey()}`;
		const first = await box.safe.box
			.with({ idempotencyKey: key })
			.create({ name: "conformance" });
		const replay = await box.safe.box
			.with({ idempotencyKey: key })
			.create({ name: "conformance" });
		expect(first.meta?.status).toBe(201);
		expect(replay.error).toBeNull();
		expect(replay.meta?.status).toBe(200);
		expect(replay.data?.id).toBe(first.data?.id as string);
		expect(first.meta?.replayed).toBe(false);
		expect(replay.meta?.replayed).toBe(true);
		box.close();
	});

	test("quota_exceeded is a RyuQuotaExceededError with its details, sent once", async () => {
		const box = server({ maxActiveBoxesPerTenant: 1 });
		await box.ryu.box.create({ name: "first" });
		const before = box.requests.length;
		const { error } = await box.safe.box.create({ name: "second" });
		expect(error).toBeInstanceOf(RyuQuotaExceededError);
		expect(error?.code).toBe("quota_exceeded");
		expect(error?.status).toBe(429);
		expect(error?.retryable).toBe(false);
		expect(error?.details).toMatchObject({ resource: "boxes", limit: 1 });
		expect(box.requests.length - before).toBe(1);
		box.close();
	});

	test("the Box error code, message and request id are exposed on RyuError", async () => {
		const box = server();
		try {
			await box.ryu.box.get("bx_ffffffffffffffffffffffffffffffff");
			throw new Error("expected not_found");
		} catch (error) {
			expect(isRyuError(error)).toBe(true);
			expect(error).toBeInstanceOf(RyuNotFoundError);
			const ryuError = error as RyuNotFoundError;
			expect(ryuError.code).toBe("not_found");
			expect(ryuError.message).toBe("Box not found.");
			expect(ryuError.requestId).toMatch(/^req_[0-9a-f]{32}$/u);
			// The SDK asks for problem+json; the recordings predate it.
			if (modules) {
				expect(ryuError.envelope).toBe("problem+json");
				expect(ryuError.type).toBe(
					"https://docs.ryuhq.com/docs/standalone/box-api#not_found"
				);
				expect(ryuError.docs).toBe(ryuError.type as string);
			} else {
				expect(ryuError.envelope).toBe("ryu-service");
				expect(ryuError.type).toBe("box.error");
			}
		}
		box.close();
	});

	test("the legacy envelope still maps when the caller asks for application/json", async () => {
		const box = server();
		const { error } = await box.safe.box
			.with({ headers: { accept: "application/json" } })
			.get("bx_ffffffffffffffffffffffffffffffff");
		expect(box.requests[0]?.headers.get("accept")).toBe("application/json");
		expect(error).toBeInstanceOf(RyuNotFoundError);
		expect(error?.code).toBe("not_found");
		expect(error?.envelope).toBe("ryu-service");
		expect(error?.type).toBe("box.error");
		expect(error?.requestId).toMatch(/^req_[0-9a-f]{32}$/u);
		box.close();
	});

	test.if(modules !== null)(
		"a replay carries Idempotent-Replayed: true, which meta.replayed reports",
		async () => {
			const box = server();
			const key = `conformance-${newIdempotencyKey()}`;
			const first = await box.raw(
				new Request(`${BASE}/v1/boxes`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${TENANT_KEY}`,
						"content-type": "application/json",
						"idempotency-key": key,
					},
					body: JSON.stringify({ name: "conformance" }),
				})
			);
			expect(first.headers.get("idempotent-replayed")).toBeNull();
			const rawReplay = await box.raw(
				new Request(`${BASE}/v1/boxes`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${TENANT_KEY}`,
						"content-type": "application/json",
						"idempotency-key": key,
					},
					body: JSON.stringify({ name: "conformance" }),
				})
			);
			expect(rawReplay.headers.get("idempotent-replayed")).toBe("true");
			const replay = await box.safe.box
				.with({ idempotencyKey: key })
				.create({ name: "conformance" });
			expect(replay.meta?.replayed).toBe(true);
			box.close();
		}
	);

	test("box.run creates, waits and execs against the service", async () => {
		const box = server();
		const run = await box.ryu.box.run(
			{ name: "conformance", command: ["echo", "hi"] },
			{ pollIntervalMs: 5 }
		);
		expect(run.box.status).toBe("ready");
		expect(run.result.exitCode).toBe(0);
		expect(run.result.stdout).toBe("hi\n");
		box.close();
	});
});

describe("Box conformance mode", () => {
	test("runs against the in-process service unless the recordings were asked for", () => {
		expect(modules === null).toBe(FIXTURES_FORCED);
	});

	test("commandParts survives the service's command-line parser", () => {
		if (!modules) {
			expect(FIXTURES_FORCED).toBe(true);
			return;
		}
		const cases: (readonly string[])[] = [
			["node", "-v"],
			["/opt/my app/run", "a b"],
			["it's", "x"],
			['quote"and\\slash', "--flag=a b"],
		];
		for (const command of cases) {
			const parsed = modules.parseCommandRequest(
				commandParts(command, undefined)
			);
			expect([parsed.command, ...parsed.args]).toEqual([...command]);
		}
	});
});

describe("Box recorded fixtures", () => {
	test("cover every case the fixture server answers", () => {
		expect(
			readdirSync(FIXTURES)
				.filter((name) => name.endsWith(".json"))
				.sort()
		).toEqual([
			"create-201.json",
			"create-quota-exceeded-429.json",
			"create-replay-200.json",
			"exec-200.json",
			"get-not-found-404.json",
		]);
	});

	test("have the same shape as the live service's answers", async () => {
		if (!modules) {
			// Only when the recordings were asked for: nothing live to compare against.
			expect(FIXTURES_FORCED).toBe(true);
			return;
		}
		const live = server({ maxActiveBoxesPerTenant: 1 });
		const send = (path: string, init?: RequestInit) =>
			sendRaw(live, path, init);
		const created = await send("/v1/boxes", {
			method: "POST",
			headers: { "idempotency-key": "drift-key-1" },
			body: JSON.stringify({ name: "conformance" }),
		});
		const boxId = String((created.body.box as { id: string }).id);
		const observed: Record<string, { body: unknown; status: number }> = {
			"create-201": created,
			"create-replay-200": await send("/v1/boxes", {
				method: "POST",
				headers: { "idempotency-key": "drift-key-1" },
				body: JSON.stringify({ name: "conformance" }),
			}),
			"create-quota-exceeded-429": await send("/v1/boxes", {
				method: "POST",
				headers: { "idempotency-key": "drift-key-2" },
				body: JSON.stringify({ name: "second" }),
			}),
			"exec-200": await send(`/v1/boxes/${boxId}/commands`, {
				method: "POST",
				body: JSON.stringify({ command: "echo", args: ["hi"] }),
			}),
			"get-not-found-404": await send(
				"/v1/boxes/bx_ffffffffffffffffffffffffffffffff"
			),
		};
		for (const [name, actual] of Object.entries(observed)) {
			const recorded = fixture(name);
			expect({ name, status: actual.status }).toEqual({
				name,
				status: recorded.status,
			});
			expect({ name, shape: shape(actual.body) }).toEqual({
				name,
				shape: shape(recorded.body),
			});
		}
		live.close();
	});
});

/** Sends one request straight to the server's handler, bypassing the SDK. */
async function sendRaw(
	live: ReturnType<typeof server>,
	path: string,
	init: RequestInit = {}
): Promise<{ body: Record<string, unknown>; status: number }> {
	const headers = new Headers(init.headers);
	headers.set("authorization", `Bearer ${TENANT_KEY}`);
	headers.set("content-type", "application/json");
	const response = await live.raw(
		new Request(`${BASE}${path}`, { ...init, headers })
	);
	return {
		body: (await response.json()) as Record<string, unknown>,
		status: response.status,
	};
}

/** Field names and JSON types, recursively; values are ignored. */
function shape(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.length === 0 ? [] : [shape(value[0])];
	}
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, item]) => [key, shape(item)])
		);
	}
	return value === null ? "null" : typeof value;
}
