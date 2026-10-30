/**
 * Working memory + compaction in the SDK-owned agent loop. `fetch` is stubbed
 * and routed by URL: gateway completions and Core's `/api/memory/working`,
 * which is emulated in memory (template replace, schema merge patch).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import type { RunnableContext } from "../runnable/runnable-types.ts";
import { defineTool } from "../runnable/tool.ts";
import { Agent } from "./agent.ts";
import {
	compactionMiddleware,
	estimateMessagesTokens,
	planCompaction,
} from "./compaction.ts";
import type { LoopMessage, ToolCall } from "./model-call.ts";
import { modelBodyFixtureSchema } from "./transport-fixtures.ts";
import {
	createWorkingMemoryHandle,
	renderWorkingMemoryBlock,
	resolveWorkingMemory,
	WORKING_MEMORY_TOOL_NAME,
} from "./working-memory.ts";

const NODE = "http://127.0.0.1:7981";
const CORE = "http://127.0.0.1:7982";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface StoredDoc {
	content?: string;
	data?: Record<string, Json>;
	mode: "template" | "schema";
	schema?: Record<string, Json>;
	template?: string;
	version: number;
}

const putBodySchema = z.object({
	mode: z.enum(["template", "schema"]),
	content: z.string().optional(),
	data: z.record(z.string(), z.json()).optional(),
	template: z.string().optional(),
	schema: z.record(z.string(), z.json()).optional(),
	replace: z.boolean().optional(),
});

let store = new Map<string, StoredDoc>();
let modelQueue: unknown[] = [];
let modelBodies: z.output<typeof modelBodyFixtureSchema>[] = [];
let workingRequests: string[] = [];
let originalFetch: typeof globalThis.fetch;

function mergePatch(target: Json, patch: Json): Json {
	if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
		return patch;
	}
	const base =
		target !== null && typeof target === "object" && !Array.isArray(target)
			? { ...target }
			: {};
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) {
			delete base[key];
		} else {
			base[key] = mergePatch(base[key] ?? null, value);
		}
	}
	return base;
}

function wire(scope: string, id: string, doc: StoredDoc | undefined) {
	return {
		scope,
		id,
		working_memory: doc
			? {
					scope,
					id,
					mode: doc.mode,
					content: doc.content,
					data: doc.data,
					template: doc.template,
					schema: doc.schema,
					version: doc.version,
					created_at: 1,
					updated_at: doc.version,
				}
			: null,
	};
}

function modelResponse(content: string | null, toolCalls: ToolCall[] = []) {
	return {
		choices: [
			{
				finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
				message: {
					content,
					tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
				},
			},
		],
	};
}

function call(id: string, args: Json): ToolCall {
	return {
		id,
		type: "function",
		function: {
			name: WORKING_MEMORY_TOOL_NAME,
			arguments: JSON.stringify(args),
		},
	};
}

beforeEach(() => {
	originalFetch = globalThis.fetch;
	store = new Map();
	modelQueue = [];
	modelBodies = [];
	workingRequests = [];
	globalThis.fetch = Object.assign(
		(
			input: Parameters<typeof globalThis.fetch>[0],
			init?: Parameters<typeof globalThis.fetch>[1]
		) => {
			const url = new URL(String(input));
			if (url.pathname === "/v1/chat/completions") {
				modelBodies.push(
					modelBodyFixtureSchema.parse(JSON.parse(String(init?.body)))
				);
				const next = modelQueue.shift() ?? modelResponse("done");
				return Promise.resolve(Response.json(next));
			}
			if (url.pathname === "/api/memory/working") {
				const scope = url.searchParams.get("scope") ?? "";
				const id = url.searchParams.get("id") ?? "";
				const key = `${scope}:${id}`;
				workingRequests.push(`${init?.method} ${scope}:${id}`);
				if (init?.method === "PUT") {
					const body = putBodySchema.parse(JSON.parse(String(init.body)));
					const prior = store.get(key);
					const next: StoredDoc =
						body.mode === "template"
							? {
									mode: "template",
									content: body.content ?? prior?.content,
									template: body.template,
									version: (prior?.version ?? 0) + 1,
								}
							: {
									mode: "schema",
									data: z
										.record(z.string(), z.json())
										.parse(
											body.replace
												? (body.data ?? {})
												: mergePatch(prior?.data ?? {}, body.data ?? {})
										),
									schema: body.schema,
									version: (prior?.version ?? 0) + 1,
								};
					store.set(key, next);
					return Promise.resolve(Response.json(wire(scope, id, next)));
				}
				return Promise.resolve(Response.json(wire(scope, id, store.get(key))));
			}
			return Promise.resolve(new Response("not found", { status: 404 }));
		},
		{ preconnect: () => undefined }
	);
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("working memory", () => {
	test("injects the scratchpad each call and persists template updates", async () => {
		modelQueue = [
			modelResponse(null, [call("c1", { content: "# Profile\n- name: Ada" })]),
			modelResponse("Nice to meet you, Ada."),
		];
		const agent = new Agent({
			name: "wm",
			model: "test-model",
			instructions: "Be helpful.",
			node: { baseUrl: NODE },
			core: { baseUrl: CORE, token: "tok" },
			workingMemory: {
				scope: "resource",
				id: "user-1",
				template: "# Profile\n- name:",
			},
		});
		const result = await agent.generate("I'm Ada");
		expect(result.text).toBe("Nice to meet you, Ada.");
		expect(store.get("resource:user-1")?.content).toBe(
			"# Profile\n- name: Ada"
		);
		expect(store.get("resource:user-1")?.template).toBe("# Profile\n- name:");

		// First call: instructions, then the empty-template working memory block.
		const first = modelBodies[0];
		expect(first?.messages[0]).toEqual({
			role: "system",
			content: "Be helpful.",
		});
		expect(first?.messages[1]?.role).toBe("system");
		expect(first?.messages[1]?.content).toContain(
			"(empty — fill in this template)"
		);
		expect(
			first?.tools?.some(
				(tool) => tool.function.name === WORKING_MEMORY_TOOL_NAME
			)
		).toBe(true);
		// Second call sees the updated document.
		expect(modelBodies[1]?.messages[1]?.content).toContain("- name: Ada");
		expect(workingRequests).toEqual([
			"GET resource:user-1",
			"PUT resource:user-1",
			"GET resource:user-1",
		]);
	});

	test("schema mode merges patches and validates the configured schema", async () => {
		modelQueue = [
			modelResponse(null, [call("c1", { data: { name: "Ada" } })]),
			modelResponse(null, [call("c2", { data: { city: "London" } })]),
			modelResponse("ok"),
		];
		const agent = new Agent({
			name: "wm-schema",
			model: "test-model",
			node: { baseUrl: NODE },
			core: { baseUrl: CORE },
			workingMemory: {
				id: "thread-9",
				schema: z.object({ name: z.string(), city: z.string() }).partial(),
			},
		});
		await agent.generate("hi");
		const doc = store.get("thread:thread-9");
		expect(doc?.mode).toBe("schema");
		expect(doc?.data).toEqual({ name: "Ada", city: "London" });
		expect(doc?.schema?.type).toBe("object");
		expect(modelBodies[2]?.messages[0]?.content).toContain('"city": "London"');
	});

	test("mounts ctx.memory.working for local tools", async () => {
		let seen: string | undefined;
		const probe = defineTool({
			id: "probe",
			name: "Probe",
			schema: { type: "object", properties: {} },
			async run(_input, ctx: RunnableContext) {
				await ctx.memory?.working?.update({ content: "from a tool" });
				const doc = await ctx.memory?.working?.get();
				seen = doc?.content;
				return { ok: true };
			},
		});
		modelQueue = [
			modelResponse(null, [
				{
					id: "p1",
					type: "function",
					function: { name: "probe", arguments: "{}" },
				},
			]),
			modelResponse("done"),
		];
		const agent = new Agent({
			name: "wm-ctx",
			model: "test-model",
			node: { baseUrl: NODE },
			core: { baseUrl: CORE },
			tools: { probe },
			workingMemory: { id: "t-ctx" },
		});
		await agent.generate("go");
		expect(seen).toBe("from a tool");
	});

	test("rejects an empty id and a non-object schema", () => {
		expect(() => resolveWorkingMemory({ id: "  " })).toThrow("id");
		expect(() =>
			resolveWorkingMemory({ id: "x", schema: { type: "string" } })
		).toThrow("object");
	});

	test("sessionId runs refuse SDK-side working memory", async () => {
		const agent = new Agent({
			name: "wm-session",
			model: "test-model",
			sessionId: "sess",
			core: { baseUrl: CORE },
			workingMemory: { id: "t" },
		});
		await expect(agent.generate("hi")).rejects.toThrow("SDK-owned loop");
	});

	test("the handle surfaces Core errors", async () => {
		const handle = createWorkingMemoryHandle(
			resolveWorkingMemory({ id: "t" }),
			{
				coreBaseUrl: CORE,
				fetchImpl: Object.assign(
					() =>
						Promise.resolve(
							Response.json({ error: "schema" }, { status: 400 })
						),
					{ preconnect: () => undefined }
				),
			}
		);
		await expect(handle.update({ content: "x" })).rejects.toThrow("400");
	});

	test("renders schema-mode state", () => {
		const resolved = resolveWorkingMemory({
			id: "u",
			scope: "resource",
			schema: { type: "object", properties: { name: { type: "string" } } },
		});
		const block = renderWorkingMemoryBlock(resolved, null);
		expect(block).toContain("across conversations");
		expect(block).toContain("merge patch");
		expect(block.startsWith("<working_memory>")).toBe(true);
	});
});

describe("compaction", () => {
	const long = "x".repeat(700);
	const transcript: LoopMessage[] = [
		{ role: "system", content: "sys" },
		{ role: "user", content: long },
		{ role: "assistant", content: long },
		{ role: "user", content: long },
		{
			role: "assistant",
			content: null,
			tool_calls: [
				{
					id: "t1",
					type: "function",
					function: { name: "lookup", arguments: "{}" },
				},
			],
		},
		{ role: "tool", content: "result", tool_call_id: "t1" },
		{ role: "assistant", content: "answer" },
		{ role: "user", content: "next question" },
	];

	test("plans a cut that starts at a user turn", () => {
		const plan = planCompaction(transcript, 3);
		expect(plan?.head).toEqual([{ role: "system", content: "sys" }]);
		expect(plan?.kept[0]?.role).toBe("user");
		expect(plan?.kept.at(-1)).toEqual({
			role: "user",
			content: "next question",
		});
		expect(planCompaction(transcript.slice(0, 2), 3)).toBeUndefined();
	});

	test("summarizes once past the threshold and memoizes", async () => {
		let summaries = 0;
		const middleware = compactionMiddleware(
			{
				threshold: 100,
				keepRecent: 2,
				summarize: () => {
					summaries += 1;
					return Promise.resolve("- the user asked twice");
				},
			},
			{ baseUrl: NODE, model: "m" }
		);
		const sent: LoopMessage[][] = [];
		const next = (request: { messages: LoopMessage[] }) => {
			sent.push(request.messages);
			return Promise.resolve({
				finishReason: "stop",
				message: { role: "assistant" as const, content: "ok" },
			});
		};
		const request = { messages: transcript, model: "m", step: 1 };
		await middleware.wrapModelCall?.(request, next);
		await middleware.wrapModelCall?.(request, next);
		expect(summaries).toBe(1);
		expect(sent[0]?.[1]?.content).toContain("- the user asked twice");
		expect(estimateMessagesTokens(sent[0] ?? [])).toBeLessThan(
			estimateMessagesTokens(transcript)
		);
		// Under the threshold, nothing changes.
		const small = { messages: transcript.slice(-1), model: "m", step: 1 };
		await middleware.wrapModelCall?.(small, next);
		expect(sent[2]).toEqual(transcript.slice(-1));
	});

	test("fails open when the summarizer throws", async () => {
		const middleware = compactionMiddleware(
			{
				threshold: 10,
				summarize: () => Promise.reject(new Error("down")),
			},
			{ baseUrl: NODE, model: "m" }
		);
		let sent: LoopMessage[] = [];
		await middleware.wrapModelCall?.(
			{ messages: transcript, model: "m", step: 1 },
			(request) => {
				sent = request.messages;
				return Promise.resolve({
					finishReason: "stop",
					message: { role: "assistant", content: "ok" },
				});
			}
		);
		expect(sent).toEqual(transcript);
	});

	test("rejects a non-positive threshold", () => {
		expect(() =>
			compactionMiddleware({ threshold: 0 }, { baseUrl: NODE, model: "m" })
		).toThrow("threshold");
	});

	test("an Agent with compaction sends the compacted transcript", async () => {
		modelQueue = [modelResponse("summary text"), modelResponse("final")];
		const agent = new Agent({
			name: "compact",
			model: "test-model",
			node: { baseUrl: NODE },
			compaction: { threshold: 50, keepRecent: 1, model: "small-model" },
		});
		const result = agent.streamMessages([
			{ role: "user", content: long },
			{ role: "assistant", content: long },
			{ role: "user", content: "and now?" },
		]);
		const events = [];
		for await (const event of result) {
			events.push(event);
		}
		// Summarizer call first (on the configured model), then the real call.
		expect(modelBodies[0]?.model).toBe("small-model");
		expect(modelBodies[1]?.messages).toEqual([
			{
				role: "system",
				content: "[Summary of the earlier conversation]\nsummary text",
			},
			{ role: "user", content: "and now?" },
		]);
	});
});
