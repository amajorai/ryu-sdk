// Server conformance for the Connect slice. It runs the real in-process
// Connect service (`createConnectService` from apps/connect/src/service.ts,
// with the setup of apps/connect/src/service.test.ts: a temporary Skills
// directory, no Docker, no credentials) and routes the SDK's fetch straight
// to `service.fetch`. Test-only relative imports: the published SDK never
// depends on apps/connect.
//
// The recorded fixtures in test/fixtures/connect/*.json are the fallback for
// a future Connect that cannot run in-process; here they are replayed through
// the SDK too, and checked against the live service's response shape so they
// cannot silently drift.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BillingStatusFeed } from "../../../../apps/connect/src/billing-status.ts";
import { serveConnectMcp } from "../../../../apps/connect/src/mcp.ts";
import {
	type ConnectService,
	type ConnectServiceOptions,
	createConnectService,
} from "../../../../apps/connect/src/service.ts";
import {
	isRyuError,
	RyuAuthenticationError,
	type RyuError,
	RyuInvalidRequestError,
	RyuNotFoundError,
	RyuPaymentRequiredError,
	RyuPermissionError,
	RyuServerError,
	RyuUnavailableError,
} from "../../src/errors.ts";
import { Ryu } from "../../src/ryu.ts";

const FIXTURES = resolve(import.meta.dir, "../fixtures/connect");
const ORIGIN = "http://connect.test";
const TOKEN = "conformance-connect-secret-0001";
const ENV = { RYU_CONNECT_API_KEY: TOKEN, RYU_CONNECT_URL: ORIGIN };
const WINDOW = { from: "2026-10-01T00:00:00Z", to: "2026-10-02T00:00:00Z" };

let skillsDir = "";
const open: ConnectService[] = [];

beforeAll(async () => {
	skillsDir = await mkdtemp(join(tmpdir(), "ryu-connect-sdk-skills-"));
	await mkdir(join(skillsDir, "passport-review"));
	await writeFile(
		join(skillsDir, "passport-review", "SKILL.md"),
		"---\nname: passport-review\ndescription: Review identity boundaries\n---\n# Passport review\n"
	);
});

afterAll(async () => {
	for (const service of open.splice(0)) {
		service.close();
	}
	await rm(skillsDir, { force: true, recursive: true });
});

/** The service, as apps/connect/src/service.test.ts sets it up, plus overrides. */
function service(
	overrides: Partial<ConnectServiceOptions> = {}
): ConnectService {
	const created = createConnectService({
		apiKeys: new Map([[TOKEN, "acme"]]),
		skillsDir,
		...overrides,
	});
	open.push(created);
	return created;
}

