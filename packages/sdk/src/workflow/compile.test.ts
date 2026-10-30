import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
	agentStep,
	type CompiledWorkflow,
	createStep,
	createWorkflow,
	evalCoreCondition,
	humanStep,
	mcpStep,
	negateCoreExpr,
	nodeStep,
	toolStep,
	WorkflowCompileError,
	when,
} from "./index.ts";
import { CoreSimulator } from "./test-core-simulator.ts";

const double = createStep({
	id: "double",
	inputSchema: z.object({ n: z.number() }),
	outputSchema: z.object({ n: z.number() }),
	execute: ({ inputData }) => ({ n: inputData.n * 2 }),
});

const addThree = createStep({
	id: "add3",
	execute: ({ inputData }) => Number(inputData) + 3,
});

/** Run a compiled workflow through the Core model and decode its output. */
async function runOnCore(
	compiled: CompiledWorkflow,
	input: unknown,
	agent?: (agentId: string | null, prompt: string) => string
): Promise<unknown> {
	const sim = new CoreSimulator(compiled, agent);
	const text = typeof input === "string" ? input : JSON.stringify(input);
	const run = await sim.run(compiled.workflow.id, { input: text });
	const raw = run.output.output ?? "";
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

describe("compile to Core's workflow graph", () => {
	test("a linear chain compiles to input → steps → output", () => {
		const wf = createWorkflow({
			id: "linear",
			name: "Linear",
			description: "two steps",
			triggers: [{ type: "manual" }],
		})
			.then(double)
			.then(
				agentStep({
					id: "explain",
					agentId: "agent-writer",
					task: "Explain {{input}}",
					retry: { maxAttempts: 3, initialIntervalMs: 50 },
					timeoutMs: 1000,
				})
			)
			.then(
				toolStep({ id: "save", tool: "files.write", args: { path: "out.txt" } })
			)
			.then(mcpStep({ id: "ping", server: "spider", tool: "ping" }))
			.then(humanStep({ id: "approve", prompt: "OK?" }))
			.then(
				nodeStep({ id: "skill", node: { type: "skill", skill: "summarize" } })
			)
			.commit();
		const { workflow, children, stepNodes } = wf.toCore();
		expect(children).toEqual([]);
		expect(workflow).toEqual({
			id: "linear",
			name: "Linear",
			description: "two steps",
			triggers: [{ type: "manual" }],
			nodes: [
				{ id: "input", type: "input", key: "input" },
				{
					id: "double",
					type: "script",
					code: expect.stringContaining(
						"({ inputData: args, agent, parallel, pipeline, log, phase, emit: "
					),
				},
				{
					id: "explain",
					type: "agent",
					agent_id: "agent-writer",
					task: "Explain {{input}}",
					retry: { max_attempts: 3, initial_interval_ms: 50 },
					timeout_ms: 1000,
				},
				{
					id: "save",
					type: "tool",
					name: "files.write",
					args: { path: "out.txt" },
				},
				{ id: "ping", type: "mcp", server: "spider", tool: "ping" },
				{ id: "approve", type: "awakeable", prompt: "OK?" },
				{ id: "skill", type: "skill", skill: "summarize" },
				{ id: "output", type: "output", key: "output" },
			],
			edges: [
				{ from: "input", to: "double" },
				{ from: "double", to: "explain" },
				{ from: "explain", to: "save" },
				{ from: "save", to: "ping" },
				{ from: "ping", to: "approve" },
				{ from: "approve", to: "skill" },
				{ from: "skill", to: "output" },
			],
		});
		expect(stepNodes).toEqual({
			double: "double",
			explain: "explain",
			save: "save",
			ping: "ping",
			approve: "approve",
			skill: "skill",
		});
	});

	test("compiled script steps compute what the local executor computes", async () => {
		const wf = createWorkflow({ id: "math" })
			.then(double)
			.then(double)
			.commit();
		const local = await wf.createRun().start({ inputData: { n: 3 } });
		const core = await runOnCore(wf.toCore(), { n: 3 });
		expect(local.status === "success" && local.result).toEqual({ n: 12 });
		expect(core).toEqual({ n: 12 });
		expect(wf.toCore().workflow.nodes.map((node) => node.id)).toEqual([
			"input",
			"double",
			"double__2",
			"output",
		]);
	});

	test("method-shorthand execute functions serialize as expressions", async () => {
		const shout = createStep({
			id: "shout",
			execute({ inputData }) {
				return Promise.resolve(`${String(inputData).toUpperCase()}!`);
			},
		});
		const wf = createWorkflow({ id: "shout" }).then(shout).commit();
		expect(await runOnCore(wf.toCore(), "hey")).toBe("HEY!");
	});

	test("local-only context members fail clearly on Core; emit logs", async () => {
		const peek = createStep({
			id: "peek",
			execute: ({ getStepResult }) => getStepResult("earlier"),
		});
		const wf = createWorkflow({ id: "peek" }).then(peek).commit();
		await expect(runOnCore(wf.toCore(), "x")).rejects.toThrow(
			/getStepResult\(\) only works in the local executor/
		);
		const chatty = createStep({
			id: "chatty",
			execute: ({ inputData, emit }) => {
				emit({ progress: 1 });
				return `${String(inputData)}!`;
			},
		});
		const logged = createWorkflow({ id: "chatty" }).then(chatty).commit();
		expect(await runOnCore(logged.toCore(), "ok")).toBe("ok!");
	});

	test(".parallel compiles to tagged branches joined into an object", async () => {
		const a = createStep({
			id: "a",
			execute: ({ inputData }) => `a:${String(inputData)}`,
		});
		const b = createStep({
			id: "b",
			execute: () => ({ deep: [1, "two\nlines"] }),
		});
		const wf = createWorkflow({ id: "fan" }).parallel([a, b]).commit();
		const { workflow } = wf.toCore();
		expect(workflow.edges).toEqual([
			{ from: "input", to: "parallel_1--a" },
			{ from: "parallel_1--a", to: "parallel_1--tag--a" },
			{ from: "input", to: "parallel_1--b" },
			{ from: "parallel_1--b", to: "parallel_1--tag--b" },
			{ from: "parallel_1--tag--a", to: "parallel_1" },
			{ from: "parallel_1--tag--b", to: "parallel_1" },
			{ from: "parallel_1", to: "output" },
		]);
		const expected = { a: "a:x", b: { deep: [1, "two\nlines"] } };
		const local = await wf.createRun().start({ inputData: "x" });
		expect(local.status === "success" && local.result).toEqual(expected);
		expect(await runOnCore(wf.toCore(), "x")).toEqual(expected);
	});

	test(".branch compiles to condition gates that restore the tested value", async () => {
		// `execute` closes over `id`, which a serialized function cannot carry
		// to Core, so each step supplies its Core body through `script`.
		const tag = (id: string) =>
			createStep({
				id,
				execute: ({ inputData }) => `${id}<${String(inputData)}>`,
				script: `return ${JSON.stringify(id)} + "<" + String(args) + ">";`,
			});
		const wf = createWorkflow({ id: "router" })
			.branch([
				[when.contains("bug"), tag("bug")],
				[when.gt(5), tag("big")],
				[when.equals("hi"), tag("hello")],
			])
			.commit();
		const { workflow } = wf.toCore();
		expect(workflow.nodes).toContainEqual({
			id: "branch_1--if--bug",
			type: "condition",
			expr: 'input contains "bug"',
		});
		expect(workflow.nodes).toContainEqual({
			id: "branch_1--in--bug",
			type: "transform",
			op: "template",
			template: "{{nodes.input}}",
		});
		expect(workflow.edges).toContainEqual({
			from: "branch_1--if--bug",
			to: "branch_1--in--bug",
			branch: "true",
		});
		for (const input of ["a bug", "hi", "9", "nothing"]) {
			const local = await wf.createRun().start({ inputData: input });
			const core = await runOnCore(wf.toCore(), input);
			expect(core).toEqual(
				local.status === "success" ? local.result : undefined
			);
		}
		expect(await runOnCore(wf.toCore(), "nothing")).toEqual({});
		expect(await runOnCore(wf.toCore(), "9")).toEqual({ big: "big<9>" });
	});

	test(".foreach compiles to one bounded-concurrency script node", async () => {
		const square = createStep({
			id: "square",
			execute: ({ inputData }) => Number(inputData) ** 2,
		});
		const wf = createWorkflow({ id: "squares" })
			.foreach(square, { concurrency: 3 })
			.commit();
		const node = wf.toCore().workflow.nodes[1];
		expect(node).toMatchObject({ id: "foreach_1", type: "script" });
		expect(String(node && "code" in node ? node.code : "")).toContain(
			"Math.min(3,"
		);
		expect(await runOnCore(wf.toCore(), [1, 2, 3, 4])).toEqual([1, 4, 9, 16]);
		await expect(runOnCore(wf.toCore(), "oops")).rejects.toThrow(
			/needs an array input/
		);

		const summarize = agentStep({
			id: "summarize",
			agentId: "agent-sum",
			task: "Summarize {{input}}",
		});
		const agents = createWorkflow({ id: "summaries" })
			.foreach(summarize)
			.commit();
		const prompts: string[] = [];
		const result = await runOnCore(
			agents.toCore(),
			["x", { y: 1 }],
			(agentId, prompt) => {
				prompts.push(`${agentId}:${prompt}`);
				return `S(${prompt})`;
			}
		);
		expect(result).toEqual(["S(Summarize x)", 'S(Summarize {"y":1})']);
		expect(prompts).toEqual([
			"agent-sum:Summarize x",
			'agent-sum:Summarize {"y":1}',
		]);
	});

	test("loops compile to a first pass plus a while node over a body workflow", async () => {
		const wf = createWorkflow({ id: "count" })
			.dowhile(addThree, when.lt(10))
			.dountil(addThree, when.gte(20), { maxIterations: 50 })
			.commit();
		const { workflow, children } = wf.toCore();
		expect(children.map((child) => child.id)).toEqual([
			"count--dowhile_1",
			"count--dountil_2",
		]);
		expect(children[0]?.nodes.map((node) => node.type)).toEqual([
			"input",
			"script",
			"output",
		]);
		expect(workflow.nodes).toContainEqual({
			id: "dowhile_1--first",
			type: "sub_workflow",
			workflow_id: "count--dowhile_1",
		});
		expect(workflow.nodes).toContainEqual({
			id: "dowhile_1",
			type: "while",
			expr: "input < 10",
			body_workflow_id: "count--dowhile_1",
			max_iterations: 99,
		});
		expect(workflow.nodes).toContainEqual({
			id: "dountil_2",
			type: "while",
			expr: "input < 20",
			body_workflow_id: "count--dountil_2",
			max_iterations: 49,
		});
		const local = await wf.createRun().start({ inputData: 0 });
		expect(local.status === "success" && local.result).toBe(21);
		expect(await runOnCore(wf.toCore(), 0)).toBe(21);
		// A step that already satisfies the exit condition still runs once.
		expect(await runOnCore(wf.toCore(), 100)).toBe(106);

		const capped = createWorkflow({ id: "capped" })
			.dowhile(addThree, when.nonEmpty(), { maxIterations: 4 })
			.commit();
		expect(await runOnCore(capped.toCore(), 0)).toBe(12);
		const once = createWorkflow({ id: "once" })
			.dowhile(addThree, when.nonEmpty(), { maxIterations: 1 })
			.commit();
		expect(once.toCore().workflow.nodes.map((node) => node.type)).toEqual([
			"input",
			"sub_workflow",
			"output",
		]);
	});

	test("nested workflows deploy as children and run as sub_workflow nodes", async () => {
		const inner = createWorkflow({ id: "inner" }).then(double).commit();
		const middle = createWorkflow({ id: "middle" })
			.then(inner)
			.then(double)
			.commit();
		const outer = createWorkflow({ id: "outer" })
			.then(middle)
			.dowhile(inner, when.expr('input contains "n":4'), { maxIterations: 3 })
			.commit();
		const { workflow, children } = outer.toCore();
		expect(children.map((child) => child.id)).toEqual(["inner", "middle"]);
		expect(workflow.nodes).toContainEqual({
			id: "middle",
			type: "sub_workflow",
			workflow_id: "middle",
		});
		expect(workflow.nodes).toContainEqual(
			expect.objectContaining({
				id: "dowhile_1",
				type: "while",
				body_workflow_id: "inner",
			})
		);
		const local = await outer.createRun().start({ inputData: { n: 1 } });
		expect(local.status === "success" && local.result).toEqual({ n: 8 });
		expect(await runOnCore(outer.toCore(), { n: 1 })).toEqual({ n: 8 });
	});

	test(".map and .sleep compile to script and delay nodes", async () => {
		const wf = createWorkflow({ id: "shape" })
			.sleep(25)
			.map(({ inputData }) => ({ wrapped: inputData }))
			.commit();
		const { workflow } = wf.toCore();
		expect(workflow.nodes[1]).toEqual({ id: "sleep_1", type: "delay", ms: 25 });
		expect(workflow.nodes[2]).toMatchObject({ id: "map_2", type: "script" });
		expect(await runOnCore(wf.toCore(), "v")).toEqual({ wrapped: "v" });
	});

	test("refuses graphs Core cannot run", () => {
		const local = createStep({
			id: "local",
			localOnly: "reads the local filesystem",
			execute: () => "x",
		});
		expect(() =>
			createWorkflow({ id: "loc" }).then(local).commit().toCore()
		).toThrow(/local-only: reads the local filesystem/);
		expect(() =>
			createWorkflow({ id: "fn-branch" })
				.branch([[() => true, double]])
				.commit()
				.toCore()
		).toThrow(WorkflowCompileError);
		expect(() =>
			createWorkflow({ id: "bad id!" }).then(double).commit().toCore()
		).toThrow(/not a valid Core id/);
		expect(() =>
			createWorkflow({ id: "dotted" })
				.then(createStep({ id: "fetch.page", execute: () => "x" }))
				.commit()
				.toCore()
		).toThrow(/step id "fetch.page" is not a valid Core id/);
		expect(() =>
			createWorkflow({ id: "until-contains" })
				.dountil(addThree, when.contains("x"))
				.commit()
				.toCore()
		).toThrow(/cannot negate/);
		expect(() =>
			createWorkflow({ id: "too-long" })
				.dowhile(addThree, when.nonEmpty(), { maxIterations: 500 })
				.commit()
				.toCore()
		).toThrow(/at most 101 passes/);
		const tool = toolStep({ id: "t", tool: "a.b" });
		expect(() =>
			createWorkflow({ id: "each-tool" }).foreach(tool).commit().toCore()
		).toThrow(/cannot run per item on Core/);
		expect(() =>
			createWorkflow({ id: "uncommitted" }).then(double).toCore()
		).toThrow(/must be committed/);
	});
});

describe("Core condition grammar port", () => {
	test("matches Core's eval_condition test vectors", () => {
		// apps/core/src/workflow/executor_tests.rs `conditions_evaluate*`.
		expect(evalCoreCondition('input == "yes"', "yes")).toBe(true);
		expect(evalCoreCondition('input == "yes"', "no")).toBe(false);
		expect(evalCoreCondition('input != "yes"', "no")).toBe(true);
		expect(evalCoreCondition('input contains "ell"', "hello")).toBe(true);
		expect(evalCoreCondition('input starts_with "he"', "hello")).toBe(true);
		expect(evalCoreCondition('input starts_with "lo"', "hello")).toBe(false);
		expect(evalCoreCondition('input ends_with "lo"', "hello")).toBe(true);
		expect(evalCoreCondition('input ends_with "he"', "hello")).toBe(false);
		expect(evalCoreCondition("input nonempty", "x")).toBe(true);
		expect(evalCoreCondition("input empty", "")).toBe(true);
		expect(evalCoreCondition("input < 10", "3")).toBe(true);
		expect(evalCoreCondition("input < 10", "10")).toBe(false);
		expect(evalCoreCondition("input > 5", "6")).toBe(true);
		expect(evalCoreCondition("input > 5", "5")).toBe(false);
		expect(evalCoreCondition("input <= 10", "10")).toBe(true);
		expect(evalCoreCondition("input <= 10", "11")).toBe(false);
		expect(evalCoreCondition("input >= 5", "5")).toBe(true);
		expect(evalCoreCondition("input >= 5", "4")).toBe(false);
		expect(evalCoreCondition("input < 2.5", "2.49")).toBe(true);
		expect(evalCoreCondition("input <= 3 ", " 3 ")).toBe(true);
		expect(evalCoreCondition("input < 10", "abc")).toBe(false);
		expect(evalCoreCondition("input > x", "5")).toBe(false);
		expect(evalCoreCondition("raw", "raw")).toBe(true);
		expect(evalCoreCondition("input < 10", "")).toBe(false);
	});

	test("negation round-trips and refuses what the grammar cannot express", () => {
		expect(negateCoreExpr('input == "a"')).toBe('input != "a"');
		expect(negateCoreExpr("input <= 3")).toBe("input > 3");
		expect(negateCoreExpr("input empty")).toBe("input nonempty");
		expect(() => negateCoreExpr('input ends_with "x"')).toThrow(
			/cannot negate/
		);
	});
});
