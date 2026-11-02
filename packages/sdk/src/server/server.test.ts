/**
 * Route tests for `createRyuServer`. Requests go straight to `server.fetch`
 * (plus one round trip through the Node adapter). The agent loop's gateway is
 * a stubbed `fetch` that answers chat completions from a queue, so no model or
 * node is needed.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import { Agent } from "../agent/agent.ts";
import type { ToolCall } from "../agent/model-call.ts";
import { AgentNetwork, handoff } from "../agent/network.ts";
import type { RunnableContext } from "../runnable/runnable-types.ts";
import { defineTool } from "../runnable/tool.ts";
import { createStep } from "../workflow/step.ts";
import { createWorkflow } from "../workflow/workflow.ts";
import { serve } from "./node.ts";
import { createMemoryRunStore } from "./runs.ts";
import {
	bearerAuth,
	createRyuServer,
	type RyuServerConfig,
	resolveDeployedServer,
	resolveRyuServer,
} from "./server.ts";

const NODE = "http://127.0.0.1:7981";

// ── Gateway stub ──────────────────────────────────────────────────────────────

let modelQueue: unknown[] = [];
let originalFetch: typeof globalThis.fetch;

function modelResponse(opts: {
	content?: string | null;
	toolCalls?: ToolCall[];
}) {
	const toolCalls = opts.toolCalls ?? [];
	return {
		choices: [
			{
				finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
				message: {
					content: opts.content ?? null,
					tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
				},
			},
		],
		usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
	};
}

function toolCall(id: string, name: string, args: unknown): ToolCall {
	return {
		id,
		type: "function",
		function: { name, arguments: JSON.stringify(args) },
	};
}

beforeEach(() => {
	originalFetch = globalThis.fetch;
	modelQueue = [];
	globalThis.fetch = Object.assign(
		(
			input: Parameters<typeof globalThis.fetch>[0],
			init?: Parameters<typeof globalThis.fetch>[1]
		) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.includes("/v1/chat/completions")) {
				const next = modelQueue.shift() ?? modelResponse({ content: "done" });
				return Promise.resolve(
					new Response(JSON.stringify(next), { status: 200 })
				);
			}
			return originalFetch(input, init);
		},
		{ preconnect: originalFetch.preconnect }
	);
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const runtime = (): RunnableContext => ({
	gateway: {
		chat: () => Promise.reject(new Error("no gateway in tests")),
		stream: () => {
			throw new Error("no gateway in tests");
		},
	},
});

const weather = defineTool({
	id: "tool-weather",
	name: "Weather",
	description: "Current weather for a city",
	schema: z.object({ city: z.string() }),
	run: async ({ city }) => ({ city, tempC: 21 }),
});

const deleteFile = defineTool({
	id: "tool-delete",
	name: "Delete file",
	needsApproval: true,
	schema: { type: "object", properties: { path: { type: "string" } } },
	run: async (input) => ({ deleted: input.path }),
});

function makeAgent() {
	return new Agent({
		name: "assistant",
		model: "test-model",
		description: "Answers questions",
		instructions: "Be brief.",
		node: { baseUrl: NODE },
		tools: { weather, deleteFile },
	});
}

const upper = createStep({
	id: "upper",
	inputSchema: z.object({ text: z.string() }),
	execute: ({ inputData }) => ({ text: inputData.text.toUpperCase() }),
});

const approve = createStep({
	id: "approve",
	execute: async ({ inputData, resumeData, suspend, setState }) => {
		if (resumeData === undefined) {
			return await suspend({ question: "ship it?" });
		}
		setState({ approvedBy: resumeData });
		return { ...(inputData as object), approvedBy: resumeData };
	},
});

function makeWorkflows() {
	const shout = createWorkflow({
		id: "shout",
		description: "Upper-cases text",
		inputSchema: z.object({ text: z.string() }),
	})
		.then(upper)
		.commit();
	const gated = createWorkflow({ id: "gated" })
		.then(upper)
		.then(approve)
		.commit();
	return { shout, gated };
}

function makeConfig(overrides: Partial<RyuServerConfig> = {}): RyuServerConfig {
	return {
		agents: { assistant: makeAgent() },
		workflows: makeWorkflows(),
		tools: { weather },
		runtime,
		...overrides,
	};
}

function request(
	path: string,
	init?: { body?: unknown; headers?: Record<string, string>; method?: string }
) {
	return new Request(`http://localhost${path}`, {
		method: init?.method ?? (init?.body === undefined ? "GET" : "POST"),
		headers: { "content-type": "application/json", ...init?.headers },
		body: init?.body === undefined ? undefined : JSON.stringify(init.body),
	});
}

interface SseEvent {
	data: unknown;
	event: string;
}

/** Read an SSE response to the end, calling `onEvent` as frames arrive. */
async function readSse(
	response: Response,
	onEvent?: (event: SseEvent) => Promise<void> | void
): Promise<SseEvent[]> {
	const type = response.headers.get("content-type") ?? "";
	if (!type.includes("text/event-stream")) {
		throw new Error(
			`expected an SSE response, got ${type}: ${await response.text()}`
		);
	}
	const events: SseEvent[] = [];
	const reader = response.body?.getReader();
	if (!reader) {
		throw new Error("no body");
	}
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		let index = buffer.indexOf("\n\n");
		while (index >= 0) {
			const frame = buffer.slice(0, index);
			buffer = buffer.slice(index + 2);
			const name = /^event: (.*)$/m.exec(frame)?.[1];
			const data = /^data: (.*)$/m.exec(frame)?.[1];
			if (name && data !== undefined) {
				const event = { event: name, data: JSON.parse(data) };
				events.push(event);
				await onEvent?.(event);
			}
			index = buffer.indexOf("\n\n");
		}
	}
	return events;
}

