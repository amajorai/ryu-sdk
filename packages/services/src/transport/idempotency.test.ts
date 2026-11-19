import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
	idempotencyMiddleware,
	memoryIdempotencyStore,
	parseIdempotencyKey,
} from "../../../../apps/server/src/idempotency.ts";
import type { ServiceRouteTable } from "../routes.ts";
import { createCallContext, createServiceFetch } from "./fetch-shim.ts";
import {
	matchCapabilityRoute,
	matchNonReplaySafeRoute,
	matchRoute,
	newIdempotencyKey,
	relativeServicePath,
} from "./idempotency.ts";

const MANAGED_AGENTS_KEY = /^[A-Za-z0-9_-]{16,128}$/u;

describe("newIdempotencyKey", () => {
	test("generated keys satisfy apps/server and Managed Agents", () => {
		for (let index = 0; index < 50; index += 1) {
			const key = newIdempotencyKey();
			expect(parseIdempotencyKey(key)).toBe(key);
			expect(key).toMatch(MANAGED_AGENTS_KEY);
			expect(key.length).toBeLessThanOrEqual(128);
		}
	});

	test("the fallback without Web Crypto satisfies them too", () => {
		const original = globalThis.crypto;
		Object.defineProperty(globalThis, "crypto", {
			configurable: true,
			value: undefined,
		});
		try {
			const key = newIdempotencyKey();
			expect(parseIdempotencyKey(key)).toBe(key);
			expect(key).toMatch(MANAGED_AGENTS_KEY);
		} finally {
			Object.defineProperty(globalThis, "crypto", {
				configurable: true,
				value: original,
			});
		}
	});
});

const TABLE: ServiceRouteTable = {
	idempotent: [
		{ method: "POST", path: "/sessions", required: false },
		{ method: "POST", path: "/sessions/{id}/events", required: false },
		{ method: "PATCH", path: "/agents/{id}", required: false },
	],
	mount: "/api/v1/managed-agents",
	service: "managedAgents",
};
const BASE = "https://api.ryuhq.com";

describe("matchRoute", () => {
	test("matches templates relative to the mount", () => {
		expect(
			matchRoute(TABLE, BASE, "post", `${BASE}/api/v1/managed-agents/sessions`)
				?.path
		).toBe("/sessions");
		expect(
			matchRoute(
				TABLE,
				BASE,
				"POST",
				`${BASE}/api/v1/managed-agents/sessions/s_1/events?x=1`
			)?.path
		).toBe("/sessions/{id}/events");
		expect(
			matchRoute(
				TABLE,
				BASE,
				"PATCH",
				`${BASE}/api/v1/managed-agents/agents/a_1`
			)?.path
		).toBe("/agents/{id}");
	});

	test("never matches other methods, other paths or other origins", () => {
		expect(
			matchRoute(TABLE, BASE, "GET", `${BASE}/api/v1/managed-agents/sessions`)
		).toBeNull();
		expect(
			matchRoute(TABLE, BASE, "PUT", `${BASE}/api/v1/managed-agents/agents/a_1`)
		).toBeNull();
		expect(
			matchRoute(
				TABLE,
				BASE,
				"POST",
				`${BASE}/api/v1/managed-agents/sessions/s_1/cancel`
			)
		).toBeNull();
		expect(
			matchRoute(
				TABLE,
				BASE,
				"POST",
				`${BASE}/api/v1/managed-agents/sessions//events`
			)
		).toBeNull();
		expect(
			matchRoute(
				TABLE,
				BASE,
				"POST",
				"https://other.example.com/api/v1/managed-agents/sessions"
			)
		).toBeNull();
	});

	test("respects a base URL path prefix", () => {
		expect(
			relativeServicePath(
				"https://h.example.com/notify/",
				"",
				"https://h.example.com/notify/v1/events"
			)
		).toBe("/v1/events");
		expect(
			relativeServicePath(
				"https://h.example.com/notify",
				"",
				"https://h.example.com/v1/events"
			)
		).toBeNull();
	});
});

describe("matchCapabilityRoute and matchNonReplaySafeRoute", () => {
	const table: ServiceRouteTable = {
		capabilityIdempotent: [
			{
				capability: "idempotency_keys",
				method: "POST",
				path: "/v1/connections",
				required: false,
			},
		],
		idempotent: [],
		mount: "/api",
		nonReplaySafe: [
			{ method: "PUT", path: "/orgs/{orgId}/settings", reason: "secret" },
		],
		service: "passport",
	};
	const base = "https://h.example.com";

	test("a gated route matches POST/PATCH only, and never through matchRoute", () => {
		const url = `${base}/api/v1/connections`;
		expect(matchCapabilityRoute(table, base, "post", url)?.capability).toBe(
			"idempotency_keys"
		);
		expect(matchRoute(table, base, "POST", url)).toBeNull();
		expect(matchCapabilityRoute(table, base, "GET", url)).toBeNull();
		expect(
			matchCapabilityRoute(table, base, "POST", `${base}/api/v1/connections/x`)
		).toBeNull();
		expect(
			matchCapabilityRoute(
				table,
				base,
				"POST",
				"https://other.example.com/api/v1/connections"
			)
		).toBeNull();
	});

	test("a non-replay-safe route matches its own method and template only", () => {
		const url = `${base}/api/orgs/org_1/settings`;
		expect(matchNonReplaySafeRoute(table, base, "put", url)?.reason).toBe(
			"secret"
		);
		expect(matchNonReplaySafeRoute(table, base, "GET", url)).toBeNull();
		expect(
			matchNonReplaySafeRoute(table, base, "PUT", `${base}/api/orgs//settings`)
		).toBeNull();
		expect(
			matchNonReplaySafeRoute(
				{ idempotent: [], mount: "", service: "box" },
				base,
				"PUT",
				url
			)
		).toBeNull();
	});
});

describe("memoryIdempotencyStore replays", () => {
	test("a replay sets meta.replayed and reuses the key", async () => {
		let executions = 0;
		const app = new Hono();
		app.use(
			"*",
			idempotencyMiddleware({
				// The server scopes replays to the authenticated caller; the
				// presented key stands in for that here.
				authenticate: async (c) => c.req.header("x-api-key") ?? null,
				store: memoryIdempotencyStore(),
			})
		);
		app.post("/api/v1/managed-agents/sessions", (c) => {
			executions += 1;
			return c.json({ id: `s_${executions}` }, 201);
		});
		const config = {
			apiKey: "ryu_test",
			auth: "x-api-key" as const,
			autoIdempotency: true,
			baseUrl: BASE,
			errors: "passthrough" as const,
			fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
				await app.fetch(new Request(input, init)),
			maxRetries: 0,
			maxRetryDelayMs: 1000,
			routes: TABLE,
			service: "managedAgents" as const,
			timeoutMs: 5000,
			userAgent: null,
		};
		const send = async (key: string) => {
			const ctx = createCallContext({ idempotencyKey: key });
			const response = await createServiceFetch(config, ctx)(
				`${BASE}/api/v1/managed-agents/sessions`,
				{
					body: JSON.stringify({ agentId: "a" }),
					headers: {
						"content-type": "application/json",
						"x-api-key": "ryu_test",
					},
					method: "POST",
				}
			);
			return { body: await response.json(), meta: ctx.meta };
		};
		const first = await send("replay-key-0001");
		const second = await send("replay-key-0001");
		expect(executions).toBe(1);
		expect(first.meta?.replayed).toBe(false);
		expect(second.meta?.replayed).toBe(true);
		expect(second.meta?.idempotencyKey).toBe("replay-key-0001");
		expect(second.body).toEqual(first.body);
	});
});
