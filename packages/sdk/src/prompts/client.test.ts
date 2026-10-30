import { describe, expect, test } from "bun:test";
import { Agent } from "../agent/agent.ts";
import type { AgentEvent } from "../agent/loop.ts";
import { modelBodyFixtureSchema } from "../agent/transport-fixtures.ts";
import { type FetchLike, PromptClient, PromptRegistryError } from "./client.ts";
import { resolveInstructions } from "./instructions.ts";
import { ChatPrompt, TextPrompt } from "./prompt.ts";

/**
 * The prompt client against a stubbed registry transport: label/version
 * resolution, the cache, stale-on-error, fallbacks, management calls, and an
 * Agent whose instructions are a registry reference.
 */

const BASE = "http://node.test";

function version(overrides: Record<string, unknown> = {}) {
	return {
		name: "triage",
		version: 3,
		type: "text",
		template: "Triage for {{team}}.",
		messages: null,
		variables: ["team"],
		placeholders: [],
		modelConfig: { model: "gpt-x" },
		labels: ["production", "latest"],
		commitMessage: "tighten",
		createdAt: "2026-10-01T00:00:00.000Z",
		createdBy: "u1",
		...overrides,
	};
}

interface Call {
	body: string | null;
	headers: Record<string, string>;
	method: string;
	url: string;
}

function transport(answer: (call: Call) => Response | Promise<Response>): {
	calls: Call[];
	fetch: FetchLike;
} {
	const calls: Call[] = [];
	return {
		calls,
		fetch: (input, init) => {
			const call: Call = {
				url: input,
				method: init?.method ?? "GET",
				headers: Object.fromEntries(
					Object.entries((init?.headers ?? {}) as Record<string, string>)
				),
				body: typeof init?.body === "string" ? init.body : null,
			};
			calls.push(call);
			return Promise.resolve(answer(call));
		},
	};
}

async function withEnv(
	values: Record<string, string | undefined>,
	run: () => Promise<void>
): Promise<void> {
	const saved = Object.fromEntries(
		Object.keys(values).map((name) => [name, process.env[name]])
	);
	const apply = (next: Record<string, string | undefined>) => {
		for (const [name, value] of Object.entries(next)) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
	};
	apply(values);
	try {
		await run();
	} finally {
		apply(saved);
	}
}

const ok = (body: unknown) =>
	new Response(JSON.stringify(body), { status: 200 });