const bodySchema = z.record(z.string(), z.unknown());
async function jsonOf(response: Response) {
	return bodySchema.parse(await response.json());
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createRyuServer: discovery", () => {
	it("lists registered agents, workflows, and tools", async () => {
		const server = createRyuServer(makeConfig());
		const index = await jsonOf(await server.fetch(request("/api")));
		expect(index).toMatchObject({
			agents: ["assistant"],
			workflows: ["shout", "gated"],
			tools: ["weather"],
			openapi: "/api/openapi.json",
		});

		const agents = await jsonOf(await server.fetch(request("/api/agents")));
		expect(agents.agents).toEqual([
			{
				id: "assistant",
				kind: "agent",
				name: "assistant",
				description: "Answers questions",
				model: "test-model",
				instructions: "Be brief.",
				structuredOutput: false,
				tools: [
					{
						name: "weather",
						kind: "local",
						id: "tool-weather",
						description: "Current weather for a city",
						needsApproval: false,
					},
					{
						name: "deleteFile",
						kind: "local",
						id: "tool-delete",
						description: undefined,
						needsApproval: true,
					},
				],
			},
		]);

		const wf = await jsonOf(
			await server.fetch(request("/api/workflows/gated"))
		);
		expect(wf.graph).toEqual({
			nodes: [
				{ id: "upper", kind: "step", label: "upper" },
				{ id: "approve", kind: "step", label: "approve" },
			],
			edges: [{ from: "upper", to: "approve" }],
		});

		const tool = await jsonOf(
			await server.fetch(request("/api/tools/weather"))
		);
		expect(tool).toMatchObject({
			id: "weather",
			toolId: "tool-weather",
			schema: { type: "object", properties: { city: { type: "string" } } },
		});
	});

	it("describes networks by their members", async () => {
		const researcher = new Agent({
			name: "researcher",
			model: "m",
			node: { baseUrl: NODE },
		});
		const writer = new Agent({
			name: "writer",
			model: "m",
			node: { baseUrl: NODE },
		});
		const server = createRyuServer({
			agents: {
				team: new AgentNetwork({ agents: [researcher, writer], name: "team" }),
			},
		});
		const body = await jsonOf(await server.fetch(request("/api/agents/team")));
		expect(body).toMatchObject({
			kind: "network",
			name: "team",
			entry: "researcher",
			members: ["researcher", "writer"],
		});
	});

	it("returns JSON errors for unknown routes, ids, and methods", async () => {
		const server = createRyuServer(makeConfig());
		const missing = await server.fetch(request("/api/agents/nope"));
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({
			error: { code: "not_found", message: 'agent "nope" is not registered' },
		});
		expect((await server.fetch(request("/elsewhere"))).status).toBe(404);
		expect(
			(await server.fetch(request("/api/agents", { method: "DELETE" }))).status
		).toBe(405);
		// Prototype keys are not registry entries.
		expect((await server.fetch(request("/api/tools/constructor"))).status).toBe(
			404
		);
	});

	it("honors a custom base path", async () => {
		const server = createRyuServer(makeConfig({ basePath: "ryu/" }));
		expect(server.basePath).toBe("/ryu");
		expect((await server.fetch(request("/ryu/tools"))).status).toBe(200);
		expect((await server.fetch(request("/api/tools"))).status).toBe(404);
	});
});

