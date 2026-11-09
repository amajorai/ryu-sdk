import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { RunnableContext } from "../runnable/runnable-types.ts";
import {
	agentStep,
	createStep,
	createWorkflow,
	humanStep,
	type StreamChunk,
	toolStep,
	type WorkflowEvent,
	WorkflowValidationError,
	when,
} from "./index.ts";

const double = createStep({
	id: "double",
	inputSchema: z.object({ n: z.number() }),
	outputSchema: z.object({ n: z.number() }),
	execute: ({ inputData }) => ({ n: inputData.n * 2 }),
});

const increment = createStep({
	id: "increment",
	inputSchema: z.object({ n: z.number() }),
	outputSchema: z.object({ n: z.number() }),
	execute: ({ inputData }) => ({ n: inputData.n + 1 }),
});

function gateway(): RunnableContext {
	return {
		gateway: {
			chat: () => Promise.reject(new Error("no model in tests")),
			stream: () => {
				throw new Error("no model in tests");
			},
		},
	};
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

describe("createWorkflow local execution", () => {
	test("runs a typed .then chain and validates input and output", async () => {
		const wf = createWorkflow({
			id: "math",
			inputSchema: z.object({ n: z.number() }),
			outputSchema: z.object({ n: z.number() }),
		})
			.then(double)
			.then(increment)
			.commit();

		const result = await wf.createRun().start({ inputData: { n: 3 } });
		expect(result.status).toBe("success");
		if (result.status === "success") {
			expect(result.result).toEqual({ n: 7 });
			expect(Object.keys(result.steps)).toEqual(["double", "increment"]);
		}

		const bad = await wf
			.createRun()
			.start({ inputData: { n: "three" } as unknown as { n: number } });
		expect(bad.status).toBe("failed");
		if (bad.status === "failed") {
			expect(bad.error).toBeInstanceOf(WorkflowValidationError);
		}
	});

	test("a step used twice gets distinct paths", async () => {
		const wf = createWorkflow({ id: "twice" })
			.then(double)
			.then(double)
			.commit();
		const result = await wf.createRun().start({ inputData: { n: 1 } });
		expect(result.status === "success" && result.result).toEqual({ n: 4 });
		expect(Object.keys(result.steps)).toEqual(["double", "double#2"]);
	});

	test("refuses to run or extend before/after commit", () => {
		const wf = createWorkflow({ id: "open" }).then(double);
		expect(() => wf.createRun()).toThrow(/must be committed/);
		wf.commit();
		expect(() => wf.then(increment)).toThrow(/is committed/);
		expect(() => createWorkflow({ id: "empty" }).commit()).toThrow(/no steps/);
	});

	test(".parallel runs steps concurrently and keys outputs by step id", async () => {
		let active = 0;
		let peak = 0;
		const slow = <TId extends string>(id: TId, value: number) =>
			createStep({
				id,
				execute: async () => {
					active += 1;
					peak = Math.max(peak, active);
					await new Promise((resolve) => setTimeout(resolve, 15));
					active -= 1;
					return value;
				},
			});
		const wf = createWorkflow({ id: "fan" })
			.parallel([slow("a", 1), slow("b", 2), slow("c", 3)])
			.map(({ inputData }) => inputData.a + inputData.b + inputData.c)
			.commit();
		const result = await wf.createRun().start({ inputData: null });
		expect(result.status === "success" && result.result).toBe(6);
		expect(peak).toBe(3);
		expect(Object.keys(result.steps)).toContain("parallel_1.b");
	});

	test(".branch runs every matching arm with portable and predicate conditions", async () => {
		const tag = (id: string) =>
			createStep({
				id,
				execute: ({ inputData }) => `${id}:${String(inputData)}`,
			});
		const wf = createWorkflow({ id: "router" })
			.branch([
				[when.contains("bug"), tag("bug")],
				[({ inputData }) => String(inputData).length > 10, tag("long")],
				[when.equals("hello"), tag("greeting")],
			])
			.commit();

		const bug = await wf.createRun().start({ inputData: "a bug report here" });
		expect(bug.status === "success" && bug.result).toEqual({
			bug: "bug:a bug report here",
			long: "long:a bug report here",
		});
		const none = await wf.createRun().start({ inputData: "nope" });
		expect(none.status === "success" && none.result).toEqual({});
	});

	test(".foreach honours its concurrency bound and keeps order", async () => {
		let active = 0;
		let peak = 0;
		const square = createStep({
			id: "square",
			inputSchema: z.number(),
			execute: async ({ inputData }) => {
				active += 1;
				peak = Math.max(peak, active);
				await new Promise((resolve) =>
					setTimeout(resolve, 5 * (5 - inputData))
				);
				active -= 1;
				return inputData * inputData;
			},
		});
		const wf = createWorkflow({
			id: "squares",
			inputSchema: z.array(z.number()),
		})
			.foreach(square, { concurrency: 2 })
			.commit();
		const result = await wf.createRun().start({ inputData: [1, 2, 3, 4] });
		expect(result.status === "success" && result.result).toEqual([1, 4, 9, 16]);
		expect(peak).toBe(2);
		expect(Object.keys(result.steps)).toContain("foreach_1[3].square");

		const notArray = await wf
			.createRun()
			.start({ inputData: 5 as unknown as number[] });
		expect(notArray.status).toBe("failed");
	});

	test(".dowhile / .dountil loop on the step output with a pass cap", async () => {
		const add = createStep({
			id: "add",
			execute: ({ inputData }) => Number(inputData) + 3,
		});
		const whileWf = createWorkflow({ id: "w" })
			.dowhile(add, when.lt(10))
			.commit();
		const untilWf = createWorkflow({ id: "u" })
			.dountil(add, ({ inputData }) => inputData >= 10)
			.commit();
		const capped = createWorkflow({ id: "c" })
			.dowhile(add, when.nonEmpty(), { maxIterations: 4 })
			.commit();

		const a = await whileWf.createRun().start({ inputData: 0 });
		expect(a.status === "success" && a.result).toBe(12);
		const b = await untilWf.createRun().start({ inputData: 0 });
		expect(b.status === "success" && b.result).toBe(12);
		const c = await capped.createRun().start({ inputData: 0 });
		expect(c.status === "success" && c.result).toBe(12);
		expect(Object.keys(c.steps)).toEqual([
			"dowhile_1[1].add",
			"dowhile_1[2].add",
			"dowhile_1[3].add",
			"dowhile_1[4].add",
		]);
	});

	test("nested workflows run as steps with their own schemas", async () => {
		const inner = createWorkflow({
			id: "inner",
			inputSchema: z.object({ n: z.number() }),
			outputSchema: z.object({ n: z.number() }),
		})
			.then(double)
			.then(increment)
			.commit();
		const outer = createWorkflow({ id: "outer" })
			.then(inner)
			.then(double)
			.commit();
		const result = await outer.createRun().start({ inputData: { n: 1 } });
		expect(result.status === "success" && result.result).toEqual({ n: 6 });
		expect(Object.keys(result.steps)).toEqual([
			"inner/double",
			"inner/increment",
			"inner",
			"double",
		]);
	});

	test("suspend and resume a human gate, also across a snapshot", async () => {
		const approve = humanStep({
			id: "approve",
			prompt: "Ship it?",
			resumeSchema: z.object({ approved: z.boolean() }),
		});
		let draftRuns = 0;
		const draft = createStep({
			id: "draft",
			execute: ({ inputData }) => {
				draftRuns += 1;
				return `draft of ${String(inputData)}`;
			},
		});
		const publish = createStep({
			id: "publish",
			execute: ({ inputData, getStepResult }) =>
				(inputData as { approved: boolean }).approved
					? `published ${getStepResult<string>("draft")}`
					: "rejected",
		});
		const wf = createWorkflow({ id: "review" })
			.then(draft)
			.then(approve)
			.then(publish)
			.commit();

		const run = wf.createRun();
		const first = await run.start({ inputData: "notes" });
		expect(first.status).toBe("suspended");
		if (first.status === "suspended") {
			expect(first.suspended).toEqual([
				{ path: "approve", stepId: "approve", payload: { prompt: "Ship it?" } },
			]);
		}

		const restored = wf.createRun({
			snapshot: JSON.parse(JSON.stringify(run.snapshot())),
		});
		expect(restored.runId).toBe(run.runId);
		await expect(
			restored.resume({ resumeData: { approved: "yes" } })
		).resolves.toMatchObject({
			status: "failed",
		});
		// The failed resume left the run failed; resume from the snapshot again.
		const again = wf.createRun({ snapshot: run.snapshot() });
		const done = await again.resume({
			step: approve,
			resumeData: { approved: true },
		});
		expect(done.status === "success" && done.result).toBe(
			"published draft of notes"
		);
		expect(draftRuns).toBe(1);
	});

	test("parallel suspensions resume one at a time", async () => {
		const gate = (id: string) =>
			createStep({
				id,
				execute: async ({ resumeData, suspend }) => {
					if (resumeData === undefined) {
						return await suspend({ id });
					}
					return `${id}=${String(resumeData)}`;
				},
			});
		const wf = createWorkflow({ id: "two-gates" })
			.parallel([gate("left"), gate("right")])
			.commit();
		const run = wf.createRun();
		const first = await run.start({ inputData: null });
		expect(
			first.status === "suspended" && first.suspended.map((s) => s.stepId)
		).toEqual(["left", "right"]);
		expect(() => run.resume({ resumeData: 1 })).toThrow(/pass `step`/);
		const second = await run.resume({ step: "left", resumeData: 1 });
		expect(
			second.status === "suspended" && second.suspended.map((s) => s.path)
		).toEqual(["parallel_1.right"]);
		const third = await run.resume({ resumeData: 2 });
		expect(third.status === "success" && third.result).toEqual({
			left: "left=1",
			right: "right=2",
		});
	});

	test("retries with backoff, fails fast on non-retryable errors, and times out", async () => {
		let attempts = 0;
		const flaky = createStep({
			id: "flaky",
			retry: { maxAttempts: 3, initialIntervalMs: 1 },
			execute: () => {
				attempts += 1;
				if (attempts < 3) {
					throw new Error("transient");
				}
				return "ok";
			},
		});
		const ok = await createWorkflow({ id: "r" })
			.then(flaky)
			.commit()
			.createRun()
			.start({ inputData: null });
		expect(ok.status === "success" && ok.result).toBe("ok");
		expect(attempts).toBe(3);

		let fatalAttempts = 0;
		const fatal = createStep({
			id: "fatal",
			retry: {
				maxAttempts: 5,
				initialIntervalMs: 1,
				nonRetryableErrors: ["FORBIDDEN"],
			},
			execute: () => {
				fatalAttempts += 1;
				throw new Error("403 forbidden");
			},
		});
		const failed = await createWorkflow({ id: "f" })
			.then(fatal)
			.commit()
			.createRun()
			.start({ inputData: null });
		expect(failed.status).toBe("failed");
		expect(fatalAttempts).toBe(1);
		expect(failed.steps.fatal).toEqual({
			status: "failed",
			stepId: "fatal",
			error: "403 forbidden",
		});

		let abandonedSawAbort = false;
		const slow = createStep({
			id: "slow",
			timeoutMs: 5,
			execute: ({ signal }) =>
				new Promise((resolve) => {
					signal.addEventListener("abort", () => {
						abandonedSawAbort = true;
					});
					setTimeout(() => resolve("late"), 200);
				}),
		});
		const timedOut = await createWorkflow({ id: "t" })
			.then(slow)
			.commit()
			.createRun()
			.start({ inputData: null });
		expect(timedOut.status === "failed" && timedOut.error.message).toContain(
			"timed out"
		);
		// The timed-out attempt is told to stop.
		expect(abandonedSawAbort).toBe(true);
	});

	test("state, init data, map, and sleep", async () => {
		const remember = createStep({
			id: "remember",
			execute: ({ inputData, setState, getInitData }) => {
				setState({ seen: inputData, init: getInitData() });
				return inputData;
			},
		});
		const readState = createStep({
			id: "read",
			execute: ({ state }) => state,
		});
		const wf = createWorkflow({ id: "stateful" })
			.then(remember)
			.sleep(1)
			.map(({ inputData }) => `${String(inputData)}!`)
			.then(readState)
			.commit();
		const result = await wf
			.createRun()
			.start({ inputData: "hi", initialState: { a: 1 } });
		expect(result.status === "success" && result.result).toEqual({
			a: 1,
			seen: "hi",
			init: "hi",
		});
		expect(result.steps.map_2).toEqual({
			status: "success",
			stepId: "map_2",
			output: "hi!",
		});
	});

	test("streams events, updates, and values", async () => {
		const wf = createWorkflow({ id: "streamy" })
			.then(double)
			.then(increment)
			.commit();
		const events = await collect(
			wf.createRun().stream({ inputData: { n: 1 } })
		);
		expect(events.map((chunk) => (chunk.data as WorkflowEvent).type)).toEqual([
			"workflow-start",
			"step-start",
			"step-result",
			"step-start",
			"step-result",
			"workflow-finish",
		]);

		const run = wf.createRun();
		const stream = run.stream({
			inputData: { n: 1 },
			streamMode: ["updates", "values"],
		});
		const chunks = await collect(stream);
		expect(
			chunks.filter((c) => c.mode === "updates").map((c) => c.data)
		).toEqual([{ double: { n: 2 } }, { increment: { n: 3 } }]);
		const values = chunks.filter((c) => c.mode === "values");
		expect(values.at(-1)?.data).toMatchObject({
			status: "success",
			output: { n: 3 },
		});
		expect((await stream.result).status).toBe("success");
	});

	test("emit() and watch() surface custom step output", async () => {
		const chatty = createStep({
			id: "chatty",
			execute: ({ emit }) => {
				emit({ progress: 0.5 });
				return "done";
			},
		});
		const run = createWorkflow({ id: "chatty-wf" })
			.then(chatty)
			.commit()
			.createRun();
		const seen: WorkflowEvent[] = [];
		const stop = run.watch((event) => seen.push(event));
		await run.start({ inputData: null });
		stop();
		expect(seen.find((event) => event.type === "step-output")).toMatchObject({
			stepId: "chatty",
			data: { progress: 0.5 },
		});
	});

	test("cancel() aborts a running workflow", async () => {
		const wait = createStep({
			id: "wait",
			execute: ({ signal }) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		});
		const run = createWorkflow({ id: "cancel" })
			.then(wait)
			.then(double)
			.commit()
			.createRun();
		const pending = run.start({ inputData: null });
		run.cancel();
		const result = await pending;
		expect(result.status).toBe("failed");
		expect(result.steps.double).toBeUndefined();
	});

	test("agent and tool steps run through local implementations", async () => {
		const prompts: string[] = [];
		const writer = agentStep({
			id: "writer",
			agentId: "agent-writer",
			task: "Write about {{input}}",
			agent: {
				generate: (prompt) => {
					prompts.push(prompt);
					return Promise.resolve({ text: `essay(${prompt})` });
				},
			},
		});
		const search = toolStep({
			id: "search",
			tool: "spider.crawl",
			args: { url: "https://example.com/{{input}}" },
			call: (args) => args,
		});
		const wf = createWorkflow({ id: "agents" })
			.then(search)
			.then(writer)
			.commit();
		const result = await wf.createRun().start({ inputData: "otters" });
		expect(result.steps.search?.output).toEqual({
			url: "https://example.com/otters",
			input: "otters",
		});
		expect(prompts).toEqual([
			'Write about {"url":"https://example.com/otters","input":"otters"}',
		]);
		expect(result.status).toBe("success");

		const missing = await createWorkflow({ id: "no-agent" })
			.then(agentStep({ id: "a", agentId: "x" }))
			.commit()
			.createRun()
			.start({ inputData: "x" });
		expect(missing.status === "failed" && missing.error.message).toContain(
			"no local agent"
		);
		expect(() => toolStep({ id: "bad", tool: "nodot" })).toThrow(
			/<server>.<tool>/
		);
	});

	test("the documented triage example behaves as documented", async () => {
		const classify = createStep({
			id: "classify",
			inputSchema: z.object({ text: z.string() }),
			outputSchema: z.string(),
			execute: async ({ inputData }) =>
				inputData.text.toLowerCase().includes("error") ? "bug" : "question",
		});
		const fileBug = createStep({
			id: "fileBug",
			execute: async ({ getInitData }) =>
				`filed: ${getInitData<{ text: string }>().text}`,
			localOnly: "calls the issue tracker from this process",
		});
		const answer = createStep({
			id: "answer",
			execute: async () => "see the FAQ",
		});
		const triage = createWorkflow({
			id: "triage",
			inputSchema: z.object({ text: z.string() }),
			outputSchema: z.string(),
		})
			.then(classify)
			.branch([
				[when.equals("bug"), fileBug],
				[when.equals("question"), answer],
			])
			.map(async ({ inputData }) => inputData.fileBug ?? inputData.answer ?? "")
			.commit();
		const bug = await triage
			.createRun()
			.start({ inputData: { text: "500 error on save" } });
		expect(bug.status === "success" && bug.result).toBe(
			"filed: 500 error on save"
		);
		const question = await triage
			.createRun()
			.start({ inputData: { text: "how do I log in?" } });
		expect(question.status === "success" && question.result).toBe(
			"see the FAQ"
		);
		expect(() => triage.toCore()).toThrow(/calls the issue tracker/);
	});

	test("type-checks step inputs and refuses to be awaited", async () => {
		const typed = createWorkflow({ id: "typed", inputSchema: z.string() });
		// @ts-expect-error `double` takes { n: number }, the current value is a string
		typed.then(double);
		expect(typed.stages).toHaveLength(1);

		const wf = createWorkflow({ id: "not-a-promise" }).then(double).commit();
		await expect(Promise.resolve(wf as unknown)).rejects.toThrow(
			/not awaitable/
		);
	});

	test("a workflow is a Runnable", async () => {
		const wf = createWorkflow({ id: "runnable" }).then(double).commit();
		expect(wf.kind).toBe("workflow");
		await expect(wf.run({ n: 5 }, gateway())).resolves.toEqual({ n: 10 });
		const gated = createWorkflow({ id: "gated" })
			.then(humanStep({ id: "ok" }))
			.commit();
		await expect(gated.run(null, gateway())).rejects.toThrow(/suspended at ok/);
	});
});