describe("get", () => {
	test("resolves production by default against the node registry", async () => {
		const stub = transport(() => ok({ version: version() }));
		const client = new PromptClient({
			baseUrl: `${BASE}/`,
			token: "t0k",
			fetch: stub.fetch,
		});
		const prompt = await client.get("triage");
		expect(prompt).toBeInstanceOf(TextPrompt);
		expect(prompt.version).toBe(3);
		expect(prompt.modelConfig).toEqual({ model: "gpt-x" });
		expect(prompt.isFallback).toBe(false);
		expect(stub.calls[0]?.url).toBe(
			`${BASE}/api/prompts/triage/resolve?label=production`
		);
		expect(stub.calls[0]?.headers.authorization).toBe("Bearer t0k");
		if (prompt.type === "text") {
			expect(prompt.compile({ team: "billing" })).toBe("Triage for billing.");
		}
	});

	test("an organization client reads the control-plane registry", async () => {
		const stub = transport(() => ok({ version: version() }));
		const client = new PromptClient({
			apiKey: "ryu_k",
			baseUrl: "https://api.test",
			organizationId: "org1",
			fetch: stub.fetch,
		});
		await client.get("triage", { version: 2 });
		expect(stub.calls[0]?.url).toBe(
			"https://api.test/api/control-plane/orgs/org1/prompts/triage/resolve?version=2"
		);
	});

	test("an explicit session token wins over RYU_API_KEY", async () => {
		// A caller who passes a session token gets exactly that credential: the
		// environment's API key and organization are not added beside it.
		const saved = {
			key: process.env.RYU_API_KEY,
			org: process.env.RYU_ORGANIZATION_ID,
		};
		process.env.RYU_API_KEY = "ryu_should_not_be_sent";
		process.env.RYU_ORGANIZATION_ID = "org-from-env";
		try {
			const stub = transport(() => ok({ version: version() }));
			const client = new PromptClient({
				baseUrl: "https://api.test",
				organizationId: "org1",
				token: "session-token",
				fetch: stub.fetch,
			});
			await client.get("triage");
			const headers = stub.calls[0]?.headers ?? {};
			expect(headers.authorization).toBe("Bearer session-token");
			expect(headers["x-api-key"]).toBeUndefined();
			expect(headers["x-ryu-organization"]).toBeUndefined();
			expect(stub.calls[0]?.url).toContain("/orgs/org1/");
		} finally {
			for (const [name, value] of [
				["RYU_API_KEY", saved.key],
				["RYU_ORGANIZATION_ID", saved.org],
			] as const) {
				if (value === undefined) {
					delete process.env[name];
				} else {
					process.env[name] = value;
				}
			}
		}
	});

	test("an organization client never falls back to the Core token", async () => {
		const saved = {
			core: process.env.RYU_CORE_TOKEN,
			legacy: process.env.RYU_TOKEN,
			key: process.env.RYU_API_KEY,
		};
		process.env.RYU_CORE_TOKEN = "core-node-token";
		process.env.RYU_TOKEN = "legacy-node-token";
		delete process.env.RYU_API_KEY;
		try {
			const stub = transport(() => ok({ version: version() }));
			const client = new PromptClient({
				baseUrl: "https://api.test",
				organizationId: "org1",
				fetch: stub.fetch,
			});
			// No API key: a configuration error, never an unauthenticated
			// request, a Core-token request, or a quiet fallback.
			await expect(
				client.get("triage", { fallback: "never used" })
			).rejects.toThrow("pass apiKey or set RYU_API_KEY");
			expect(stub.calls).toHaveLength(0);

			const nodeStub = transport(() => ok({ version: version() }));
			await new PromptClient({ baseUrl: BASE, fetch: nodeStub.fetch }).get(
				"triage"
			);
			expect(nodeStub.calls[0]?.headers.authorization).toBe(
				"Bearer core-node-token"
			);
		} finally {
			for (const [name, value] of [
				["RYU_CORE_TOKEN", saved.core],
				["RYU_TOKEN", saved.legacy],
				["RYU_API_KEY", saved.key],
			] as const) {
				if (value === undefined) {
					delete process.env[name];
				} else {
					process.env[name] = value;
				}
			}
		}
	});

	test("the hosted registry sends a ryu_ API key from the environment", async () => {
		await withEnv(
			{
				RYU_API_KEY: "ryu_env_key",
				RYU_API_URL: "https://api.env.test/",
				RYU_CORE_TOKEN: "core-node-token",
				RYU_ORGANIZATION_ID: "org-env",
			},
			async () => {
				const stub = transport(() => ok({ version: version() }));
				await new PromptClient({ hosted: true, fetch: stub.fetch }).get(
					"triage"
				);
				expect(stub.calls[0]?.url).toBe(
					"https://api.env.test/api/control-plane/orgs/org-env/prompts/triage/resolve?label=production"
				);
				expect(stub.calls[0]?.headers).toEqual({
					accept: "application/json",
					"x-api-key": "ryu_env_key",
					"x-ryu-organization": "org-env",
				});
			}
		);
	});

	test("explicit apiKey and organizationId win, and the origin defaults to api.ryuhq.com", async () => {
		await withEnv(
			{
				RYU_API_KEY: "ryu_env_key",
				RYU_API_URL: undefined,
				RYU_CORE_URL: "http://core.test",
				RYU_ORGANIZATION_ID: "org-env",
			},
			async () => {
				const stub = transport(() => ok({ version: version() }));
				await new PromptClient({
					apiKey: "ryu_explicit",
					organizationId: "org1",
					fetch: stub.fetch,
				}).get("triage");
				expect(stub.calls[0]?.url).toBe(
					"https://api.ryuhq.com/api/control-plane/orgs/org1/prompts/triage/resolve?label=production"
				);
				expect(stub.calls[0]?.headers["x-api-key"]).toBe("ryu_explicit");
				expect(stub.calls[0]?.headers["x-ryu-organization"]).toBe("org1");
				expect(stub.calls[0]?.headers.authorization).toBeUndefined();
			}
		);
	});

	test("the hosted registry without an organization fails before any request", async () => {
		await withEnv(
			{ RYU_API_KEY: "ryu_env_key", RYU_ORGANIZATION_ID: undefined },
			async () => {
				const stub = transport(() => ok({ version: version() }));
				const client = new PromptClient({ hosted: true, fetch: stub.fetch });
				await expect(
					client.get("triage", { fallback: "never used" })
				).rejects.toThrow("needs organizationId or RYU_ORGANIZATION_ID");
				expect(stub.calls).toHaveLength(0);
			}
		);
	});

	test("a hosted client refuses an empty or Core token before any request", async () => {
		await withEnv(
			{
				RYU_API_KEY: undefined,
				RYU_CORE_TOKEN: "core-node-token",
				RYU_TOKEN: undefined,
			},
			async () => {
				const stub = transport(() => ok({ version: version() }));
				const empty = new PromptClient({
					organizationId: "org1",
					token: "",
					fetch: stub.fetch,
				});
				await expect(
					empty.get("triage", { fallback: "never used" })
				).rejects.toThrow("needs a session token or an API key");
				const core = new PromptClient({
					organizationId: "org1",
					token: process.env.RYU_CORE_TOKEN,
					fetch: stub.fetch,
				});
				await expect(
					core.get("triage", { fallback: "never used" })
				).rejects.toThrow("never the Core token");
				expect(stub.calls).toHaveLength(0);
			}
		);
	});

	test("an explicit hosted session token goes to the control plane, not RYU_CORE_URL", async () => {
		await withEnv(
			{
				RYU_API_URL: undefined,
				RYU_CORE_TOKEN: "core-node-token",
				RYU_CORE_URL: "http://core.test",
			},
			async () => {
				const stub = transport(() => ok({ version: version() }));
				await new PromptClient({
					organizationId: "org1",
					token: "session-token",
					fetch: stub.fetch,
				}).get("triage");
				expect(stub.calls[0]?.url).toStartWith(
					"https://api.ryuhq.com/api/control-plane/orgs/org1/prompts/"
				);
				expect(stub.calls[0]?.headers.authorization).toBe(
					"Bearer session-token"
				);
			}
		);
	});

	test("an apiKey and a session token together are refused", () => {
		expect(
			() =>
				new PromptClient({
					apiKey: "ryu_x",
					organizationId: "org1",
					token: "session",
				})
		).toThrow("apiKey or a session token, not both");
	});

	test("a hosted scope refusal surfaces its code", async () => {
		await withEnv({ RYU_API_KEY: "ryu_read_only" }, async () => {
			const stub = transport(
				() =>
					new Response(
						"prompt_insufficient_scope: api key missing required scope: prompts:manage",
						{ status: 403 }
					)
			);
			const client = new PromptClient({
				organizationId: "org1",
				fetch: stub.fetch,
			});
			const error = await client
				.setLabel("triage", "production", 2)
				.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(PromptRegistryError);
			expect(error).toMatchObject({
				status: 403,
				code: "prompt_insufficient_scope",
			});
		});
	});

	test("caches within the TTL and refetches after it", async () => {
		let now = 0;
		const stub = transport(() => ok({ version: version() }));
		const client = new PromptClient(
			{ baseUrl: BASE, fetch: stub.fetch, cacheTtlMs: 1000 },
			() => now
		);
		await client.get("triage");
		await client.get("triage");
		expect(stub.calls).toHaveLength(1);
		await client.get("triage", { label: "staging" });
		expect(stub.calls).toHaveLength(2);
		now = 1500;
		await client.get("triage");
		expect(stub.calls).toHaveLength(3);
	});

	test("serves the last good copy when a refresh fails", async () => {
		let now = 0;
		let fail = false;
		const stub = transport(() =>
			fail ? new Response("down", { status: 503 }) : ok({ version: version() })
		);
		const client = new PromptClient(
			{ baseUrl: BASE, fetch: stub.fetch, cacheTtlMs: 10 },
			() => now
		);
		const first = await client.get("triage");
		fail = true;
		now = 100;
		expect(await client.get("triage")).toBe(first);
	});

	test("falls back when the registry never answered", async () => {
		const stub = transport(() => {
			throw new TypeError("connect ECONNREFUSED");
		});
		const client = new PromptClient({ baseUrl: BASE, fetch: stub.fetch });
		const text = await client.get("triage", { fallback: "Hi {{name}}" });
		expect(text.isFallback).toBe(true);
		expect(text.version).toBe(0);
		expect(text.variables).toEqual(["name"]);
		const chat = await client.get("chatty", {
			fallback: [
				{ role: "system", content: "Be {{tone}}." },
				{ type: "placeholder", name: "history" },
			],
		});
		expect(chat).toBeInstanceOf(ChatPrompt);
		expect(chat.variables).toEqual(["tone"]);
	});

	test("unknown prompts throw a registry error with the code", async () => {
		const stub = transport(
			() =>
				new Response('prompt_not_found: no prompt named "x"', {
					status: 404,
				})
		);
		const client = new PromptClient({ baseUrl: BASE, fetch: stub.fetch });
		const error = await client.get("x").catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(PromptRegistryError);
		expect((error as PromptRegistryError).status).toBe(404);
		expect((error as PromptRegistryError).code).toBe("prompt_not_found");
	});

	test("label and version together are refused", async () => {
		const client = new PromptClient({ baseUrl: BASE });
		await expect(
			client.get("triage", { label: "production", version: 1 })
		).rejects.toThrow("label or a version");
	});
});