describe("createRyuServer: OpenAPI", () => {
	it("emits a concrete path per agent, workflow, and tool with their schemas", async () => {
		const server = createRyuServer(makeConfig({ info: { title: "Demo" } }));
		const doc = await jsonOf(await server.fetch(request("/api/openapi.json")));
		expect(doc.openapi).toBe("3.1.0");
		expect(doc.info).toEqual({ title: "Demo", version: "1.0.0" });
		const paths = z.record(z.string(), z.unknown()).parse(doc.paths);
		expect(Object.keys(paths).sort()).toMatchSnapshot();
		const execute = z
			.object({
				post: z.object({
					requestBody: z.object({
						content: z.object({
							"application/json": z.object({
								schema: z.object({
									properties: z.object({ input: z.unknown() }),
								}),
							}),
						}),
					}),
				}),
			})
			.parse(paths["/api/tools/weather/execute"]);
		expect(
			execute.post.requestBody.content["application/json"].schema.properties
				.input
		).toMatchObject({
			type: "object",
			properties: { city: { type: "string" } },
		});
		const start = JSON.stringify(paths["/api/workflows/shout/start"]);
		expect(start).toContain('"text":{"type":"string"}');
		expect(doc.security).toBeUndefined();
	});

	it("declares bearer security when an auth hook is set", () => {
		const doc = createRyuServer(
			makeConfig({ auth: bearerAuth("s3cret") })
		).openapi();
		expect(doc.security).toEqual([{ bearer: [] }]);
	});
});

describe("createRyuServer: auth", () => {
	it("guards API routes with the auth hook but serves the studio page", async () => {
		const server = createRyuServer(
			makeConfig({ auth: bearerAuth("s3cret"), studio: true })
		);
		expect((await server.fetch(request("/api/agents"))).status).toBe(401);
		expect(
			(
				await server.fetch(
					request("/api/agents", { headers: { authorization: "Bearer wrong" } })
				)
			).status
		).toBe(401);
		expect(
			(
				await server.fetch(
					request("/api/agents", {
						headers: { authorization: "Bearer s3cret" },
					})
				)
			).status
		).toBe(200);
		const studio = await server.fetch(request("/"));
		expect(studio.status).toBe(200);
		const html = await studio.text();
		expect(html).toContain("<title>Ryu Studio</title>");
		expect(html).toContain('const BASE = "/api";');
		expect(studio.headers.get("content-security-policy")).toContain(
			"connect-src 'self'"
		);
	});

	it("passes through a Response from the hook and refuses an empty bearer token", async () => {
		const server = createRyuServer(
			makeConfig({ auth: () => new Response("teapot", { status: 418 }) })
		);
		expect((await server.fetch(request("/api/agents"))).status).toBe(418);
		expect(() => bearerAuth("")).toThrow(/non-empty token/);
	});

	it("does not serve the studio unless enabled", async () => {
		const server = createRyuServer(makeConfig());
		expect((await server.fetch(request("/studio"))).status).toBe(404);
	});
});

