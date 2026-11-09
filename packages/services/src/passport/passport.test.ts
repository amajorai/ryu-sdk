import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	isRyuError,
	messageWithoutHint,
	RyuAuthenticationError,
	RyuConfigurationError,
	type RyuError,
	RyuInvalidRequestError,
	RyuNotFoundError,
	RyuPaymentRequiredError,
	RyuRateLimitError,
	RyuResponseValidationError,
	RyuServerError,
	RyuUnavailableError,
} from "../errors.ts";
import { Ryu } from "../ryu.ts";
import {
	PASSPORT_IDEMPOTENCY_CAPABILITY,
	PASSPORT_ROUTES,
	PASSPORT_SDK_ROUTES,
} from "./routes.ts";

interface Recorded {
	body: string | null;
	headers: Headers;
	method: string;
	signal?: AbortSignal | null;
	url: string;
}

type Respond = (request: Recorded) => Response | Promise<Response>;

function stubFetch(respond: Respond) {
	const calls: Recorded[] = [];
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const body = init?.body;
		const recorded: Recorded = {
			body: typeof body === "string" ? body : null,
			headers: new Headers(init?.headers),
			method: init?.method ?? "GET",
			signal: init?.signal,
			url: String(input),
		};
		calls.push(recorded);
		return await respond(recorded);
	};
	return { calls, fetch };
}

const BASE = "http://127.0.0.1:8093";
const ADMIN = "passport-admin-token-0123456789";
const RUNTIME = "passport-runtime-token-0123456789";
const ENV = {
	RYU_PASSPORT_API_KEY: ADMIN,
	RYU_PASSPORT_RUNTIME_KEY: RUNTIME,
	RYU_PASSPORT_URL: BASE,
};

const CONNECTION = {
	created_at: 1_760_000_000,
	domain: "github.com",
	flow_status: "IDLE",
	id: "conn_0123456789abcdef",
	last_checked: 0,
	profile_id: "work",
	source: "manual",
	status: "NEEDS_AUTH",
	updated_at: 1_760_000_000,
};

function client(respond: Respond, env: Record<string, string> = ENV) {
	const stub = stubFetch(respond);
	const ryu = new Ryu({
		env,
		fetch: stub.fetch,
		maxRetries: 2,
		maxRetryDelayMs: 50,
	});
	return { ...stub, ryu };
}

/** The POST requests a stub saw (the capabilities probe is a GET). */
function posts(calls: readonly Recorded[]): Recorded[] {
	return calls.filter((call) => call.method === "POST");
}

/** The probes a stub saw. */
function probes(calls: readonly Recorded[]): Recorded[] {
	return calls.filter(
		(call) => new URL(call.url).pathname === "/v1/capabilities"
	);
}

/** `GET /v1/capabilities` as apps/passport/src/lib.rs answers it. */
function capabilities(features: Record<string, boolean>): Response {
	return Response.json({ api_version: "v1", features, service: "passport" });
}

/** A Passport that advertises `features.idempotency_keys: true`. */
const NEW_FEATURES = { idempotency_keys: true, profiles: true };
/** An older Passport: no `idempotency_keys` flag, and it ignores the header. */
const OLD_FEATURES = { authenticated_fetch: true, profiles: true };

async function failure(promise: Promise<unknown>): Promise<RyuError> {
	try {
		await promise;
	} catch (error) {
		if (isRyuError(error)) {
			return error;
		}
		throw error;
	}
	throw new Error("expected the call to fail");
}

describe("Passport route table", () => {
	test("keys no route unconditionally; the create is gated on features.idempotency_keys", () => {
		expect(PASSPORT_ROUTES.idempotent).toEqual([]);
		expect(PASSPORT_ROUTES.mount).toBe("");
		expect(PASSPORT_ROUTES.capabilityIdempotent).toEqual([
			{
				capability: "idempotency_keys",
				method: "POST",
				path: "/v1/connections",
				required: false,
			},
		]);
		expect(PASSPORT_IDEMPOTENCY_CAPABILITY).toBe("idempotency_keys");
	});

	test("the gated capability is the flag apps/passport advertises and the header it reads", () => {
		const root = resolve(import.meta.dir, "../../../../apps/passport/src");
		const lib = readFileSync(resolve(root, "lib.rs"), "utf8");
		expect(lib).toContain(`"${PASSPORT_IDEMPOTENCY_CAPABILITY}": true`);
		const idempotency = readFileSync(resolve(root, "idempotency.rs"), "utf8");
		expect(idempotency).toContain(
			'IDEMPOTENCY_HEADER: &str = "idempotency-key"'
		);
		expect(idempotency).toContain("idempotency_in_progress");
	});

	test("lists every route the client calls, with the runtime routes on the runtime grant", () => {
		const runtime = PASSPORT_SDK_ROUTES.filter((route) =>
			route.path.startsWith("/v1/runtime/")
		);
		expect(runtime.every((route) => route.credential === "runtime")).toBe(true);
		expect(
			new Set(PASSPORT_SDK_ROUTES.map((r) => `${r.method} ${r.path}`))
		).toHaveProperty("size", PASSPORT_SDK_ROUTES.length);
	});
});