describe("redirects", () => {
	test("requests ask fetch not to follow redirects and refuse a 3xx", async () => {
		const inits: (RequestInit | undefined)[] = [];
		const client = new PromptClient({
			apiKey: "ryu_secret",
			baseUrl: "https://api.test",
			organizationId: "org1",
			fetch: (_input, init) => {
				inits.push(init);
				return Promise.resolve(
					Response.redirect("https://elsewhere.test/", 307)
				);
			},
		});
		const error = await client.list().catch((caught: unknown) => caught);
		expect(inits[0]?.redirect).toBe("manual");
		expect(error).toBeInstanceOf(PromptRegistryError);
		expect(error).toMatchObject({ status: 307, code: "redirect_refused" });
	});

	test("a cross-origin redirect never delivers the API key to the other origin", async () => {
		const seen: Record<string, string | null>[] = [];
		const other = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request) => {
				seen.push({
					key: request.headers.get("x-api-key"),
					org: request.headers.get("x-ryu-organization"),
				});
				return Response.json({ prompts: [] });
			},
		});
		const origin = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				Response.redirect(`http://127.0.0.1:${other.port}/stolen`, 307),
		});
		try {
			const client = new PromptClient({
				apiKey: "ryu_secret",
				baseUrl: `http://127.0.0.1:${origin.port}`,
				organizationId: "org1",
			});
			const error = await client.list().catch((caught: unknown) => caught);
			expect(error).toMatchObject({ code: "redirect_refused" });
			expect(seen).toEqual([]);
		} finally {
			origin.stop(true);
			other.stop(true);
		}
	});
});