describe("createRyuServer: agents", () => {
	it("generates a reply and records the run as a trace", async () => {
		modelQueue = [modelResponse({ content: "Hello there" })];
		const server = createRyuServer(makeConfig());
		const res = await server.fetch(
			request("/api/agents/assistant/generate", { body: { prompt: "hi" } })
		);
		expect(res.status).toBe(200);
		const body = await jsonOf(res);
		expect(body).toMatchObject({
			status: "success",
			text: "Hello there",
			steps: 1,
		});

		const traces = await jsonOf(
			await server.fetch(request("/api/traces?kind=agent"))
		);
		const [trace] = z
			.array(z.object({ id: z.string(), status: z.string() }))
			.parse(traces.runs);
		expect(trace).toMatchObject({ id: body.runId, status: "success" });
		const detail = await jsonOf(
			await server.fetch(request(`/api/traces/${body.runId}`))
		);
		const types = z
			.array(z.object({ type: z.string() }))
			.parse(detail.events)
			.map((e) => e.type);
		expect(types).toEqual(["text", "result"]);
	});

	it("rejects a body with neither or both of prompt and messages", async () => {
		const server = createRyuServer(makeConfig());
		const neither = await server.fetch(
			request("/api/agents/assistant/generate", { body: {} })
		);
		expect(neither.status).toBe(400);
		const both = await server.fetch(
			request("/api/agents/assistant/generate", {
				body: { prompt: "a", messages: [{ role: "user", content: "b" }] },
			})
		);
		expect(both.status).toBe(400);
	});

	it("continues a transcript passed as messages", async () => {
		modelQueue = [modelResponse({ content: "second answer" })];
		const server = createRyuServer(makeConfig());
		const body = await jsonOf(
			await server.fetch(
				request("/api/agents/assistant/generate", {
					body: {
						messages: [
							{ role: "user", content: "first" },
							{ role: "assistant", content: "first answer" },
							{ role: "user", content: "second" },
						],
					},
				})
			)
		);
		expect(body.text).toBe("second answer");
	});

	it("streams tool calls and results as SSE", async () => {
		modelQueue = [
			modelResponse({
				toolCalls: [toolCall("c1", "weather", { city: "Oslo" })],
			}),
			modelResponse({ content: "It is 21C in Oslo." }),
		];
		const server = createRyuServer(makeConfig());
		const events = await readSse(
			await server.fetch(
				request("/api/agents/assistant/stream", {
					body: { prompt: "weather?" },
				})
			)
		);
		expect(events.map((e) => e.event)).toEqual([
			"run",
			"tool_call",
			"tool_result",
			"text",
			"result",
			"done",
		]);
		expect(events[2]?.data).toMatchObject({
			name: "weather",
			output: { city: "Oslo", tempC: 21 },
		});
		expect(events.at(-1)?.data).toMatchObject({ status: "success" });
	});

	it("pauses an approval-gated tool until the approval route decides", async () => {
		modelQueue = [
			modelResponse({
				toolCalls: [toolCall("c1", "deleteFile", { path: "/tmp/x" })],
			}),
			modelResponse({ content: "Deleted." }),
		];
		const server = createRyuServer(makeConfig());
		const events = await readSse(
			await server.fetch(
				request("/api/agents/assistant/stream", {
					body: { prompt: "delete it" },
				})
			),
			async ({ event, data }) => {
				if (event !== "approval_requested") {
					return;
				}
				const { approvalId } = z.object({ approvalId: z.string() }).parse(data);
				const decided = await server.fetch(
					request(`/api/approvals/${approvalId}`, { body: { approved: true } })
				);
				expect(decided.status).toBe(200);
			}
		);
		const names = events.map((e) => e.event);
		expect(names).toEqual([
			"run",
			"tool_call",
			"approval_requested",
			"tool_result",
			"text",
			"result",
			"done",
		]);
		expect(events[3]?.data).toMatchObject({ output: { deleted: "/tmp/x" } });
	});

	it("routes approvals for network members and handoff targets", async () => {
		const approveAll = async ({ event, data }: SseEvent) => {
			if (event !== "approval_requested") {
				return;
			}
			const { approvalId } = z.object({ approvalId: z.string() }).parse(data);
			const decided = await server.fetch(
				request(`/api/approvals/${approvalId}`, { body: { approved: true } })
			);
			expect(decided.status).toBe(200);
		};
		const billing = new Agent({
			name: "billing",
			model: "m",
			node: { baseUrl: NODE },
			tools: { deleteFile },
		});
		const front = new Agent({
			name: "front",
			model: "m",
			node: { baseUrl: NODE },
			tools: { toBilling: handoff(billing) },
		});
		const server = createRyuServer({
			agents: {
				team: new AgentNetwork({ agents: [billing], name: "team" }),
				front,
			},
		});

		// A network member without its own handler waits for the route.
		modelQueue = [
			modelResponse({
				toolCalls: [toolCall("c1", "deleteFile", { path: "/n" })],
			}),
			modelResponse({ content: "Deleted." }),
		];
		const network = await readSse(
			await server.fetch(
				request("/api/agents/team/stream", { body: { prompt: "delete" } })
			),
			approveAll
		);
		expect(network.find((e) => e.event === "tool_result")?.data).toMatchObject({
			agent: "billing",
			output: { deleted: "/n" },
		});
		expect(network.at(-1)).toMatchObject({ data: { status: "success" } });

		// A follow-up turn (messages) follows the handoff, and the target's
		// approval reaches the same route.
		modelQueue = [
			modelResponse({ toolCalls: [toolCall("h1", "toBilling", {})] }),
			modelResponse({
				toolCalls: [toolCall("c2", "deleteFile", { path: "/h" })],
			}),
			modelResponse({ content: "Billing deleted it." }),
		];
		const followUp = await readSse(
			await server.fetch(
				request("/api/agents/front/stream", {
					body: {
						messages: [
							{ role: "user", content: "hi" },
							{ role: "assistant", content: "Hello." },
							{ role: "user", content: "delete my file" },
						],
					},
				})
			),
			approveAll
		);
		expect(
			followUp.find(
				(e) =>
					e.event === "tool_result" &&
					z.object({ name: z.string() }).parse(e.data).name === "deleteFile"
			)?.data
		).toMatchObject({ output: { deleted: "/h" } });
		expect(followUp.find((e) => e.event === "result")?.data).toMatchObject({
			text: "Billing deleted it.",
		});
	});

	it("feeds a denial back to the model and 404s an unknown approval", async () => {
		modelQueue = [
			modelResponse({
				toolCalls: [toolCall("c1", "deleteFile", { path: "/x" })],
			}),
			modelResponse({ content: "Okay, not deleting." }),
		];
		const server = createRyuServer(makeConfig());
		const events = await readSse(
			await server.fetch(
				request("/api/agents/assistant/stream", { body: { prompt: "delete" } })
			),
			async ({ event, data }) => {
				if (event === "approval_requested") {
					const { approvalId } = z
						.object({ approvalId: z.string() })
						.parse(data);
					await server.fetch(
						request(`/api/approvals/${approvalId}`, {
							body: { approved: false },
						})
					);
				}
			}
		);
		const result = events.find((e) => e.event === "tool_result");
		expect(result?.data).toMatchObject({
			output: { error: "tool execution was not approved" },
		});
		const unknown = await server.fetch(
			request("/api/approvals/nope", { body: { approved: true } })
		);
		expect(unknown.status).toBe(404);
	});

	it("denies a pending approval when it times out", async () => {
		modelQueue = [
			modelResponse({
				toolCalls: [toolCall("c1", "deleteFile", { path: "/x" })],
			}),
			modelResponse({ content: "Timed out." }),
		];
		const server = createRyuServer(makeConfig({ approvalTimeoutMs: 20 }));
		const events = await readSse(
			await server.fetch(
				request("/api/agents/assistant/stream", { body: { prompt: "delete" } })
			)
		);
		expect(events.find((e) => e.event === "tool_result")?.data).toMatchObject({
			output: { error: "tool execution was not approved" },
		});
	});

	it("reports a paused generate when a tool needs approval", async () => {
		modelQueue = [
			modelResponse({
				toolCalls: [toolCall("c1", "deleteFile", { path: "/x" })],
			}),
		];
		const server = createRyuServer(makeConfig());
		const body = await jsonOf(
			await server.fetch(
				request("/api/agents/assistant/generate", {
					body: { prompt: "delete" },
				})
			)
		);
		expect(body.status).toBe("paused");
		expect(body.approvalRequired).toMatchObject({
			type: "approval_requested",
			name: "deleteFile",
		});
	});
});

