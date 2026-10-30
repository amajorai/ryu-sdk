/**
 * `toAgUiHandler` end to end over a mocked transport: the gateway, Core tool
 * routes, and Core harness routes are served by a stubbed `globalThis.fetch`,
 * and the handler is driven with real Fetch `Request`s.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "../agent/agent.ts";
import type { ToolCall } from "../agent/model-call.ts";
import { handoff } from "../agent/network.ts";
import { defineTool } from "../runnable/tool.ts";
import { type AgUiEvent, parseAgUiStream } from "./events.ts";
import { decodeResumeDecision, toAgUiHandler } from "./handler.ts";
import { applyJsonPatch } from "./json-patch.ts";

const NODE = "http://127.0.0.1:7981";
const CORE = "http://127.0.0.1:7980";

let modelQueue: unknown[] = [];
let modelBodies: unknown[] = [];
let originalFetch: typeof globalThis.fetch;
let extraRoutes: (
	url: URL,
	init?: RequestInit
) => Promise<Response> | undefined = () => undefined;

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
	};
}

beforeEach(() => {
	originalFetch = globalThis.fetch;
	modelQueue = [];
	modelBodies = [];
	extraRoutes = () => undefined;
	globalThis.fetch = Object.assign(
		(
			input: Parameters<typeof globalThis.fetch>[0],
			init?: Parameters<typeof globalThis.fetch>[1]
		) => {
			const url = new URL(String(input));
			const extra = extraRoutes(url, init);
			if (extra) {
				return extra;
			}
			if (url.pathname === "/v1/chat/completions") {
				modelBodies.push(JSON.parse(String(init?.body ?? "{}")));
				const next = modelQueue.shift() ?? modelResponse({ content: "done" });
				return Promise.resolve(
					new Response(JSON.stringify(next), { status: 200 })
				);
			}
			return Promise.resolve(new Response("not found", { status: 404 }));
		},
		{ preconnect: originalFetch.preconnect }
	);
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function post(body: unknown): Request {
	return new Request("http://agent.local/agui", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function events(response: Response): Promise<AgUiEvent[]> {
	if (response.headers.get("content-type") !== "text/event-stream") {
		throw new Error("expected an SSE response");
	}
	return parseAgUiStream(await response.text());
}

function ids() {
	let next = 0;
	return () => {
		next += 1;
		return `gen-${next}`;
	};
}

describe("toAgUiHandler (SDK loop)", () => {
	it("streams a plain run with the transcript and context sent to the gateway", async () => {
		modelQueue = [modelResponse({ content: "Hello there" })];
		const agent = new Agent({
			name: "greeter",
			model: "gpt-4o",
			instructions: "Be brief.",
			node: { baseUrl: NODE },
		});
		const handler = toAgUiHandler(agent, { idFactory: ids() });
		const out = await events(
			await handler(
				post({
					threadId: "thread-1",
					runId: "run-1",
					messages: [
						{ id: "m1", role: "user", content: "Hi" },
						{ id: "m2", role: "assistant", content: "Hey" },
						{
							id: "m3",
							role: "user",
							content: [{ type: "text", text: "Again" }],
						},
					],
					context: [{ description: "page", value: "/settings" }],
					tools: [],
					state: {},
				})
			)
		);
		expect(out[0]).toEqual({
			type: "RUN_STARTED",
			threadId: "thread-1",
			runId: "run-1",
		});
		const text = out
			.filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
			.map((event) =>
				event.type === "TEXT_MESSAGE_CONTENT" ? event.delta : ""
			)
			.join("");
		expect(text).toBe("Hello there");
		const finished = out.at(-1);
		expect(finished?.type === "RUN_FINISHED" && finished.outcome).toBe(
			"success"
		);
		const snapshot = out.find((event) => event.type === "MESSAGES_SNAPSHOT");
		expect(
			snapshot?.type === "MESSAGES_SNAPSHOT" &&
				snapshot.messages.map((m) => m.id)
		).toEqual(["m1", "m2", "m3", "gen-1"]);
		expect(modelBodies[0]).toMatchObject({
			messages: [
				{ role: "system", content: "Be brief." },
				{ role: "user", content: "Hi" },
				{ role: "assistant", content: "Hey" },
				{
					role: "user",
					content: "Context from the application:\n- page: /settings",
				},
				{ role: "user", content: "Again" },
			],
		});
	});

	it("suspends on a needsApproval tool and resumes the same execution", async () => {
		let executed: unknown;
		const deploy = defineTool({
			id: "deploy",
			name: "Deploy",
			needsApproval: true,
			schema: { type: "object", properties: { env: { type: "string" } } },
			run: async (input) => {
				executed = input;
				return { deployed: true };
			},
		});
		modelQueue = [
			modelResponse({
				toolCalls: [
					{
						id: "call-1",
						type: "function",
						function: { name: "deploy", arguments: '{"env":"prod"}' },
					},
				],
			}),
			modelResponse({ content: "Deployed." }),
		];
		const agent = new Agent({
			name: "ops",
			model: "gpt-4o",
			node: { baseUrl: NODE },
			tools: { deploy },
		});
		const handler = toAgUiHandler(agent, { idFactory: ids() });
		const first = await events(
			await handler(
				post({
					threadId: "t-ops",
					runId: "run-a",
					messages: [{ id: "u", role: "user", content: "ship it" }],
				})
			)
		);
		const interrupt = first.find((event) => event.type === "CUSTOM");
		expect(interrupt?.type === "CUSTOM" && interrupt.name).toBe("on_interrupt");
		const finished = first.at(-1);
		expect(finished?.type).toBe("RUN_FINISHED");
		if (finished?.type !== "RUN_FINISHED") {
			throw new Error("expected RUN_FINISHED");
		}
		expect(finished.outcome).toBe("interrupt");
		expect(finished.interrupt?.reason).toBe("tool_approval");
		expect(executed).toBeUndefined();
		expect(handler.pendingInterrupts).toBe(1);

		const second = await events(
			await handler(
				post({
					threadId: "t-ops",
					runId: "run-b",
					messages: [],
					resume: {
						interruptId: finished.interrupt?.id,
						payload: { approved: true },
					},
				})
			)
		);
		expect(second[0]).toEqual({
			type: "RUN_STARTED",
			threadId: "t-ops",
			runId: "run-b",
			parentRunId: "run-a",
		});
		expect(executed).toEqual({ env: "prod" });
		const result = second.find((event) => event.type === "TOOL_CALL_RESULT");
		expect(result?.type === "TOOL_CALL_RESULT" && result.content).toBe(
			'{"deployed":true}'
		);
		const done = second.at(-1);
		expect(done?.type === "RUN_FINISHED" && done.outcome).toBe("success");
		expect(handler.pendingInterrupts).toBe(0);
	});

	it("denies via CopilotKit's forwardedProps.command.resume and reports unknown resumes", async () => {
		const gated = defineTool({
			id: "gated",
			name: "Gated",
			needsApproval: true,
			schema: { type: "object", properties: {} },
			run: async () => ({ ran: true }),
		});
		modelQueue = [
			modelResponse({
				toolCalls: [
					{
						id: "c",
						type: "function",
						function: { name: "gated", arguments: "{}" },
					},
				],
			}),
			modelResponse({ content: "Skipped." }),
		];
		const agent = new Agent({
			name: "g",
			model: "gpt-4o",
			node: { baseUrl: NODE },
			tools: { gated },
		});
		const handler = toAgUiHandler(agent);
		await events(
			await handler(
				post({ threadId: "t-g", messages: [{ role: "user", content: "go" }] })
			)
		);
		const resumed = await events(
			await handler(
				post({
					threadId: "t-g",
					forwardedProps: { command: { resume: "deny" } },
				})
			)
		);
		const result = resumed.find((event) => event.type === "TOOL_CALL_RESULT");
		expect(result?.type === "TOOL_CALL_RESULT" && result.content).toBe(
			'{"error":"tool execution was not approved"}'
		);
		const missing = await events(
			await handler(
				post({ threadId: "nope", resume: { interruptId: "x", payload: true } })
			)
		);
		expect(missing.at(-1)).toEqual({
			type: "RUN_ERROR",
			message: "no suspended run matches this resume request",
			code: "interrupt_not_found",
		});
	});

	it("denies a suspended run after the interrupt timeout", async () => {
		const gated = defineTool({
			id: "gated",
			name: "Gated",
			needsApproval: true,
			schema: { type: "object", properties: {} },
			run: async () => ({ ran: true }),
		});
		modelQueue = [
			modelResponse({
				toolCalls: [
					{
						id: "c",
						type: "function",
						function: { name: "gated", arguments: "{}" },
					},
				],
			}),
		];
		const handler = toAgUiHandler(
			new Agent({
				name: "g",
				model: "gpt-4o",
				node: { baseUrl: NODE },
				tools: { gated },
			}),
			{ interruptTimeoutMs: 100 }
		);
		await events(
			await handler(post({ messages: [{ role: "user", content: "go" }] }))
		);
		expect(handler.pendingInterrupts).toBe(1);
		const deadline = Date.now() + 2000;
		while (handler.pendingInterrupts > 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(handler.pendingInterrupts).toBe(0);
	});

	it("emits STATE_SNAPSHOT and JSON Patch deltas from the state reducer", async () => {
		modelQueue = [modelResponse({ content: "ok" })];
		const handler = toAgUiHandler(
			new Agent({ name: "s", model: "gpt-4o", node: { baseUrl: NODE } }),
			{
				reduceState: (state, event) =>
					event.type === "text" &&
					typeof state === "object" &&
					state !== null &&
					!Array.isArray(state)
						? { ...state, chars: event.content.length }
						: state,
			}
		);
		const out = await events(
			await handler(
				post({
					messages: [{ role: "user", content: "hi" }],
					state: { mode: "x" },
				})
			)
		);
		const snapshot = out.find((event) => event.type === "STATE_SNAPSHOT");
		const delta = out.find((event) => event.type === "STATE_DELTA");
		expect(snapshot?.type === "STATE_SNAPSHOT" && snapshot.snapshot).toEqual({
			mode: "x",
		});
		if (delta?.type !== "STATE_DELTA" || snapshot?.type !== "STATE_SNAPSHOT") {
			throw new Error("expected state events");
		}
		expect(applyJsonPatch(snapshot.snapshot, delta.delta)).toEqual({
			mode: "x",
			chars: 2,
		});
	});

	it("rejects non-POST and malformed bodies", async () => {
		const handler = toAgUiHandler(
			new Agent({ name: "x", model: "m", node: { baseUrl: NODE } })
		);
		expect(
			(await handler(new Request("http://a/", { method: "GET" }))).status
		).toBe(405);
		const bad = await handler(
			new Request("http://a/", { method: "POST", body: "{not json" })
		);
		expect(bad.status).toBe(400);
		const invalid = await handler(post({ messages: [{ role: "user" }] }));
		expect(invalid.status).toBe(400);
		const empty = await events(await handler(post({ messages: [] })));
		expect(empty.at(-1)).toMatchObject({
			type: "RUN_ERROR",
			code: "no_user_message",
		});
	});
});

describe("toAgUiHandler (Core harness session)", () => {
	it("suspends on a harness permission request and resolves it on resume", async () => {
		let releaseStream: () => void = () => undefined;
		const released = new Promise<void>((resolve) => {
			releaseStream = resolve;
		});
		const permissionBodies: unknown[] = [];
		const base = {
			createdAt: "2026-10-21T00:00:00Z",
			protocolVersion: "1",
			runId: "run-h",
			sessionId: "sess-1",
		};
		const frame = (seq: number, event: Record<string, unknown>) =>
			`data: ${JSON.stringify({ ...base, id: `e${seq}`, seq, ...event })}\n\n`;
		const encoder = new TextEncoder();
		extraRoutes = (url, init) => {
			if (url.pathname === "/api/harness/sessions/sess-1/runs") {
				return Promise.resolve(
					Response.json({
						created: true,
						eventsUrl: "/api/harness/runs/run-h/events",
						protocolVersion: "1",
						run: {
							attempt: 1,
							createdAt: base.createdAt,
							eventCursor: 0,
							executionProfile: {
								approval: "inherit",
								kind: "local",
								network: "inherit",
								sandbox: "inherit",
								worktreeIsolation: false,
							},
							id: "run-h",
							protocolVersion: "1",
							sessionId: "sess-1",
							status: "running",
						},
					})
				);
			}
			if (url.pathname === "/api/harness/runs/run-h/events") {
				const body = new ReadableStream<Uint8Array>({
					async start(controller) {
						controller.enqueue(
							encoder.encode(
								frame(1, { type: "text_delta", delta: "Checking" }) +
									frame(2, {
										type: "approval_requested",
										approvalId: "perm-7",
										summary: "Write notes.md?",
										options: [
											{ optionId: "allow", name: "Allow", kind: "allow_once" },
											{
												optionId: "reject",
												name: "Reject",
												kind: "reject_once",
											},
										],
									})
							)
						);
						await released;
						controller.enqueue(
							encoder.encode(
								frame(3, { type: "text_delta", delta: " done" }) +
									frame(4, { type: "run_completed" })
							)
						);
						controller.close();
					},
				});
				return Promise.resolve(
					new Response(body, {
						headers: { "Content-Type": "text/event-stream" },
					})
				);
			}
			if (url.pathname === "/api/chat/permission") {
				permissionBodies.push(JSON.parse(String(init?.body ?? "{}")));
				releaseStream();
				return Promise.resolve(Response.json({ resolved: true }));
			}
			return undefined;
		};
		const agent = new Agent({
			name: "durable",
			model: "gpt-4o",
			sessionId: "sess-1",
			core: { baseUrl: CORE },
		});
		const handler = toAgUiHandler(agent);
		const first = await events(
			await handler(
				post({
					threadId: "sess-1",
					messages: [{ role: "user", content: "take notes" }],
				})
			)
		);
		const finished = first.at(-1);
		if (finished?.type !== "RUN_FINISHED") {
			throw new Error("expected RUN_FINISHED");
		}
		expect(finished.interrupt?.id).toBe("perm-7");
		const second = await events(
			await handler(
				post({ resume: { interruptId: "perm-7", payload: "allow" } })
			)
		);
		expect(permissionBodies).toEqual([
			{ request_id: "perm-7", option_id: "allow" },
		]);
		const text = second
			.map((event) =>
				event.type === "TEXT_MESSAGE_CONTENT" ? event.delta : ""
			)
			.join("");
		expect(text).toBe(" done");
		const done = second.at(-1);
		expect(done?.type === "RUN_FINISHED" && done.outcome).toBe("success");
	});
});

describe("decodeResumeDecision", () => {
	it("reads booleans, verbs, option ids, and objects", () => {
		expect(decodeResumeDecision(true)).toBe(true);
		expect(decodeResumeDecision("approve")).toBe(true);
		expect(decodeResumeDecision("Reject")).toBe(false);
		const offered = [
			{ optionId: "allow_once_1", name: "Allow", kind: "allow_once" },
			{ optionId: "opt", name: "Other", kind: "reject_once" },
		];
		expect(decodeResumeDecision("allow_once_1", offered)).toBe("allow_once_1");
		expect(decodeResumeDecision({ approved: true })).toBe(true);
		expect(decodeResumeDecision({ optionId: "opt" }, offered)).toBe("opt");
		expect(decodeResumeDecision(null)).toBe(false);
		expect(decodeResumeDecision(undefined)).toBe(false);
	});

	it("denies strings and option ids the request did not offer", () => {
		expect(decodeResumeDecision("cancel")).toBe(false);
		expect(decodeResumeDecision("allow_once_1")).toBe(false);
		expect(decodeResumeDecision({ optionId: "opt" })).toBe(false);
		expect(
			decodeResumeDecision("nope", [
				{ optionId: "allow", name: "Allow", kind: "allow_once" },
			])
		).toBe(false);
	});
});

function gatedTool(onRun: () => void) {
	return defineTool({
		id: "gated",
		name: "Gated",
		needsApproval: true,
		schema: { type: "object", properties: {} },
		run: async () => {
			onRun();
			return { ran: true };
		},
	});
}

function gatedCall() {
	return modelResponse({
		toolCalls: [
			{
				id: "c",
				type: "function",
				function: { name: "gated", arguments: "{}" },
			},
		],
	});
}

describe("toAgUiHandler (hardening)", () => {
	it("treats an unrecognized resume payload as a denial", async () => {
		let ran = false;
		modelQueue = [gatedCall(), modelResponse({ content: "ok" })];
		const handler = toAgUiHandler(
			new Agent({
				name: "g",
				model: "gpt-4o",
				node: { baseUrl: NODE },
				tools: {
					gated: gatedTool(() => {
						ran = true;
					}),
				},
			})
		);
		await events(
			await handler(
				post({ threadId: "t-u", messages: [{ role: "user", content: "go" }] })
			)
		);
		const resumed = await events(
			await handler(post({ threadId: "t-u", resume: { payload: "cancel" } }))
		);
		expect(ran).toBe(false);
		const result = resumed.find((event) => event.type === "TOOL_CALL_RESULT");
		expect(result?.type === "TOOL_CALL_RESULT" && result.content).toBe(
			'{"error":"tool execution was not approved"}'
		);
	});

	it("only resumes an interrupt on the thread that raised it", async () => {
		modelQueue = [gatedCall(), modelResponse({ content: "ok" })];
		const handler = toAgUiHandler(
			new Agent({
				name: "g",
				model: "gpt-4o",
				node: { baseUrl: NODE },
				tools: { gated: gatedTool(() => undefined) },
			})
		);
		const first = await events(
			await handler(
				post({ threadId: "t-own", messages: [{ role: "user", content: "go" }] })
			)
		);
		const finished = first.at(-1);
		if (finished?.type !== "RUN_FINISHED" || !finished.interrupt) {
			throw new Error("expected an interrupt");
		}
		const foreign = await events(
			await handler(
				post({
					threadId: "t-other",
					resume: { interruptId: finished.interrupt.id, payload: true },
				})
			)
		);
		expect(foreign.at(-1)).toMatchObject({
			type: "RUN_ERROR",
			code: "interrupt_not_found",
		});
		expect(handler.pendingInterrupts).toBe(1);
		const own = await events(
			await handler(
				post({
					threadId: "t-own",
					resume: { interruptId: finished.interrupt.id, payload: true },
				})
			)
		);
		expect(own.at(-1)).toMatchObject({
			type: "RUN_FINISHED",
			outcome: "success",
		});
	});

	it("denies approvals and finishes the run when the client disconnects", async () => {
		let ran = false;
		let releaseModel: () => void = () => undefined;
		const modelGate = new Promise<void>((resolve) => {
			releaseModel = resolve;
		});
		let modelCalls = 0;
		extraRoutes = (url) => {
			if (url.pathname !== "/v1/chat/completions") {
				return undefined;
			}
			modelCalls += 1;
			const body =
				modelCalls === 1 ? gatedCall() : modelResponse({ content: "ok" });
			return modelGate.then(
				() => new Response(JSON.stringify(body), { status: 200 })
			);
		};
		const handler = toAgUiHandler(
			new Agent({
				name: "g",
				model: "gpt-4o",
				node: { baseUrl: NODE },
				tools: {
					gated: gatedTool(() => {
						ran = true;
					}),
				},
			})
		);
		const response = await handler(
			post({ threadId: "t-dc", messages: [{ role: "user", content: "go" }] })
		);
		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error("expected a body");
		}
		await reader.read();
		await reader.cancel();
		releaseModel();
		for (let tick = 0; tick < 20; tick++) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(ran).toBe(false);
		expect(handler.pendingInterrupts).toBe(0);
	});

	it("ends the run with RUN_ERROR when the state reducer throws", async () => {
		modelQueue = [modelResponse({ content: "ok" })];
		const handler = toAgUiHandler(
			new Agent({ name: "s", model: "gpt-4o", node: { baseUrl: NODE } }),
			{
				reduceState: () => {
					throw new Error("reducer broke");
				},
			}
		);
		const out = await events(
			await handler(post({ messages: [{ role: "user", content: "hi" }] }))
		);
		expect(out.at(-1)).toEqual({
			type: "RUN_ERROR",
			message: "reducer broke",
			code: "handler_failed",
		});
	});

	it("follows handoff() tools to the target agent", async () => {
		const billing = new Agent({
			name: "billing",
			model: "m-billing",
			node: { baseUrl: NODE },
		});
		const triage = new Agent({
			name: "triage",
			model: "m-triage",
			node: { baseUrl: NODE },
			tools: { transfer_to_billing: handoff(billing) },
		});
		modelQueue = [
			modelResponse({
				toolCalls: [
					{
						id: "h1",
						type: "function",
						function: { name: "transfer_to_billing", arguments: "{}" },
					},
				],
			}),
			modelResponse({ content: "Refund issued." }),
		];
		const out = await events(
			await toAgUiHandler(triage)(
				post({ messages: [{ role: "user", content: "charged twice" }] })
			)
		);
		expect(
			modelBodies.map((body) =>
				typeof body === "object" && body !== null && "model" in body
					? body.model
					: undefined
			)
		).toEqual(["m-triage", "m-billing"]);
		expect(out.at(-1)).toMatchObject({
			type: "RUN_FINISHED",
			outcome: "success",
			result: { text: "Refund issued." },
		});
	});

	it("parks a handoff target's approval so the interrupt can be resumed", async () => {
		let executed: unknown;
		const refund = defineTool({
			id: "refund",
			name: "Refund",
			needsApproval: true,
			schema: { type: "object", properties: { amount: { type: "number" } } },
			run: async (input) => {
				executed = input;
				return { refunded: true };
			},
		});
		const billing = new Agent({
			name: "billing",
			model: "m-billing",
			node: { baseUrl: NODE },
			tools: { refund },
		});
		const triage = new Agent({
			name: "triage",
			model: "m-triage",
			node: { baseUrl: NODE },
			tools: { transfer_to_billing: handoff(billing) },
		});
		modelQueue = [
			modelResponse({
				toolCalls: [
					{
						id: "h1",
						type: "function",
						function: { name: "transfer_to_billing", arguments: "{}" },
					},
				],
			}),
			modelResponse({
				toolCalls: [
					{
						id: "r1",
						type: "function",
						function: { name: "refund", arguments: '{"amount":5}' },
					},
				],
			}),
			modelResponse({ content: "Refund issued." }),
		];
		const handler = toAgUiHandler(triage, { idFactory: ids() });
		const first = await events(
			await handler(
				post({
					threadId: "t-h",
					runId: "run-a",
					messages: [{ id: "u", role: "user", content: "charged twice" }],
				})
			)
		);
		const finished = first.at(-1);
		if (finished?.type !== "RUN_FINISHED" || !finished.interrupt) {
			throw new Error("expected an interrupt");
		}
		expect(finished.interrupt.reason).toBe("tool_approval");
		expect(executed).toBeUndefined();
		expect(handler.pendingInterrupts).toBe(1);

		const second = await events(
			await handler(
				post({
					threadId: "t-h",
					runId: "run-b",
					messages: [],
					resume: {
						interruptId: finished.interrupt.id,
						payload: { approved: true },
					},
				})
			)
		);
		expect(executed).toEqual({ amount: 5 });
		expect(second.at(-1)).toMatchObject({
			type: "RUN_FINISHED",
			outcome: "success",
		});
	});

	it("starts a fresh run when an account-connection interrupt is resumed", async () => {
		let connected = false;
		const crm = defineTool({
			id: "crm",
			name: "CRM",
			schema: { type: "object", properties: {} },
			run: async () =>
				connected
					? { rows: 3 }
					: {
							__ryu_elicitation__: {
								kind: "oauth",
								url: "https://connect.example/crm",
							},
						},
		});
		const crmCall = modelResponse({
			toolCalls: [
				{
					id: "k",
					type: "function",
					function: { name: "crm", arguments: "{}" },
				},
			],
		});
		modelQueue = [crmCall, crmCall, modelResponse({ content: "3 rows" })];
		const handler = toAgUiHandler(
			new Agent({
				name: "c",
				model: "gpt-4o",
				node: { baseUrl: NODE },
				tools: { crm },
			})
		);
		const messages = [{ id: "u1", role: "user", content: "count rows" }];
		const first = await events(
			await handler(post({ threadId: "t-auth", runId: "r1", messages }))
		);
		const finished = first.at(-1);
		if (finished?.type !== "RUN_FINISHED" || !finished.interrupt) {
			throw new Error("expected an interrupt");
		}
		expect(finished.interrupt.reason).toBe("auth_required");
		connected = true;
		const second = await events(
			await handler(
				post({
					threadId: "t-auth",
					runId: "r2",
					messages,
					resume: { interruptId: finished.interrupt.id, payload: true },
				})
			)
		);
		expect(second[0]).toEqual({
			type: "RUN_STARTED",
			threadId: "t-auth",
			runId: "r2",
			parentRunId: "r1",
		});
		expect(second.at(-1)).toMatchObject({
			type: "RUN_FINISHED",
			outcome: "success",
			result: { text: "3 rows" },
		});
	});

	it("puts the client context ahead of a sessionId agent's prompt", async () => {
		const runBodies: unknown[] = [];
		extraRoutes = (url, init) => {
			if (url.pathname === "/api/harness/sessions/sess-c/runs") {
				runBodies.push(JSON.parse(String(init?.body ?? "{}")));
				return Promise.resolve(new Response("boom", { status: 500 }));
			}
			return undefined;
		};
		const handler = toAgUiHandler(
			new Agent({
				name: "d",
				model: "gpt-4o",
				sessionId: "sess-c",
				core: { baseUrl: CORE },
			})
		);
		await events(
			await handler(
				post({
					messages: [{ role: "user", content: "summarize" }],
					context: [{ description: "page", value: "/billing" }],
				})
			)
		);
		expect(JSON.stringify(runBodies)).toContain(
			"Context from the application:\\n- page: /billing\\n\\nsummarize"
		);
	});
});
