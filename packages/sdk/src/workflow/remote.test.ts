/**
 * The Core workflow client against a mocked transport. These tests pin the
 * wire contract (paths, bodies, headers, run-record decoding, polling); live
 * round-trips against a running Core are not exercised here.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
	type CoreFetch,
	type CoreRunRecord,
	createCoreWorkflowClient,
	createStep,
	createWorkflow,
	decodeCoreValue,
	humanStep,
	type StreamChunk,
	type WorkflowEvent,
} from "./index.ts";

interface Call {
	body: unknown;
	headers: Record<string, string>;
	method: string;
	path: string;
}

type Handler = (call: Call) => {
	body: unknown;
	delayMs?: number;
	status?: number;
};

function mockCore(handler: Handler): { calls: Call[]; fetchImpl: CoreFetch } {
	const calls: Call[] = [];
	const fetchImpl: CoreFetch = async (url, init) => {
		const call: Call = {
			method: init.method ?? "GET",
			path: new URL(url).pathname,
			body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
			headers: (init.headers ?? {}) as Record<string, string>,
		};
		calls.push(call);
		const reply = handler(call);
		if (reply.delayMs) {
			await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
		}
		return new Response(JSON.stringify(reply.body), {
			status: reply.status ?? 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { calls, fetchImpl };
}

function run(
	partial: Partial<CoreRunRecord> & Pick<CoreRunRecord, "status">
): CoreRunRecord {
	return { run_id: "r1", workflow_id: "pipeline", ...partial };
}

async function collect(
	stream: AsyncIterable<StreamChunk>
): Promise<StreamChunk[]> {
	const chunks: StreamChunk[] = [];
	for await (const chunk of stream) {
		chunks.push(chunk);
	}
	return chunks;
}

const fetchStep = createStep({ id: "fetch", execute: () => "page" });
const summarize = createStep({
	id: "summarize",
	execute: () => ({ words: 2 }),
});
const inner = createWorkflow({ id: "inner" }).then(fetchStep).commit();
const pipeline = createWorkflow({
	id: "pipeline",
	inputSchema: z.object({ url: z.string() }),
	outputSchema: z.object({ words: z.number() }),
})
	.then(inner)
	.then(summarize)
	.commit();

describe("createCoreWorkflowClient", () => {
	test("deploys children before the primary definition with auth headers", async () => {
		const core = mockCore(() => ({ body: { success: true, workflow: {} } }));
		const client = createCoreWorkflowClient({
			nodeUrl: "http://127.0.0.1:7980/",
			token: "node-token",
			fetchImpl: core.fetchImpl,
		});
		const deployed = await client.deploy(pipeline);
		expect(deployed).toEqual({ workflowId: "pipeline", children: ["inner"] });
		expect(core.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
			"POST /workflows",
			"POST /workflows",
		]);
		expect(core.calls[0]?.body).toMatchObject({ id: "inner" });
		expect(core.calls[1]?.body).toEqual(pipeline.toCore().workflow);
		expect(core.calls[0]?.headers.authorization).toBe("Bearer node-token");
	});

	test("takes the node URL as baseUrl (nodeUrl is the deprecated alias)", async () => {
		const urls: string[] = [];
		const client = createCoreWorkflowClient({
			baseUrl: "http://10.0.0.1:7980/",
			token: "node-token",
			fetchImpl: (url) => {
				urls.push(url);
				return Promise.resolve(Response.json({ success: true, workflow: {} }));
			},
		});
		await client.deploy(pipeline);
		expect(urls[0]).toStartWith("http://10.0.0.1:7980/");
		expect(urls[0]).not.toContain("7980//");
		expect(() =>
			createCoreWorkflowClient({
				baseUrl: "http://127.0.0.1:7980",
				nodeUrl: "http://10.0.0.2:7980",
			})
		).toThrow(/baseUrl or nodeUrl/);
		expect(() =>
			createCoreWorkflowClient({ baseUrl: "https://api.openai.com/v1" })
		).toThrow();
	});

	test("surfaces Core's validation error on a failed deploy", async () => {
		const core = mockCore(() => ({
			status: 400,
			body: {
				success: false,
				error: "workflow contains a cycle; a DAG must be acyclic",
			},
		}));
		const client = createCoreWorkflowClient({
			nodeUrl: "http://127.0.0.1:7980",
			fetchImpl: core.fetchImpl,
		});
		await expect(client.deploy(pipeline)).rejects.toThrow(/contains a cycle/);
	});

	test("defaults the node URL and token to RYU_CORE_URL and RYU_CORE_TOKEN / RYU_TOKEN", async () => {
		const saved = {
			url: process.env.RYU_CORE_URL,
			core: process.env.RYU_CORE_TOKEN,
			legacy: process.env.RYU_TOKEN,
		};
		const restore = (name: string, value: string | undefined) => {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		};
		try {
			process.env.RYU_CORE_URL = "http://core.internal:7980/";
			process.env.RYU_CORE_TOKEN = "core-token";
			process.env.RYU_TOKEN = "legacy-token";
			const urls: string[] = [];
			const core = mockCore(() => ({ body: { success: true, workflow: {} } }));
			const fetchImpl: CoreFetch = (url, init) => {
				urls.push(url);
				return core.fetchImpl(url, init);
			};
			await createCoreWorkflowClient({ fetchImpl }).deploy(pipeline);
			expect(urls[0]).toBe("http://core.internal:7980/workflows");
			expect(core.calls[0]?.headers.authorization).toBe("Bearer core-token");

			delete process.env.RYU_CORE_TOKEN;
			await createCoreWorkflowClient({ fetchImpl }).deploy(pipeline);
			expect(core.calls.at(-1)?.headers.authorization).toBe(
				"Bearer legacy-token"
			);

			// An explicit token wins over the environment.
			await createCoreWorkflowClient({ fetchImpl, token: "mine" }).deploy(
				pipeline
			);
			expect(core.calls.at(-1)?.headers.authorization).toBe("Bearer mine");
		} finally {
			restore("RYU_CORE_URL", saved.url);
			restore("RYU_CORE_TOKEN", saved.core);
			restore("RYU_TOKEN", saved.legacy);
		}
	});

	test("rejects direct model-provider URLs", () => {
		expect(() =>
			createCoreWorkflowClient({ nodeUrl: "https://api.openai.com/v1" })
		).toThrow();
	});

	test("streams a run by polling node state while the run call is in flight", async () => {
		let polls = 0;
		const progress: CoreRunRecord[] = [
			run({
				status: "running",
				nodes: { input: { status: "completed", output: "{}" } },
			}),
			run({
				status: "running",
				nodes: {
					input: { status: "completed", output: "{}" },
					inner: { status: "running" },
				},
			}),
			run({
				status: "running",
				nodes: {
					input: { status: "completed", output: "{}" },
					inner: { status: "completed", output: "page" },
					summarize: { status: "running" },
				},
			}),
		];
		const final = run({
			status: "completed",
			nodes: {
				input: { status: "completed", output: "{}" },
				inner: { status: "completed", output: "page" },
				summarize: { status: "completed", output: '{"words":2}' },
				output: { status: "completed", output: '{"words":2}' },
			},
			output: { output: '{"words":2}' },
		});
		const core = mockCore((call) => {
			if (call.method === "POST") {
				return { body: { success: true, run: final }, delayMs: 60 };
			}
			if (polls === 0) {
				polls += 1;
				return {
					status: 404,
					body: { success: false, error: "run not found" },
				};
			}
			const record = progress[Math.min(polls - 1, progress.length - 1)];
			polls += 1;
			return { body: { run: record } };
		});
		const client = createCoreWorkflowClient({
			nodeUrl: "http://127.0.0.1:7980",
			fetchImpl: core.fetchImpl,
			pollIntervalMs: 5,
		});
		const remote = client.createRun(pipeline, { runId: "r1" });
		const stream = remote.stream({
			inputData: { url: "https://example.com" },
			streamMode: ["events", "updates"],
		});
		const chunks = await collect(stream);
		const result = await stream.result;
		expect(result.status === "success" && result.result).toEqual({ words: 2 });

		const post = core.calls.find((call) => call.method === "POST");
		expect(post?.path).toBe("/workflows/pipeline/run");
		expect(post?.body).toEqual({
			input: { input: '{"url":"https://example.com"}' },
			runId: "r1",
		});
		expect(core.calls.some((call) => call.path === "/workflows/runs/r1")).toBe(
			true
		);

		const events = chunks
			.filter((chunk) => chunk.mode === "events")
			.map((chunk) => chunk.data as WorkflowEvent)
			.map((event) =>
				"stepId" in event ? `${event.type}:${event.stepId}` : event.type
			);
		expect(events[0]).toBe("workflow-start");
		expect(events.at(-1)).toBe("workflow-finish");
		expect(events).toContain("step-start:inner");
		expect(events).toContain("step-result:inner");
		expect(events).toContain("step-result:summarize");
		expect(events.indexOf("step-result:inner")).toBeLessThan(
			events.indexOf("step-result:summarize")
		);
		expect(
			chunks
				.filter((chunk) => chunk.mode === "updates")
				.map((chunk) => chunk.data)
		).toEqual([{ inner: "page" }, { summarize: { words: 2 } }]);
	});

	test("suspends at a human gate and resumes with a JSON payload", async () => {
		const gated = createWorkflow({ id: "gated", outputSchema: z.string() })
			.then(humanStep({ id: "approve", prompt: "OK?" }))
			.commit();
		const core = mockCore((call) => {
			if (call.path === "/workflows/gated/run") {
				return {
					body: {
						success: true,
						run: run({
							workflow_id: "gated",
							status: "awaiting_input",
							awaiting_node: "approve",
							nodes: { input: { status: "completed", output: "x" } },
						}),
					},
				};
			}
			if (call.path === "/workflows/runs/r1/resume") {
				return {
					body: {
						success: true,
						run: run({
							workflow_id: "gated",
							status: "completed",
							nodes: {
								approve: { status: "completed", output: '{"ok":true}' },
							},
							output: { output: '{"ok":true}' },
						}),
					},
				};
			}
			return { status: 404, body: {} };
		});
		const client = createCoreWorkflowClient({
			nodeUrl: "http://127.0.0.1:7980",
			fetchImpl: core.fetchImpl,
			pollIntervalMs: 5,
		});
		const remote = client.createRun(gated, { runId: "r1" });
		const first = await remote.start({ inputData: "x" });
		expect(first.status === "suspended" && first.suspended).toEqual([
			{ path: "approve", stepId: "approve", payload: null },
		]);
		const done = await remote.resume({ resumeData: { ok: true } });
		const resume = core.calls.find((call) => call.path.endsWith("/resume"));
		expect(resume?.body).toEqual({ payload: '{"ok":true}' });
		// The output schema is a string, so the raw text wins over parsed JSON.
		expect(done.status === "success" && done.result).toBe('{"ok":true}');
	});

	test("reports a failed run and keeps polling a limit-parked run", async () => {
		const failing = mockCore((call) =>
			call.method === "POST"
				? {
						status: 500,
						body: { success: false, error: "gateway unreachable" },
					}
				: { status: 404, body: {} }
		);
		const failingClient = createCoreWorkflowClient({
			nodeUrl: "http://127.0.0.1:7980",
			fetchImpl: failing.fetchImpl,
			pollIntervalMs: 5,
		});
		const failed = await failingClient
			.createRun(pipeline)
			.start({ inputData: { url: "u" } });
		expect(failed.status === "failed" && failed.error.message).toContain(
			"gateway unreachable"
		);

		let gets = 0;
		const waiting = mockCore((call) => {
			if (call.method === "POST") {
				return { body: { success: true, run: run({ status: "waiting" }) } };
			}
			gets += 1;
			return {
				body: {
					run:
						gets < 2
							? run({ status: "waiting" })
							: run({ status: "completed", output: { output: '{"words":5}' } }),
				},
			};
		});
		const waitingClient = createCoreWorkflowClient({
			nodeUrl: "http://127.0.0.1:7980",
			fetchImpl: waiting.fetchImpl,
			pollIntervalMs: 5,
		});
		const resumed = await waitingClient
			.createRun(pipeline, { runId: "r1" })
			.start({ inputData: { url: "u" } });
		expect(resumed.status === "success" && resumed.result).toEqual({
			words: 5,
		});
		expect(gets).toBe(2);
	});

	test("stops following a parked run on abort without claiming success", async () => {
		const core = mockCore((call) =>
			call.method === "POST"
				? { body: { success: true, run: run({ status: "waiting" }) } }
				: { body: { run: run({ status: "waiting" }) } }
		);
		const client = createCoreWorkflowClient({
			nodeUrl: "http://127.0.0.1:7980",
			fetchImpl: core.fetchImpl,
			pollIntervalMs: 5,
		});
		const controller = new AbortController();
		const pending = client
			.createRun(pipeline, { runId: "r1" })
			.start({ inputData: { url: "u" }, signal: controller.signal });
		setTimeout(() => controller.abort(), 20);
		const result = await pending;
		expect(result.status === "failed" && result.error.message).toContain(
			"before it finished (status waiting)"
		);
	});

	test("validates input before calling Core", async () => {
		const core = mockCore(() => ({ body: {} }));
		const client = createCoreWorkflowClient({
			nodeUrl: "http://127.0.0.1:7980",
			fetchImpl: core.fetchImpl,
		});
		await expect(
			client
				.createRun(pipeline)
				.start({ inputData: { url: 1 } as unknown as { url: string } })
		).rejects.toThrow(/failed validation/);
		expect(core.calls).toEqual([]);
	});

	test("refuses run ids Core cannot store", () => {
		const core = mockCore(() => ({ body: {} }));
		const client = createCoreWorkflowClient({
			nodeUrl: "http://127.0.0.1:7980",
			fetchImpl: core.fetchImpl,
		});
		expect(() => client.createRun(pipeline, { runId: "../escape" })).toThrow(
			/must be 1-64 characters/
		);
		expect(client.createRun(pipeline, { runId: "run_ok-1" }).runId).toBe(
			"run_ok-1"
		);
	});
});

describe("createCoreWorkflowClient getRun ids", () => {
	test("refuses empty, dot and dot-dot run ids before any request", async () => {
		const core = mockCore(() => ({ body: {} }));
		const client = createCoreWorkflowClient({
			baseUrl: "http://core.test",
			fetchImpl: core.fetchImpl,
		});
		for (const id of ["", ".", ".."]) {
			await expect(client.getRun(id)).rejects.toMatchObject({
				code: "invalid_id",
				status: 0,
			});
		}
		expect(core.calls).toEqual([]);
	});
});

describe("decodeCoreValue", () => {
	test("prefers parsed JSON, falls back to raw text for the schema", async () => {
		expect(await decodeCoreValue('{"a":1}')).toEqual({ a: 1 });
		expect(await decodeCoreValue("plain text")).toBe("plain text");
		expect(await decodeCoreValue("42", z.string())).toBe("42");
		expect(await decodeCoreValue("42", z.number())).toBe(42);
		await expect(decodeCoreValue("x", z.number())).rejects.toThrow(
			/failed validation/
		);
	});
});