describe("createRyuServer: workflows", () => {
	it("starts a workflow and returns its result", async () => {
		const server = createRyuServer(makeConfig());
		const res = await server.fetch(
			request("/api/workflows/shout/start", {
				body: { inputData: { text: "hey" } },
			})
		);
		const body = await jsonOf(res);
		expect(body).toMatchObject({ status: "success", result: { text: "HEY" } });
	});

	it("reports invalid input as a failed run", async () => {
		const server = createRyuServer(makeConfig());
		const body = await jsonOf(
			await server.fetch(
				request("/api/workflows/shout/start", {
					body: { inputData: { text: 1 } },
				})
			)
		);
		expect(body.status).toBe("failed");
		expect(typeof body.error).toBe("string");
	});

	it("streams events and values, then the result", async () => {
		const server = createRyuServer(makeConfig());
		const events = await readSse(
			await server.fetch(
				request("/api/workflows/shout/stream", {
					body: { inputData: { text: "a" }, streamMode: ["events", "values"] },
				})
			)
		);
		const names = events.map((e) => e.event);
		expect(names[0]).toBe("run");
		expect(names).toContain("events");
		expect(names).toContain("values");
		expect(names.slice(-2)).toEqual(["result", "done"]);
		expect(events.at(-2)?.data).toMatchObject({
			status: "success",
			result: { text: "A" },
		});
		const stepEvents = events
			.filter((e) => e.event === "events")
			.map((e) => z.object({ type: z.string() }).parse(e.data).type);
		expect(stepEvents).toEqual([
			"workflow-start",
			"step-start",
			"step-result",
			"workflow-finish",
		]);
	});

	it("suspends, lists history, and resumes on another server from the stored snapshot", async () => {
		const runStore = createMemoryRunStore();
		const first = createRyuServer(makeConfig({ runStore }));
		const started = await jsonOf(
			await first.fetch(
				request("/api/workflows/gated/start", {
					body: { inputData: { text: "go" }, runId: "run-1" },
				})
			)
		);
		expect(started).toMatchObject({
			runId: "run-1",
			status: "suspended",
			suspended: [
				{
					path: "approve",
					stepId: "approve",
					payload: { question: "ship it?" },
				},
			],
		});

		const history = await jsonOf(
			await first.fetch(request("/api/workflows/gated/runs"))
		);
		expect(history.runs).toMatchObject([{ id: "run-1", status: "suspended" }]);

		const duplicate = await first.fetch(
			request("/api/workflows/gated/start", { body: { runId: "run-1" } })
		);
		expect(duplicate.status).toBe(409);

		// A second server (another process/invocation) sharing the store.
		const second = createRyuServer(makeConfig({ runStore }));
		const resumed = await jsonOf(
			await second.fetch(
				request("/api/workflows/gated/runs/run-1/resume", {
					body: { resumeData: "jay", step: "approve" },
				})
			)
		);
		expect(resumed).toMatchObject({
			status: "success",
			result: { text: "GO", approvedBy: "jay" },
			state: { approvedBy: "jay" },
		});

		const again = await second.fetch(
			request("/api/workflows/gated/runs/run-1/resume", { body: {} })
		);
		expect(again.status).toBe(409);

		const detail = await jsonOf(
			await second.fetch(request("/api/workflows/gated/runs/run-1"))
		);
		expect(detail.status).toBe("success");
		const types = z
			.array(z.object({ type: z.string() }))
			.parse(detail.events)
			.map((e) => e.type);
		expect(types).toContain("step-suspended");
		expect(types.at(-1)).toBe("workflow-finish");
	});

	it("resumes over SSE and 404s runs of other workflows", async () => {
		const server = createRyuServer(makeConfig());
		const started = await jsonOf(
			await server.fetch(
				request("/api/workflows/gated/start", {
					body: { inputData: { text: "x" } },
				})
			)
		);
		const runId = String(started.runId);
		expect(
			(await server.fetch(request(`/api/workflows/shout/runs/${runId}`))).status
		).toBe(404);
		const events = await readSse(
			await server.fetch(
				request(`/api/workflows/gated/runs/${runId}/resume/stream`, {
					body: { resumeData: "ok" },
				})
			)
		);
		expect(events.at(-2)).toMatchObject({
			event: "result",
			data: { status: "success", result: { text: "X", approvedBy: "ok" } },
		});
	});

	it("leaves a run suspended when a resume names an unknown step", async () => {
		const server = createRyuServer(makeConfig());
		const started = await jsonOf(
			await server.fetch(
				request("/api/workflows/gated/start", {
					body: { inputData: { text: "x" } },
				})
			)
		);
		const runId = String(started.runId);
		for (const path of ["resume", "resume/stream"]) {
			const refused = await server.fetch(
				request(`/api/workflows/gated/runs/${runId}/${path}`, {
					body: { resumeData: "ok", step: "nope" },
				})
			);
			expect(refused.status).toBe(409);
			expect(
				await jsonOf(await server.fetch(request(`/api/traces/${runId}`)))
			).toMatchObject({ status: "suspended" });
		}
		const resumed = await jsonOf(
			await server.fetch(
				request(`/api/workflows/gated/runs/${runId}/resume`, {
					body: { resumeData: "ok" },
				})
			)
		);
		expect(resumed).toMatchObject({ status: "success" });
	});

	it("claims a resuming run so a second server cannot resume it twice", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((done) => {
			release = done;
		});
		let executions = 0;
		const slow = createStep({
			id: "slow",
			execute: async ({ resumeData, suspend }) => {
				if (resumeData === undefined) {
					return await suspend({ wait: true });
				}
				executions += 1;
				await gate;
				return { resumed: resumeData };
			},
		});
		const workflows = {
			slow: createWorkflow({ id: "slow" }).then(slow).commit(),
		};
		const runStore = createMemoryRunStore();
		const first = createRyuServer({ workflows, runtime, runStore });
		const second = createRyuServer({ workflows, runtime, runStore });
		const started = await jsonOf(
			await first.fetch(request("/api/workflows/slow/start", { body: {} }))
		);
		const runId = String(started.runId);
		const pending = first.fetch(
			request(`/api/workflows/slow/runs/${runId}/resume`, {
				body: { resumeData: 1 },
			})
		);
		while (executions === 0) {
			await Bun.sleep(1);
		}
		for (const server of [first, second]) {
			const again = await server.fetch(
				request(`/api/workflows/slow/runs/${runId}/resume`, {
					body: { resumeData: 2 },
				})
			);
			expect(again.status).toBe(409);
		}
		release();
		expect(await jsonOf(await pending)).toMatchObject({
			status: "success",
			result: { resumed: 1 },
		});
		expect(executions).toBe(1);
	});

	it("refuses to cancel a run that is not running", async () => {
		const server = createRyuServer(makeConfig());
		const res = await server.fetch(
			request("/api/workflows/shout/runs/none/cancel", { method: "POST" })
		);
		expect(res.status).toBe(409);
	});
});