describe("chat prompts", () => {
	test("compile renders messages and splices placeholders", () => {
		const prompt = new ChatPrompt({
			name: "chat",
			version: 1,
			variables: ["team", "question"],
			messages: [
				{ role: "system", content: "You help {{team}}." },
				{ type: "placeholder", name: "history" },
				{ role: "user", content: "{{question}}" },
			],
		});
		expect(prompt.placeholders).toEqual(["history"]);
		expect(
			prompt.compile(
				{ team: "billing", question: "refund?" },
				{
					placeholders: {
						history: [
							{ role: "user", content: "hi" },
							{ role: "assistant", content: "hello" },
						],
					},
				}
			)
		).toEqual([
			{ role: "system", content: "You help billing." },
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
			{ role: "user", content: "refund?" },
		]);
		expect(prompt.toInstructions({ team: "ops" })).toBe("You help ops.");
		expect(() => prompt.compile({ team: "ops" }, { strict: true })).toThrow(
			"history, question"
		);
	});
});

describe("management", () => {
	test("commit posts the version and invalidates the cache", async () => {
		const stub = transport((call) =>
			call.method === "POST"
				? ok({
						prompt: {
							name: "triage",
							description: null,
							tags: [],
							type: "text",
							latestVersion: 4,
							labels: { production: 4 },
							createdAt: "",
							updatedAt: "",
						},
						version: version({ version: 4 }),
					})
				: ok({ version: version() })
		);
		const client = new PromptClient({ baseUrl: BASE, fetch: stub.fetch });
		await client.get("triage");
		const committed = await client.commit("triage", {
			type: "text",
			template: "New {{team}}",
			labels: ["production"],
		});
		expect(committed.version).toBe(4);
		expect(stub.calls[1]?.url).toBe(`${BASE}/api/prompts/triage/versions`);
		expect(JSON.parse(stub.calls[1]?.body ?? "{}")).toMatchObject({
			labels: ["production"],
		});
		await client.get("triage");
		expect(stub.calls).toHaveLength(3);
	});

	test("setLabel moves a label", async () => {
		const stub = transport(() =>
			ok({
				prompt: {
					name: "triage",
					description: null,
					tags: [],
					type: "text",
					latestVersion: 4,
					labels: { production: 2 },
					createdAt: "",
					updatedAt: "",
				},
			})
		);
		const client = new PromptClient({ baseUrl: BASE, fetch: stub.fetch });
		const summary = await client.setLabel("triage", "production", 2);
		expect(summary.labels).toEqual({ production: 2 });
		expect(stub.calls[0]).toMatchObject({
			method: "PUT",
			url: `${BASE}/api/prompts/triage/labels/production`,
			body: '{"version":2}',
		});
	});
});