describe("ryu.passport", () => {
	test("reads with the administration key and keeps the wire casing", async () => {
		const { calls, ryu } = client((request) => {
			const path = new URL(request.url).pathname;
			if (path === "/v1/capabilities") {
				return Response.json({
					api_version: "v1",
					features: { authenticated_fetch: true, profiles: true },
					service: "passport",
				});
			}
			if (path === "/v1/profiles") {
				return Response.json({
					profiles: [{ connections: [CONNECTION], profile_id: "work" }],
				});
			}
			if (path === `/v1/connections/${CONNECTION.id}`) {
				return Response.json({
					connection: CONNECTION,
					flow_status: "IDLE",
					status: "NEEDS_AUTH",
				});
			}
			return Response.json({ connections: [CONNECTION] });
		});
		const capabilities = await ryu.passport.capabilities();
		expect(capabilities.api_version).toBe("v1");
		const profiles = await ryu.passport.profiles.list();
		expect(profiles.profiles[0]?.connections[0]?.profile_id).toBe("work");
		const listed = await ryu.passport.connections.list();
		expect(listed.connections[0]?.flow_status).toBe("IDLE");
		const detail = await ryu.passport.connections.get(CONNECTION.id);
		expect(detail.connection.created_at).toBe(1_760_000_000);
		expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
			`GET ${BASE}/v1/capabilities`,
			`GET ${BASE}/v1/profiles`,
			`GET ${BASE}/v1/connections`,
			`GET ${BASE}/v1/connections/${CONNECTION.id}`,
		]);
		for (const call of calls) {
			expect(call.headers.get("authorization")).toBe(`Bearer ${ADMIN}`);
			expect(call.headers.get("idempotency-key")).toBeNull();
		}
	});

	test("creates a connection with the snake_case body and, on an older Passport, no Idempotency-Key", async () => {
		const { calls, ryu } = client((request) =>
			request.method === "GET"
				? capabilities(OLD_FEATURES)
				: Response.json({ connection: CONNECTION }, { status: 201 })
		);
		const created = await ryu.passport.connections.create({
			domain: "github.com",
			profile_id: "work",
		});
		expect(created.connection.id).toBe(CONNECTION.id);
		expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
		expect(calls[0]?.url).toBe(`${BASE}/v1/capabilities`);
		expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${ADMIN}`);
		expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({
			domain: "github.com",
			profile_id: "work",
		});
		expect(calls[1]?.headers.get("idempotency-key")).toBeNull();
	});

	for (const status of [502, 503]) {
		test(`does not retry a POST create on ${status}`, async () => {
			const { calls, ryu } = client(() =>
				Response.json(
					{ error: "upstream unavailable" },
					// A zero wait, so only the method keeps the SDK from retrying.
					{ status, headers: { "retry-after": "0" } }
				)
			);
			const error = await failure(
				ryu.passport.connections.create({
					domain: "github.com",
					profile_id: "work",
				})
			);
			// The capabilities probe failed too, so the create is unkeyed: one POST.
			expect(posts(calls)).toHaveLength(1);
			expect(posts(calls)[0]?.headers.get("idempotency-key")).toBeNull();
			expect(error.status).toBe(status);
			expect(error.attempts).toBe(1);
		});
	}

	test("retries a GET on 503 but not a POST fetch", async () => {
		let reads = 0;
		const read = client(() => {
			reads += 1;
			return reads === 1
				? new Response("", { status: 503, headers: { "retry-after": "0" } })
				: Response.json({ connections: [] });
		});
		await read.ryu.passport.connections.list();
		expect(read.calls).toHaveLength(2);

		const fetchCall = client(
			() => new Response("", { status: 503, headers: { "retry-after": "0" } })
		);
		const error = await failure(
			fetchCall.ryu.passport.connections.fetch(CONNECTION.id, {
				url: "https://github.com/settings",
			})
		);
		expect(error).toBeInstanceOf(RyuUnavailableError);
		expect(fetchCall.calls).toHaveLength(1);
	});

	test("sends the runtime key on /v1/runtime/* and the runtime fetch", async () => {
		const { calls, ryu } = client((request) =>
			new URL(request.url).pathname.endsWith("/fetch")
				? Response.json({
						authenticated: true,
						content: '{"login":"octocat"}',
						status: 200,
						truncated: false,
					})
				: Response.json({ connections: [CONNECTION] })
		);
		const listed = await ryu.passport.runtime.connections.list();
		expect(listed.connections).toHaveLength(1);
		const fetched = await ryu.passport.runtime.connections.fetch(
			CONNECTION.id,
			{ url: "https://api.github.com/user" }
		);
		expect(fetched.content).toContain("octocat");
		expect(calls[0]?.url).toBe(`${BASE}/v1/runtime/connections`);
		expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${RUNTIME}`);
		expect(calls[1]?.url).toBe(`${BASE}/v1/connections/${CONNECTION.id}/fetch`);
		expect(calls[1]?.headers.get("authorization")).toBe(`Bearer ${RUNTIME}`);
		expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({
			url: "https://api.github.com/user",
		});
	});

	test("the administration fetch keeps the administration key", async () => {
		const { calls, ryu } = client(() =>
			Response.json({
				authenticated: false,
				content: "",
				status: 402,
				truncated: false,
				wwwAuthenticate: ['Payment realm="api"'],
			})
		);
		const result = await ryu.passport.connections.fetch(CONNECTION.id, {
			maxContentChars: 100,
			url: "https://github.com/",
		});
		expect(result.wwwAuthenticate).toEqual(['Payment realm="api"']);
		expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${ADMIN}`);
	});

	test("a runtime call without a runtime key fails before any request", async () => {
		const { calls, ryu } = client(() => Response.json({}), {
			RYU_PASSPORT_API_KEY: ADMIN,
			RYU_PASSPORT_URL: BASE,
		});
		const error = await failure(ryu.passport.runtime.connections.list());
		expect(error).toBeInstanceOf(RyuConfigurationError);
		expect(error.details).toEqual({ missing: ["RYU_PASSPORT_RUNTIME_KEY"] });
		const fetchError = await failure(
			ryu.passport.runtime.connections.fetch(CONNECTION.id, {
				url: "https://github.com/",
			})
		);
		expect(fetchError.code).toBe("configuration_error");
		expect(calls).toHaveLength(0);
	});

	test("login, delete and usage use the server's routes and casing", async () => {
		const { calls, ryu } = client((request) => {
			const path = new URL(request.url).pathname;
			if (path.endsWith("/login")) {
				return Response.json({
					flow_id: "flow_1",
					kind: { kind: "hosted", url: "https://login.example.com/start" },
				});
			}
			if (request.method === "DELETE") {
				return Response.json({ deleted: true, id: CONNECTION.id });
			}
			return Response.json({
				from: "2026-10-01T00:00:00Z",
				meters: { connectionSeconds: 7200, fetches: 3 },
				ok: true,
				to: "2026-10-01T02:00:00Z",
				type: "usage.report",
			});
		});
		const flow = await ryu.passport.connections.login(CONNECTION.id);
		expect(flow.kind).toEqual({
			kind: "hosted",
			url: "https://login.example.com/start",
		});
		const deleted = await ryu.passport.connections.delete(CONNECTION.id);
		expect(deleted.deleted).toBe(true);
		const usage = await ryu.passport.usage({
			from: "2026-10-01T00:00:00Z",
			to: "2026-10-01T02:00:00Z",
		});
		expect(usage.meters.connectionSeconds).toBe(7200);
		expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
			`POST ${BASE}/v1/connections/${CONNECTION.id}/login`,
			`DELETE ${BASE}/v1/connections/${CONNECTION.id}`,
			`GET ${BASE}/v1/usage?from=2026-10-01T00%3A00%3A00Z&to=2026-10-01T02%3A00%3A00Z`,
		]);
	});

	test("importState completes a manual login: create, login, import, then fetch", async () => {
		let imported = false;
		const { calls, ryu } = client((request) => {
			const path = new URL(request.url).pathname;
			if (path === "/v1/capabilities") {
				return capabilities(OLD_FEATURES);
			}
			if (path === "/v1/connections") {
				return Response.json({ connection: CONNECTION }, { status: 201 });
			}
			if (path.endsWith("/login")) {
				return Response.json({ flow_id: "flow_1", kind: { kind: "manual" } });
			}
			if (path.endsWith("/import")) {
				imported = true;
				// apps/passport/src/lib.rs import_connection: status metadata only.
				return Response.json({
					connection: {
						...CONNECTION,
						flow_status: "DONE",
						status: "AUTHENTICATED",
					},
					flow_status: "DONE",
					status: "AUTHENTICATED",
				});
			}
			if (!imported) {
				return Response.json(
					{
						error: "Connection requires authentication",
						type: "conflict",
					},
					{ status: 409 }
				);
			}
			return Response.json({
				authenticated: true,
				content: "ok",
				status: 200,
				truncated: false,
			});
		});
		const created = await ryu.passport.connections.create({
			domain: "github.com",
			profile_id: "work",
		});
		expect(created.connection.status).toBe("NEEDS_AUTH");
		const flow = await ryu.passport.connections.login(created.connection.id);
		expect(flow.kind).toEqual({ kind: "manual" });
		const detail = await ryu.passport.connections.importState(
			created.connection.id,
			{ state: "session=abc123" }
		);
		expect(detail.status).toBe("AUTHENTICATED");
		expect(detail.flow_status).toBe("DONE");
		const page = await ryu.passport.connections.fetch(created.connection.id, {
			url: "https://github.com/",
		});
		expect(page.authenticated).toBe(true);

		const importCall = posts(calls).find((call) =>
			call.url.endsWith("/import")
		);
		expect(importCall?.url).toBe(
			`${BASE}/v1/connections/${CONNECTION.id}/import`
		);
		expect(importCall?.headers.get("authorization")).toBe(`Bearer ${ADMIN}`);
		expect(importCall?.headers.get("idempotency-key")).toBeNull();
		expect(JSON.parse(importCall?.body ?? "null")).toEqual({
			state: "session=abc123",
		});
	});

	test("importState needs the administration key and is never retried", async () => {
		const runtimeOnly = client(() => Response.json({}), {
			RYU_PASSPORT_RUNTIME_KEY: RUNTIME,
			RYU_PASSPORT_URL: BASE,
		});
		const missing = await failure(
			runtimeOnly.ryu.passport.connections.importState(CONNECTION.id, {
				state: "session=abc123",
			})
		);
		expect(missing).toBeInstanceOf(RyuConfigurationError);
		expect(runtimeOnly.calls).toHaveLength(0);

		const flaky = client(() =>
			Response.json({ error: "boom", type: "internal" }, { status: 503 })
		);
		const error = await failure(
			flaky.ryu.passport.connections.importState(CONNECTION.id, {
				state: "session=abc123",
			})
		);
		expect(error.status).toBe(503);
		expect(flaky.calls).toHaveLength(1);
	});

	test("importState refuses a missing or non-string state before any request", async () => {
		const { calls, ryu } = client(() => Response.json({}));
		for (const [input, details] of [
			[{}, { missing: ["state"] }],
			[{ state: null }, { missing: ["state"] }],
			[{ state: 42 }, { invalid: ["state"] }],
		] as const) {
			const error = await failure(
				ryu.passport.connections.importState(
					CONNECTION.id,
					input as unknown as { state: string }
				)
			);
			expect(error).toBeInstanceOf(RyuInvalidRequestError);
			expect(error.code).toBe("invalid_request");
			expect(error.details).toEqual(details);
		}
		expect(calls).toHaveLength(0);
	});

	test("encodes connection ids in the path", async () => {
		const { calls, ryu } = client(() =>
			Response.json({
				connection: CONNECTION,
				flow_status: "IDLE",
				status: "NEEDS_AUTH",
			})
		);
		await ryu.passport.connections.get("conn/../x");
		expect(calls[0]?.url).toBe(`${BASE}/v1/connections/conn%2F..%2Fx`);
	});

	test("a dot-segment connection id is refused before any request", async () => {
		const { calls, ryu } = client(() => Response.json({}));
		for (const id of ["..", ".", ""]) {
			const error = await failure(ryu.passport.connections.delete(id));
			expect(error).toBeInstanceOf(RyuInvalidRequestError);
			expect(error.code).toBe("invalid_id");
		}
		expect(calls).toHaveLength(0);
	});

	test("usage() without a window names from and to before any request", async () => {
		const { calls, ryu } = client(() => Response.json({}));
		const usage = ryu.passport.usage as (query?: unknown) => Promise<unknown>;
		const error = await failure(usage());
		expect(error).toBeInstanceOf(RyuInvalidRequestError);
		expect(error.code).toBe("invalid_request");
		expect(error.details).toEqual({ missing: ["from", "to"] });
		expect(calls).toHaveLength(0);
	});
});

describe("Passport errors", () => {
	test("402 {ok,code,error,message} is RyuPaymentRequiredError with the code", async () => {
		const { calls, ryu } = client(() =>
			Response.json(
				{
					code: "insufficient_credits",
					error: "insufficient_credits",
					message: "This organization has no Ryu credits left.",
					ok: false,
				},
				{ status: 402 }
			)
		);
		const error = await failure(
			ryu.passport.connections.create({
				domain: "a.example.com",
				profile_id: "p",
			})
		);
		expect(error).toBeInstanceOf(RyuPaymentRequiredError);
		expect(error.code).toBe("insufficient_credits");
		expect(error.message).toBe("This organization has no Ryu credits left.");
		expect(error.envelope).toBe("code-error");
		expect(posts(calls)).toHaveLength(1);
	});

	test("503 metering_unavailable is RyuUnavailableError and a POST is not retried", async () => {
		const { calls, ryu } = client(() =>
			Response.json(
				{
					code: "metering_unavailable",
					error: "metering_unavailable",
					message: "Passport cannot record usage right now.",
					ok: false,
				},
				{ status: 503 }
			)
		);
		const error = await failure(
			ryu.passport.connections.fetch(CONNECTION.id, {
				url: "https://a.example.com/",
			})
		);
		expect(error).toBeInstanceOf(RyuUnavailableError);
		expect(error.code).toBe("metering_unavailable");
		expect(error.retryable).toBe(false);
		expect(calls).toHaveLength(1);
	});

	test("400 invalid_request from usage keeps its code", async () => {
		const { ryu } = client(() =>
			Response.json(
				{
					code: "invalid_request",
					error: "invalid_request",
					message: "from must be on a whole hour",
					ok: false,
				},
				{ status: 400 }
			)
		);
		const error = await failure(
			ryu.passport.usage({ from: "x", to: "2026-10-01T01:00:00Z" })
		);
		expect(error).toBeInstanceOf(RyuInvalidRequestError);
		expect(error.code).toBe("invalid_request");
	});

	test("401 {error} prose is RyuAuthenticationError with the status code", async () => {
		const { ryu } = client(() =>
			Response.json({ error: "Passport API token is invalid" }, { status: 401 })
		);
		const error = await failure(ryu.passport.connections.list());
		expect(error).toBeInstanceOf(RyuAuthenticationError);
		expect(error.code).toBe("unauthenticated");
		expect(messageWithoutHint(error)).toBe("Passport API token is invalid");
		expect(error.envelope).toBe("error-string");
	});

	test("an empty 404 is RyuNotFoundError", async () => {
		const { ryu } = client(() => new Response(null, { status: 404 }));
		const error = await failure(ryu.passport.connections.get("conn_missing"));
		expect(error).toBeInstanceOf(RyuNotFoundError);
		expect(error.code).toBe("not_found");
		expect(error.envelope).toBe("empty");
	});

	test("a text 500 is RyuServerError carrying the text", async () => {
		const { ryu } = client(
			() =>
				new Response("Passport could not complete the request", { status: 500 })
		);
		const error = await failure(ryu.passport.capabilities());
		expect(error).toBeInstanceOf(RyuServerError);
		expect(error.envelope).toBe("text");
		expect(error.message).toContain("could not complete");
	});

	test("429 with Retry-After is retried, also for a POST", async () => {
		let attempts = 0;
		const { calls, ryu } = client(() => {
			attempts += 1;
			return attempts === 1
				? Response.json(
						{ error: "Too many failed authentication attempts" },
						{ status: 429, headers: { "retry-after": "0" } }
					)
				: Response.json({ connection: CONNECTION }, { status: 201 });
		});
		await ryu.passport.connections.create({
			domain: "github.com",
			profile_id: "work",
		});
		expect(calls).toHaveLength(2);
	});

	test("a persistent 429 surfaces as RyuRateLimitError", async () => {
		const { ryu } = client(() =>
			Response.json(
				{ error: "Too many failed authentication attempts" },
				{ status: 429, headers: { "retry-after": "600" } }
			)
		);
		const error = await failure(ryu.passport.connections.list());
		expect(error).toBeInstanceOf(RyuRateLimitError);
		expect(error.retryAfterSeconds).toBe(600);
	});

	test("a malformed 2xx body is RyuResponseValidationError", async () => {
		const { ryu } = client(() => Response.json({ connections: "nope" }));
		const error = await failure(ryu.passport.connections.list());
		expect(error).toBeInstanceOf(RyuResponseValidationError);
	});

	test("object mode returns { data, error, meta }", async () => {
		const stub = stubFetch(() => new Response(null, { status: 404 }));
		const ryu = new Ryu({ env: ENV, fetch: stub.fetch, result: "object" });
		const { data, error, meta } = await ryu.passport.connections.get("conn_x");
		expect(data).toBeNull();
		expect(error?.code).toBe("not_found");
		expect(meta?.status).toBe(404);
	});
});

/** `ryu.passport` configured with a URL and a runtime grant but no administration key. */
function runtimeOnly(respond: Respond) {
	const { calls, ryu } = client(respond, {
		RYU_PASSPORT_RUNTIME_KEY: RUNTIME,
		RYU_PASSPORT_URL: BASE,
	});
	return { calls, passport: ryu.passport };
}

describe("Passport with only a runtime grant", () => {
	test("runtime calls work and send only the runtime grant", async () => {
		const { calls, passport } = runtimeOnly((request) =>
			new URL(request.url).pathname.endsWith("/fetch")
				? Response.json({
						authenticated: true,
						content: "{}",
						status: 200,
						truncated: false,
					})
				: Response.json({ connections: [CONNECTION] })
		);
		const listed = await passport.runtime.connections.list();
		expect(listed.connections).toHaveLength(1);
		await passport.runtime.connections.fetch(CONNECTION.id, {
			url: "https://api.github.com/user",
		});
		expect(await passport.runtime.connections.hasRuntimeGrant()).toBe(true);
		expect(calls.map((call) => call.headers.get("authorization"))).toEqual([
			`Bearer ${RUNTIME}`,
			`Bearer ${RUNTIME}`,
		]);
	});

	test("an administration call fails before any request, naming RYU_PASSPORT_API_KEY", async () => {
		const { calls, passport } = runtimeOnly(() => Response.json({}));
		for (const call of [
			() => passport.connections.list(),
			() => passport.profiles.list(),
			() => passport.capabilities(),
			() =>
				passport.connections.create({ domain: "a.example", profile_id: "p" }),
			() =>
				passport.connections.fetch(CONNECTION.id, {
					url: "https://a.example/",
				}),
		]) {
			const error = await failure(call());
			expect(error).toBeInstanceOf(RyuConfigurationError);
			expect(error.details).toEqual({ missing: ["RYU_PASSPORT_API_KEY"] });
		}
		expect(calls).toHaveLength(0);
	});
});

describe("runtime.connections.hasRuntimeGrant()", () => {
	test("resolves true or false from the config without a request", async () => {
		const withGrant = client(() => Response.json({}));
		expect(
			await withGrant.ryu.passport.runtime.connections.hasRuntimeGrant()
		).toBe(true);
		const adminOnly = client(() => Response.json({}), {
			RYU_PASSPORT_API_KEY: ADMIN,
			RYU_PASSPORT_URL: BASE,
		});
		expect(
			await adminOnly.ryu.passport.runtime.connections.hasRuntimeGrant()
		).toBe(false);
		// The deprecated alias answers the same.
		expect(
			await withGrant.ryu.passport.runtime.connections.isConfigured()
		).toBe(true);
		expect(withGrant.calls).toHaveLength(0);
		expect(adminOnly.calls).toHaveLength(0);
	});

	test("is never a truthy value when Passport is not configured", async () => {
		const { calls, ryu } = client(() => Response.json({}), {});
		const error = await failure(
			ryu.passport.runtime.connections.hasRuntimeGrant()
		);
		expect(error).toBeInstanceOf(RyuConfigurationError);
		expect(error.details).toMatchObject({
			missing: expect.arrayContaining(["RYU_PASSPORT_URL"]),
		});
		const safe = new Ryu({ env: {}, result: "object" });
		const result = await safe.passport.runtime.connections.hasRuntimeGrant();
		expect(result.data).toBeNull();
		expect(result.error?.code).toBe("configuration_error");
		expect(calls).toHaveLength(0);
	});
});

/**
 * A client whose backoff fits `maxRetryDelayMs`, so a network failure or
 * timeout on a replay-safe request really is retried (the default test client
 * caps waits at 50 ms, below the SDK's first backoff of 250 to 500 ms).
 */
function retryingClient(respond: Respond, timeoutMs = 1000) {
	const stub = stubFetch(respond);
	const ryu = new Ryu({
		env: ENV,
		fetch: stub.fetch,
		maxRetries: 1,
		maxRetryDelayMs: 1000,
		timeoutMs,
	});
	return { ...stub, ryu };
}

describe("Passport writes on a network failure", () => {
	test("a create that hits a network error is sent once", async () => {
		const { calls, ryu } = retryingClient(() => {
			throw new TypeError("fetch failed");
		});
		const error = await failure(
			ryu.passport.connections.create({
				domain: "github.com",
				profile_id: "work",
			})
		);
		expect(error.status).toBe(0);
		expect(error.code).toBe("connection_error");
		expect(posts(calls)).toHaveLength(1);
	});

	test("a fetch that times out is sent once", async () => {
		const stub = stubFetch(
			(request) =>
				new Promise<Response>((_resolve, reject) => {
					request.signal?.addEventListener("abort", () =>
						reject(request.signal?.reason)
					);
				})
		);
		const ryu = new Ryu({
			env: ENV,
			fetch: stub.fetch,
			maxRetries: 1,
			maxRetryDelayMs: 1000,
			timeoutMs: 20,
		});
		const error = await failure(
			ryu.passport.runtime.connections.fetch(CONNECTION.id, {
				url: "https://api.github.com/user",
			})
		);
		expect(error.status).toBe(0);
		expect(error.code).toBe("timeout");
		expect(stub.calls).toHaveLength(1);
	});

	test("a delete whose first response was lost reports 404 on the retry", async () => {
		let attempts = 0;
		const { calls, ryu } = retryingClient(() => {
			attempts += 1;
			if (attempts === 1) {
				throw new TypeError("fetch failed");
			}
			return Response.json({ error: "connection not found" }, { status: 404 });
		});
		const error = await failure(ryu.passport.connections.delete(CONNECTION.id));
		expect(error).toBeInstanceOf(RyuNotFoundError);
		expect(calls.map((call) => call.method)).toEqual(["DELETE", "DELETE"]);
	});
});

describe("connections.create idempotency, gated on Passport capabilities", () => {
	test("a Passport advertising idempotency_keys gets a key, reused on the retry after a 503", async () => {
		const created: string[] = [];
		const { calls, ryu } = client((request) => {
			if (request.method === "GET") {
				return capabilities(NEW_FEATURES);
			}
			const key = request.headers.get("idempotency-key") ?? "";
			created.push(key);
			return created.length === 1
				? Response.json(
						{ code: "unavailable", error: "busy" },
						{ status: 503, headers: { "retry-after": "0" } }
					)
				: Response.json({ connection: CONNECTION }, { status: 201 });
		});
		const result = await ryu.safe.passport.connections.create({
			domain: "github.com",
			profile_id: "work",
		});
		expect(result.error).toBeNull();
		expect(posts(calls)).toHaveLength(2);
		expect(created[0]).toMatch(/^[0-9a-f-]{36}$/u);
		expect(created[1]).toBe(created[0] as string);
		expect(result.meta?.idempotencyKey).toBe(created[0] as string);
		expect(result.meta?.attempts).toBe(2);
		expect(probes(calls)).toHaveLength(1);
	});

	test("the probe is cached per Ryu instance and base URL", async () => {
		const { calls, ryu } = client((request) =>
			request.method === "GET"
				? capabilities(NEW_FEATURES)
				: Response.json({ connection: CONNECTION }, { status: 201 })
		);
		const input = { domain: "github.com", profile_id: "work" };
		await ryu.passport.connections.create(input);
		await ryu.passport.connections.create(input);
		await ryu.passport.with({ timeoutMs: 5000 }).connections.create(input);
		expect(probes(calls)).toHaveLength(1);
		expect(
			posts(calls).every((call) => call.headers.has("idempotency-key"))
		).toBe(true);
		// Every create gets its own key.
		expect(
			new Set(posts(calls).map((call) => call.headers.get("idempotency-key")))
				.size
		).toBe(3);
		// Another instance (or another base URL) asks again.
		const other = stubFetch((request) =>
			request.method === "GET"
				? capabilities(OLD_FEATURES)
				: Response.json({ connection: CONNECTION }, { status: 201 })
		);
		const elsewhere = new Ryu({
			env: { ...ENV, RYU_PASSPORT_URL: "http://127.0.0.1:9093" },
			fetch: other.fetch,
		});
		await elsewhere.passport.connections.create(input);
		expect(probes(other.calls)).toHaveLength(1);
		expect(other.calls[0]?.url).toBe("http://127.0.0.1:9093/v1/capabilities");
		expect(posts(other.calls)[0]?.headers.get("idempotency-key")).toBeNull();
	});

	test("concurrent creates share one probe", async () => {
		const { calls, ryu } = client((request) =>
			request.method === "GET"
				? capabilities(NEW_FEATURES)
				: Response.json({ connection: CONNECTION }, { status: 201 })
		);
		const input = { domain: "github.com", profile_id: "work" };
		await Promise.all([
			ryu.passport.connections.create(input),
			ryu.passport.connections.create(input),
			ryu.passport.connections.create(input),
		]);
		expect(probes(calls)).toHaveLength(1);
		expect(posts(calls)).toHaveLength(3);
	});

	test("the probe leaves the create's meta alone", async () => {
		const { ryu } = client((request) =>
			request.method === "GET"
				? capabilities(NEW_FEATURES)
				: Response.json(
						{ connection: CONNECTION },
						{ status: 201, headers: { "x-request-id": "req_create" } }
					)
		);
		const result = await ryu.safe.passport.connections.create({
			domain: "github.com",
			profile_id: "work",
		});
		expect(result.meta?.status).toBe(201);
		expect(result.meta?.requestId).toBe("req_create");
		expect(result.meta?.attempts).toBe(1);
	});

	test("a caller key from .with() reaches a supporting Passport", async () => {
		const { calls, ryu } = client((request) =>
			request.method === "GET"
				? capabilities(NEW_FEATURES)
				: Response.json({ connection: CONNECTION }, { status: 201 })
		);
		await ryu.passport
			.with({ idempotencyKey: "work-github-connection" })
			.connections.create({ domain: "github.com", profile_id: "work" });
		expect(posts(calls)[0]?.headers.get("idempotency-key")).toBe(
			"work-github-connection"
		);
	});

	test("409 idempotency_in_progress is retried with the same key", async () => {
		let attempt = 0;
		const { calls, ryu } = client((request) => {
			if (request.method === "GET") {
				return capabilities(NEW_FEATURES);
			}
			attempt += 1;
			return attempt === 1
				? Response.json(
						{
							code: "idempotency_in_progress",
							error:
								"The first request with this Idempotency-Key has not finished",
						},
						{ status: 409, headers: { "retry-after": "0" } }
					)
				: Response.json({ connection: CONNECTION }, { status: 201 });
		});
		await ryu.passport.connections.create({
			domain: "github.com",
			profile_id: "work",
		});
		const keys = posts(calls).map((call) =>
			call.headers.get("idempotency-key")
		);
		expect(keys).toHaveLength(2);
		expect(keys[1]).toBe(keys[0] ?? "");
	});

	test("an older Passport that ignores the header gets no key and is never replayed", async () => {
		// The stub behaves like a pre-idempotency build: every POST creates a
		// connection whatever headers it carries, and capabilities lack the flag.
		let createdConnections = 0;
		const { calls, ryu } = retryingClient((request) => {
			if (request.method === "GET") {
				return capabilities(OLD_FEATURES);
			}
			createdConnections += 1;
			throw new TypeError("socket hang up after the write");
		});
		const error = await failure(
			ryu.passport.connections.create({
				domain: "github.com",
				profile_id: "work",
			})
		);
		expect(error.code).toBe("connection_error");
		expect(createdConnections).toBe(1);
		expect(posts(calls)[0]?.headers.get("idempotency-key")).toBeNull();
	});

	test("an unknown capability (probe failed) fails closed and is asked again next time", async () => {
		let probe = 0;
		const { calls, ryu } = client((request) => {
			if (request.method === "GET") {
				probe += 1;
				return probe === 1
					? Response.json({ error: "boom" }, { status: 500 })
					: capabilities(NEW_FEATURES);
			}
			return Response.json(
				{ error: "busy" },
				{ status: 503, headers: { "retry-after": "0" } }
			);
		});
		const input = { domain: "github.com", profile_id: "work" };
		await failure(ryu.passport.connections.create(input));
		// The probe is not retried, and the create is unkeyed and sent once.
		expect(probes(calls)).toHaveLength(1);
		expect(posts(calls)).toHaveLength(1);
		expect(posts(calls)[0]?.headers.get("idempotency-key")).toBeNull();
		await failure(ryu.passport.connections.create(input));
		expect(probes(calls)).toHaveLength(2);
		// Now supported: keyed and retried (1 + maxRetries attempts).
		expect(posts(calls)).toHaveLength(4);
		expect(posts(calls)[1]?.headers.get("idempotency-key")).not.toBeNull();
	});

	test("a Passport without /v1/capabilities (404) is remembered as unsupported", async () => {
		const { calls, ryu } = client((request) =>
			request.method === "GET"
				? new Response(null, { status: 404 })
				: Response.json({ connection: CONNECTION }, { status: 201 })
		);
		const input = { domain: "github.com", profile_id: "work" };
		await ryu.passport.connections.create(input);
		await ryu.passport.connections.create(input);
		expect(probes(calls)).toHaveLength(1);
		expect(
			posts(calls).some((call) => call.headers.has("idempotency-key"))
		).toBe(false);
	});

	test("with autoIdempotency off and no caller key, nothing is probed", async () => {
		const stub = stubFetch(() =>
			Response.json({ connection: CONNECTION }, { status: 201 })
		);
		const ryu = new Ryu({
			autoIdempotency: false,
			env: ENV,
			fetch: stub.fetch,
		});
		await ryu.passport.connections.create({
			domain: "github.com",
			profile_id: "work",
		});
		expect(stub.calls.map((call) => call.method)).toEqual(["POST"]);
		expect(stub.calls[0]?.headers.get("idempotency-key")).toBeNull();
	});

	test("a caller key survives a failed probe, so a manual same-key retry is deduplicated", async () => {
		// A Passport that honours keys: the first probe gets a transient 503,
		// the create succeeds server-side and the socket drops; the caller
		// retries the same operation with the same stable key.
		let probe = 0;
		const byKey = new Map<string, number>();
		let created = 0;
		const recordedKeys: (string | null)[] = [];
		const { calls, ryu } = retryingClient((request) => {
			if (request.method === "GET") {
				probe += 1;
				return probe === 1
					? Response.json({ error: "busy" }, { status: 503 })
					: capabilities(NEW_FEATURES);
			}
			const key = request.headers.get("idempotency-key");
			recordedKeys.push(key);
			if (key === null || !byKey.has(key)) {
				created += 1;
				if (key !== null) {
					byKey.set(key, created);
				}
				if (created === 1) {
					throw new TypeError("socket hang up after the write");
				}
			}
			return Response.json({ connection: CONNECTION }, { status: 201 });
		});
		const input = { domain: "github.com", profile_id: "work" };
		const stableKey = "stable-key-123456";
		const first = await failure(
			ryu.passport.with({ idempotencyKey: stableKey }).connections.create(input)
		);
		expect(first.code).toBe("connection_error");
		// Unknown capability: the caller's key is sent, but nothing is replayed.
		expect(posts(calls)).toHaveLength(1);
		await ryu.passport
			.with({ idempotencyKey: stableKey })
			.connections.create(input);
		expect(recordedKeys).toEqual([stableKey, stableKey]);
		expect(created).toBe(1);
	});

	test("an older Passport gets a caller key it ignores, and the create is never replayed", async () => {
		let createdConnections = 0;
		const { calls, ryu } = retryingClient((request) => {
			if (request.method === "GET") {
				return capabilities(OLD_FEATURES);
			}
			createdConnections += 1;
			throw new TypeError("socket hang up after the write");
		});
		await failure(
			ryu.passport
				.with({ idempotencyKey: "caller-key-0123456789" })
				.connections.create({ domain: "github.com", profile_id: "work" })
		);
		expect(createdConnections).toBe(1);
		expect(posts(calls)[0]?.headers.get("idempotency-key")).toBe(
			"caller-key-0123456789"
		);
	});

	test("the probe is invisible to the caller's hooks", async () => {
		const seen: string[] = [];
		const stub = stubFetch((request) =>
			request.method === "GET"
				? capabilities(NEW_FEATURES)
				: Response.json({ connection: CONNECTION }, { status: 201 })
		);
		const ryu = new Ryu({
			env: ENV,
			fetch: stub.fetch,
			hooks: {
				onRequest: (event) => seen.push(`req ${event.method} ${event.url}`),
				onResponse: (event) => seen.push(`res ${event.method} ${event.url}`),
			},
		});
		await ryu.passport.connections.create({
			domain: "github.com",
			profile_id: "work",
		});
		expect(probes(stub.calls)).toHaveLength(1);
		expect(seen).toEqual([
			`req POST ${BASE}/v1/connections`,
			`res POST ${BASE}/v1/connections`,
		]);
	});

	test("a hanging probe uses its own short timeout, not the call's", async () => {
		const stub = stubFetch((request) => {
			if (request.method === "GET") {
				return new Promise<Response>((_resolve, reject) => {
					request.signal?.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError"))
					);
				});
			}
			return Response.json({ connection: CONNECTION }, { status: 201 });
		});
		const ryu = new Ryu({ env: ENV, fetch: stub.fetch, timeoutMs: 100 });
		const started = Date.now();
		await ryu.passport
			.with({ timeoutMs: 60_000 })
			.connections.create({ domain: "github.com", profile_id: "work" });
		expect(Date.now() - started).toBeLessThan(2000);
		expect(posts(stub.calls)[0]?.headers.get("idempotency-key")).toBeNull();
	});

	test("one caller aborting during the shared probe does not turn keys off for another", async () => {
		let releaseProbe: () => void = () => undefined;
		const probeGate = new Promise<void>((resolve) => {
			releaseProbe = resolve;
		});
		const { calls, ryu } = client(async (request) => {
			if (request.method === "GET") {
				await probeGate;
				return capabilities(NEW_FEATURES);
			}
			return Response.json({ connection: CONNECTION }, { status: 201 });
		});
		const input = { domain: "github.com", profile_id: "work" };
		const controller = new AbortController();
		const aborted = failure(
			ryu.passport.with({ signal: controller.signal }).connections.create(input)
		);
		const other = ryu.passport.connections.create(input);
		await Promise.resolve();
		controller.abort();
		expect((await aborted).code).toBe("aborted");
		releaseProbe();
		await other;
		expect(probes(calls)).toHaveLength(1);
		expect(posts(calls)).toHaveLength(1);
		expect(posts(calls)[0]?.headers.get("idempotency-key")).not.toBeNull();
	});

	test("a non-boolean feature value does not break the probe", async () => {
		const { calls, ryu } = client((request) =>
			request.method === "GET"
				? Response.json({
						api_version: "v1",
						features: {
							idempotency_keys: true,
							max_profiles: 10,
							regions: { eu: true },
						},
						service: "passport",
					})
				: Response.json({ connection: CONNECTION }, { status: 201 })
		);
		const input = { domain: "github.com", profile_id: "work" };
		await ryu.passport.connections.create(input);
		await ryu.passport.connections.create(input);
		expect(probes(calls)).toHaveLength(1);
		expect(
			posts(calls).every((call) => call.headers.has("idempotency-key"))
		).toBe(true);
	});

	test("a 401 probe is remembered briefly, so a bad key is not presented twice per create", async () => {
		const { calls, ryu } = client(() =>
			Response.json(
				{ code: "unauthorized", error: "invalid token" },
				{ status: 401 }
			)
		);
		const input = { domain: "github.com", profile_id: "work" };
		await failure(ryu.passport.connections.create(input));
		await failure(ryu.passport.connections.create(input));
		expect(probes(calls)).toHaveLength(1);
		expect(posts(calls)).toHaveLength(2);
		expect(
			posts(calls).some((call) => call.headers.has("idempotency-key"))
		).toBe(false);
	});

	test("other POSTs are never gated or keyed", async () => {
		const { calls, ryu } = client((request) =>
			request.method === "GET"
				? capabilities(NEW_FEATURES)
				: Response.json({ flow_id: "f", kind: { kind: "manual" } })
		);
		await ryu.passport.connections.login(CONNECTION.id);
		expect(probes(calls)).toHaveLength(0);
		expect(calls[0]?.headers.get("idempotency-key")).toBeNull();
	});
});