describe("createRyuServer: tools", () => {
	it("executes a tool and records it", async () => {
		const server = createRyuServer(makeConfig());
		const body = await jsonOf(
			await server.fetch(
				request("/api/tools/weather/execute", {
					body: { input: { city: "Rome" } },
				})
			)
		);
		expect(body.output).toEqual({ city: "Rome", tempC: 21 });
		const traces = await jsonOf(
			await server.fetch(request("/api/traces?kind=tool&target=weather"))
		);
		expect(traces.runs).toMatchObject([{ kind: "tool", status: "success" }]);
	});

	it("refuses to run a needsApproval tool directly unless opted in", async () => {
		const body = { input: { path: "/tmp/x" } };
		const refused = await createRyuServer(
			makeConfig({ tools: { deleteFile } })
		).fetch(request("/api/tools/deleteFile/execute", { body }));
		expect(refused.status).toBe(403);
		expect(await refused.json()).toMatchObject({
			error: { code: "approval_required" },
		});
		const allowed = await createRyuServer(
			makeConfig({ allowDirectApprovalTools: true, tools: { deleteFile } })
		).fetch(request("/api/tools/deleteFile/execute", { body }));
		expect(allowed.status).toBe(200);
		const studio = await createRyuServer(
			makeConfig({ studio: true, tools: { deleteFile } })
		).fetch(request("/api/tools/deleteFile/execute", { body }));
		expect(studio.status).toBe(200);
	});

	it("returns 422 when the tool rejects its input and 400 for bad JSON", async () => {
		const server = createRyuServer(makeConfig());
		const res = await server.fetch(
			request("/api/tools/weather/execute", { body: { input: { city: 3 } } })
		);
		expect(res.status).toBe(422);
		expect(await res.json()).toMatchObject({ error: { code: "tool_failed" } });
		const bad = await server.fetch(
			new Request("http://localhost/api/tools/weather/execute", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{nope",
			})
		);
		expect(bad.status).toBe(400);
		const huge = await server.fetch(
			new Request("http://localhost/api/tools/weather/execute", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ input: { city: "x".repeat(1_100_000) } }),
			})
		);
		expect(huge.status).toBe(413);
		// A body sent as a form or plain text (what a cross-site page can post
		// without a CORS preflight) is refused.
		const plain = await server.fetch(
			new Request("http://localhost/api/tools/weather/execute", {
				method: "POST",
				headers: { "content-type": "text/plain" },
				body: JSON.stringify({ input: { city: "Lima" } }),
			})
		);
		expect(plain.status).toBe(415);
		expect(await plain.json()).toMatchObject({
			error: { code: "unsupported_media_type" },
		});
		// A body-less no-cors POST (also preflight-free) is refused too.
		const empty = await server.fetch(
			new Request("http://localhost/api/tools/weather/execute", {
				method: "POST",
			})
		);
		expect(empty.status).toBe(415);
	});
});