/** A client whose fetch is the in-process service; counts the requests it saw. */
function client(connect: ConnectService, env: Record<string, string> = ENV) {
	const seen: Request[] = [];
	const ryu = new Ryu({
		env,
		fetch: (input, init) => {
			const request = new Request(input, init);
			seen.push(request.clone());
			return connect.fetch(request);
		},
	});
	return { ryu, seen };
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

const suspended = {
	// Billing is on and the tenant is not exempt, so Connect meters and refuses the call.
	billingOn: () => true,
	isExempt: () => false,
	isSuspended: () => true,
	stop: () => undefined,
} as unknown as BillingStatusFeed;

describe("Connect conformance: live service", () => {
	test("skills.list and skills.get read the hosted catalog", async () => {
		const { ryu, seen } = client(service());
		const skills = await ryu.connect.skills.list();
		expect(skills).toEqual({
			data: [
				{
					description: "Review identity boundaries",
					id: "passport-review",
					name: "passport-review",
				},
			],
			object: "list",
		});
		const skill = await ryu.connect.skills.get("passport-review");
		expect(skill.instructions).toContain("# Passport review");
		const missing = await rejection(ryu.connect.skills.get("nope"));
		expect(missing).toBeInstanceOf(RyuNotFoundError);
		expect(missing.message).toBe("Skill not found");
		expect(missing.requestId).toMatch(/^req_/u);
		for (const request of seen) {
			expect(request.headers.get("idempotency-key")).toBeNull();
		}
	});

	test("tools.search on an explicitly empty native registry is an empty list", async () => {
		const { ryu } = client(service({ mcpServers: [] }));
		expect(await ryu.connect.tools.search({ q: "echo" })).toEqual({
			data: [],
			// An empty registry answers with the query's unmatched terms, so a
			// caller can tell "nothing registered" from "nothing matched".
			didYouMean: [],
			missedTerms: ["echo"],
			object: "list",
		});
	});

	test("tools.search in compatibility mode returns Core's catalog", async () => {
		let upstream: Request | undefined;
		const { ryu } = client(
			service({
				coreToken: "core-only-secret",
				coreUrl: "https://core.test",
				fetch: async (input, init) => {
					upstream = new Request(input, init);
					return Response.json({
						data: [
							{
								description: "Send a Slack message",
								id: "composio.SLACK_SEND_MESSAGE",
								kind: "composio",
								name: "SLACK_SEND_MESSAGE",
							},
						],
						object: "list",
					});
				},
			})
		);
		const found = await ryu.connect.tools.search({
			kind: "composio",
			q: "send a Slack message",
		});
		expect(found.data[0]?.id).toBe("composio.SLACK_SEND_MESSAGE");
		const url = new URL(upstream?.url ?? "http://invalid");
		expect(url.pathname).toBe("/api/tools/search");
		expect(url.searchParams.get("q")).toBe("send a Slack message");
		expect(upstream?.headers.get("authorization")).toBe(
			"Bearer core-only-secret"
		);
	});

	test("exec errors map to RyuError subclasses and are never retried", async () => {
		const denied = client(service({ mcpServers: [] }));
		const tool = await rejection(
			denied.ryu.connect.tools.exec({ toolId: "remote.echo" })
		);
		expect(tool).toBeInstanceOf(RyuPermissionError);
		expect(tool.code).toBe("tool_denied");
		// The SDK asks for problem+json, which Connect now negotiates.
		expect(tool.envelope).toBe("problem+json");
		expect(denied.seen).toHaveLength(1);

		const broke = client(service({ billingStatus: suspended, mcpServers: [] }));
		const credits = await rejection(
			broke.ryu.connect.tools.exec({ toolId: "remote.echo" })
		);
		expect(credits).toBeInstanceOf(RyuPaymentRequiredError);
		expect(credits.code).toBe("insufficient_credits");
		expect(credits.retryable).toBe(false);
		expect(broke.seen).toHaveLength(1);

		let upstreamCalls = 0;
		const failing = client(
			service({
				gatewayToken: "gateway-only-secret",
				gatewayUrl: "https://gateway.test",
				fetch: () => {
					upstreamCalls += 1;
					return Promise.reject(new TypeError("upstream unreachable"));
				},
			})
		);
		// Connect logs the failed upstream call; keep the test output clean.
		const logged = spyOn(console, "error").mockImplementation(() => undefined);
		let failed: RyuError;
		try {
			failed = await rejection(
				failing.ryu.connect.tools.exec({ toolId: "remote.echo" })
			);
		} finally {
			logged.mockRestore();
		}
		expect(failed).toBeInstanceOf(RyuServerError);
		expect(failed.status).toBe(502);
		expect(failed.code).toBe("request_failed");
		expect(failed.attempts).toBe(1);
		expect(failing.seen).toHaveLength(1);
		expect(upstreamCalls).toBe(1);
	});

	test("composio.execute without native bindings is unavailable and not retried", async () => {
		const { ryu, seen } = client(service());
		const error = await rejection(
			ryu.connect.composio.execute({ toolId: "SLACK_SEND_MESSAGE" })
		);
		expect(error).toBeInstanceOf(RyuUnavailableError);
		expect(error.code).toBe("native_composio_unavailable");
		expect(seen).toHaveLength(1);
		expect(await seen[0]?.json()).toEqual({
			operation: "execute",
			toolId: "SLACK_SEND_MESSAGE",
		});
	});

	test("the native execute body passes Connect's strict request schema", async () => {
		// With bindings absent the route answers 503 before parsing; a body
		// Connect rejects would be 400 invalid_request in native mode, so check
		// the body the SDK sends against the server's own schema.
		const { composioExecutionRequestSchema } = await import(
			"../../../../apps/connect/src/service-contract.ts"
		);
		const { fetch, seen } = (() => {
			const requests: Request[] = [];
			return {
				fetch: (input: RequestInfo | URL, init?: RequestInit) => {
					requests.push(new Request(input, init));
					return Promise.resolve(
						Response.json({ data: null, successful: true })
					);
				},
				seen: requests,
			};
		})();
		const ryu = new Ryu({ env: ENV, fetch });
		await ryu.connect.composio.execute({
			body: { channel: "#general", text: "hi" },
			expectedAccountId: "ca_123",
			toolId: "SLACK_SEND_MESSAGE",
		});
		await ryu.connect.composio.execute({ toolId: "GITHUB_GET_USER" });
		for (const request of seen) {
			expect(
				composioExecutionRequestSchema.safeParse(await request.json()).success
			).toBe(true);
		}
	});

	test("usage reads the report and maps a bad window to RyuInvalidRequestError", async () => {
		const { ryu } = client(service());
		const report = await ryu.connect.usage(WINDOW);
		expect(report).toMatchObject({
			from: "2026-10-01T00:00:00.000Z",
			lines: [],
			nextCursor: null,
			to: "2026-10-02T00:00:00.000Z",
			unresolved: [],
		});
		expect(await ryu.connect.usage.iterate(WINDOW).collect()).toEqual([]);
		const error = await rejection(
			ryu.connect.usage({ ...WINDOW, from: "2026-10-01T00:30:00Z" })
		);
		expect(error).toBeInstanceOf(RyuInvalidRequestError);
		expect(error.message).toBe("from must fall on a whole hour");
	});

	test("a wrong runtime key is a RyuAuthenticationError", async () => {
		const { ryu } = client(service(), { ...ENV, RYU_CONNECT_API_KEY: "wrong" });
		const error = await rejection(ryu.connect.skills.list());
		expect(error).toBeInstanceOf(RyuAuthenticationError);
		expect(error.code).toBe("unauthorized");
		expect(JSON.stringify(error.toJSON())).not.toContain("wrong");
	});
});

/** A loopback MCP server with one `echo` tool that returns its arguments as text. */
function echoUpstream() {
	return Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (request.method !== "POST") {
				return new Response(null, { status: 405 });
			}
			return await serveConnectMcp(
				request,
				await request.json(),
				"sdk-conformance",
				{ list: async () => [], read: async () => null },
				{
					list: async () => [
						{
							description: "Echo input",
							inputSchema: {
								properties: { message: { type: "string" } },
								type: "object" as const,
							},
							name: "echo",
						},
					],
					call: async (_name, args) => ({
						content: [{ text: JSON.stringify(args), type: "text" as const }],
					}),
				}
			);
		},
	});
}