describe("agent instructions", () => {
	test("resolveInstructions passes strings through and compiles references", async () => {
		expect(await resolveInstructions("plain")).toBe("plain");
		const stub = transport(() => ok({ version: version() }));
		const client = new PromptClient({ baseUrl: BASE, fetch: stub.fetch });
		expect(
			await resolveInstructions({
				prompt: "triage",
				client,
				label: "staging",
				variables: { team: "ops" },
			})
		).toBe("Triage for ops.");
		expect(stub.calls[0]?.url).toContain("label=staging");
	});

	test("an Agent sends the resolved prompt as its system message", async () => {
		const original = globalThis.fetch;
		const bodies: unknown[] = [];
		globalThis.fetch = Object.assign(
			(
				input: Parameters<typeof globalThis.fetch>[0],
				init?: Parameters<typeof globalThis.fetch>[1]
			) => {
				bodies.push(
					modelBodyFixtureSchema.parse(JSON.parse(String(init?.body ?? "{}")))
				);
				expect(String(input)).toContain("/v1/chat/completions");
				return Promise.resolve(
					ok({
						choices: [{ finish_reason: "stop", message: { content: "done" } }],
					})
				);
			},
			{ preconnect: original.preconnect }
		);
		try {
			const stub = transport(() => ok({ version: version() }));
			const client = new PromptClient({ baseUrl: BASE, fetch: stub.fetch });
			const agent = new Agent({
				name: "triage",
				model: "m",
				node: { baseUrl: BASE },
				core: { baseUrl: BASE },
				instructions: { prompt: "triage", client, variables: { team: "ops" } },
			});
			const result = await agent.generate("help");
			expect(result.text).toBe("done");
			expect(bodies[0]).toMatchObject({
				messages: [
					{ role: "system", content: "Triage for ops." },
					{ role: "user", content: "help" },
				],
			});
		} finally {
			globalThis.fetch = original;
		}
	});

	test("an unresolvable reference fails the run with an error event", async () => {
		const stub = transport(() => new Response("down", { status: 503 }));
		const client = new PromptClient({ baseUrl: BASE, fetch: stub.fetch });
		const agent = new Agent({
			name: "triage",
			model: "m",
			node: { baseUrl: BASE },
			instructions: { prompt: "triage", client },
		});
		const events: AgentEvent[] = [];
		for await (const event of agent.stream("help")) {
			events.push(event);
		}
		expect(events).toEqual([
			{
				type: "error",
				message: "instructions prompt could not be resolved: down",
			},
		]);
	});
});