describe("resolveDeployedServer", () => {
	afterEach(() => {
		Reflect.deleteProperty(process.env, "RYU_SERVER_PUBLIC");
	});

	it("refuses a server without auth unless the deployment opts out", () => {
		expect(() => resolveDeployedServer({ default: makeConfig() })).toThrow(
			/refusing to start without authentication/
		);
		process.env.RYU_SERVER_PUBLIC = "1";
		expect(resolveDeployedServer({ default: makeConfig() }).basePath).toBe(
			"/api"
		);
	});

	it("starts a server that has an auth hook", () => {
		const secured = makeConfig({ auth: bearerAuth("secret") });
		expect(resolveDeployedServer({ default: secured }).config.auth).toBe(
			secured.auth
		);
	});
});

describe("resolveRyuServer", () => {
	it("accepts a server, a config, or named exports", async () => {
		const server = createRyuServer(makeConfig());
		expect(resolveRyuServer({ default: server })).toBe(server);
		const withStudio = resolveRyuServer({ default: server }, { studio: true });
		expect((await withStudio.fetch(request("/"))).status).toBe(200);
		const fromConfig = resolveRyuServer({ default: makeConfig() });
		expect((await fromConfig.fetch(request("/api/tools/weather"))).status).toBe(
			200
		);
		const fromNamed = resolveRyuServer({ tools: { weather } });
		expect((await fromNamed.fetch(request("/api/tools/weather"))).status).toBe(
			200
		);
		expect(() => resolveRyuServer({})).toThrow(/must export/);
	});
});

describe("serve (node adapter)", () => {
	it("serves JSON and SSE over a real socket", async () => {
		const server = createRyuServer(makeConfig());
		const app = await serve({ fetch: server.fetch, port: 0 });
		try {
			const res = await fetch(`${app.url}/api/tools/weather/execute`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ input: { city: "Lima" } }),
			});
			expect(await res.json()).toMatchObject({ output: { city: "Lima" } });
			const events = await readSse(
				await fetch(`${app.url}/api/workflows/shout/stream`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ inputData: { text: "n" } }),
				})
			);
			expect(events.at(-1)?.event).toBe("done");
		} finally {
			await app.close();
		}
	});
});