const COMPOSIO_KEY_ENV = "RYU_SDK_CONFORMANCE_COMPOSIO_KEY";

/** A Composio provider stub (as apps/connect/src/composio-usage.test.ts): one action, one receipt. */
function composioProvider() {
	const executed: Request[] = [];
	const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const path = new URL(request.url).pathname;
		if (path.endsWith("/tools/execute/GMAIL_GET_PROFILE")) {
			executed.push(request);
			return Promise.resolve(
				Response.json({
					data: { name: "Test" },
					log_id: "log_sdk_1",
					successful: true,
				})
			);
		}
		if (path.includes("/logs/tool_execution/")) {
			return Promise.resolve(
				Response.json({
					id: path.split("/").at(-1) ?? "",
					metadata: {
						auth_config_id: "ac-acme",
						connected_account_id: "ca-acme",
						instant_charge: "0.008",
					},
				})
			);
		}
		if (path.endsWith("/connected_accounts/ca-acme")) {
			return Promise.resolve(
				Response.json({
					auth_config: { id: "ac-acme" },
					id: "ca-acme",
					user_id: "user-acme",
				})
			);
		}
		if (path.startsWith("/api/v3.1/tools")) {
			return Promise.resolve(
				Response.json({
					items: [
						{
							input_parameters: {},
							slug: "GMAIL_GET_PROFILE",
							toolkit: { slug: "gmail" },
							version: "20251027_00",
						},
					],
				})
			);
		}
		return Promise.resolve(new Response(null, { status: 404 }));
	};
	return { executed, fetch };
}

describe("Connect conformance: live successful execution", () => {
	test("native tools.describe and tools.exec against a registered MCP server", async () => {
		const upstream = echoUpstream();
		try {
			const { ryu, seen } = client(
				service({
					mcpServers: [
						{
							allowedTools: ["echo"],
							id: "remote",
							tenantId: "acme",
							url: new URL("/mcp", upstream.url).toString(),
						},
					],
				})
			);
			const found = await ryu.connect.tools.search({ q: "echo" });
			expect(found.data.map((tool) => tool.id)).toEqual(["remote.echo"]);
			const described = await ryu.connect.tools.describe({
				toolId: "remote.echo",
			});
			expect(described).toMatchObject({
				id: "remote.echo",
				kind: "mcp",
				name: "remote.echo",
				parameters: { type: "object" },
			});
			const executed = await ryu.connect.tools.exec({
				arguments: { message: "hello" },
				toolId: "remote.echo",
			});
			expect(executed).toMatchObject({
				ok: true,
				result: { content: [{ text: '{"message":"hello"}', type: "text" }] },
			});
			expect(seen.at(-1)?.headers.get("idempotency-key")).toBeNull();
		} finally {
			upstream.stop(true);
		}
	});

	test("compatibility-mode exec decodes the Gateway's replies, including 200 { ok: false, error }", async () => {
		const success = {
			ok: true,
			result: { content: [{ text: "done", type: "text" }] },
		};
		const replies = [
			{ error: "tool call denied (exec budget exhausted)", ok: false },
			success,
		];
		const forwarded: Request[] = [];
		const { ryu, seen } = client(
			service({
				gatewayToken: "gateway-only-secret",
				gatewayUrl: "https://gateway.test",
				fetch: (input, init) => {
					forwarded.push(new Request(input, init));
					return Promise.resolve(Response.json(replies[forwarded.length - 1]));
				},
			})
		);
		const refused = await ryu.connect.tools.exec({
			toolId: "core.notes_write",
		});
		expect(refused.ok).toBe(false);
		expect(refused.error).toBe("tool call denied (exec budget exhausted)");
		expect(refused.result).toBeUndefined();
		const done = await ryu.connect.tools.exec({ toolId: "core.notes_write" });
		expect(done).toEqual(success);
		expect(seen).toHaveLength(2);
		expect(new URL(forwarded[0]?.url ?? "http://invalid").pathname).toBe(
			"/v1/exec/tool"
		);
		expect(forwarded[0]?.headers.get("authorization")).toBe(
			"Bearer gateway-only-secret"
		);
	});

	test("native composio.execute returns the action result with its billing receipt", async () => {
		process.env[COMPOSIO_KEY_ENV] = "sdk-conformance-composio-key";
		try {
			const provider = composioProvider();
			const { ryu, seen } = client(
				service({
					composioBindings: [
						{
							allowedTools: ["GMAIL_GET_PROFILE"],
							apiKeyEnv: COMPOSIO_KEY_ENV,
							connectedAccountId: "ca-acme",
							tenantId: "acme",
							userId: "user-acme",
							version: "20251027_00",
						},
					],
					fetch: provider.fetch,
				})
			);
			const executed = await ryu.connect.composio.execute({
				body: {},
				toolId: "GMAIL_GET_PROFILE",
			});
			expect(executed.successful).toBe(true);
			expect(executed.data).toEqual({ name: "Test" });
			expect(executed.billingReceipt).toMatchObject({
				transactionId: "log_sdk_1",
			});
			expect(provider.executed).toHaveLength(1);
			expect(seen).toHaveLength(1);
		} finally {
			delete process.env[COMPOSIO_KEY_ENV];
		}
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

function replay(names: readonly string[]) {
	let index = 0;
	return (): Promise<Response> => {
		const next = fixture(names[Math.min(index, names.length - 1)] ?? "");
		index += 1;
		return Promise.resolve(
			Response.json(next.body, { headers: next.headers, status: next.status })
		);
	};
}

/** The keys of `value`, recursively, with array items merged; values are ignored. */
function shape(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.length === 0 ? [] : [shape(value[0])];
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, shape((value as Record<string, unknown>)[key])])
		);
	}
	return typeof value;
}

describe("Connect conformance: recorded fixtures", () => {
	test("every fixture is listed here", () => {
		expect(
			readdirSync(FIXTURES)
				.filter((name) => name.endsWith(".json"))
				.sort()
		).toEqual([
			"composio-unavailable.json",
			"exec-insufficient-credits.json",
			"exec-tool-denied.json",
			"fallthrough.json",
			"skills-list.json",
			"tools-search.json",
			"unauthorized.json",
			"usage-invalid.json",
			"usage-report.json",
		]);
	});

	test("fixtures still match the live service's response shape", async () => {
		const plain = service();
		const native = service({ mcpServers: [] });
		const broke = service({ billingStatus: suspended, mcpServers: [] });
		const call = (
			connect: ConnectService,
			path: string,
			init: RequestInit = {},
			token = TOKEN
		) =>
			connect.fetch(
				new Request(`${ORIGIN}${path}`, {
					...init,
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
				})
			);
		const exec = {
			body: JSON.stringify({ arguments: {}, kind: "tool", tool_id: "x.y" }),
			method: "POST",
		};
		const live: Record<string, Response> = {
			"composio-unavailable": await call(plain, "/v1/composio/execute", {
				body: JSON.stringify({ operation: "execute", toolId: "X" }),
				method: "POST",
			}),
			"exec-insufficient-credits": await call(broke, "/v1/exec/tool", exec),
			"exec-tool-denied": await call(native, "/v1/exec/tool", exec),
			fallthrough: await call(plain, "/v1/nope"),
			"skills-list": await call(plain, "/v1/skills"),
			"tools-search": await call(native, "/v1/tools/search?q=echo"),
			unauthorized: await call(plain, "/v1/skills", {}, "wrong"),
			"usage-invalid": await call(
				plain,
				"/v1/usage?from=2026-10-01T00:30:00Z&to=2026-10-02T00:00:00Z"
			),
			"usage-report": await call(
				plain,
				"/v1/usage?from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z"
			),
		};
		for (const [name, response] of Object.entries(live)) {
			const recorded = fixture(name);
			expect(`${name} ${response.status}`).toBe(`${name} ${recorded.status}`);
			expect(response.headers.get("x-request-id")).toMatch(/^req_/u);
			// The name rides along so a drifted fixture is named in the diff.
			expect(`${name} ${JSON.stringify(shape(await response.json()))}`).toBe(
				`${name} ${JSON.stringify(shape(recorded.body))}`
			);
		}
	});

	test("the fall-through fixture is the router's unmatched-route answer", () => {
		expect(fixture("fallthrough")).toMatchObject({
			body: { code: "not_found", error: "Connect route not found", ok: false },
			status: 404,
		});
	});

	test("replayed fixtures decode through the SDK", async () => {
		const ryu = new Ryu({
			env: ENV,
			fetch: replay(["skills-list", "tools-search", "usage-report"]),
			result: "object",
		});
		const skills = await ryu.connect.skills.list();
		expect(skills.data?.data[0]?.id).toBe("passport-review");
		expect(skills.meta?.requestId).toBe(
			fixture("skills-list").headers["x-request-id"] ?? "missing"
		);
		const found = await ryu.connect.tools.search({ q: "echo" });
		expect(found.data?.data).toEqual([]);
		const usage = await ryu.connect.usage(WINDOW);
		expect(usage.data?.nextCursor).toBeNull();
	});

	test("replayed exec errors map with their codes and request ids", async () => {
		const cases: [string, string, new (...args: never[]) => RyuError][] = [
			["exec-tool-denied", "tool_denied", RyuPermissionError],
			[
				"exec-insufficient-credits",
				"insufficient_credits",
				RyuPaymentRequiredError,
			],
			[
				"composio-unavailable",
				"native_composio_unavailable",
				RyuUnavailableError,
			],
			["unauthorized", "unauthorized", RyuAuthenticationError],
			["usage-invalid", "invalid_request", RyuInvalidRequestError],
		];
		for (const [name, code, ErrorClass] of cases) {
			let calls = 0;
			const replayOnce = replay([name]);
			const ryu = new Ryu({
				env: ENV,
				fetch: () => {
					calls += 1;
					return replayOnce();
				},
			});
			const error = await rejection(
				ryu.connect.tools.exec({ toolId: "remote.echo" })
			);
			expect(error).toBeInstanceOf(ErrorClass);
			expect(error.code).toBe(code);
			expect(error.requestId).toBe(
				fixture(name).headers["x-request-id"] ?? "missing"
			);
			expect(calls).toBe(1);
		}
	});
});
