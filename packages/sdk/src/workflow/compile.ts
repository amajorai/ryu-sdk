/**
 * Compile a DSL workflow to Core's JSON workflow graph.
 *
 * Mapping. A step that runs once at the top level keeps its step id as its
 * node id, so `{{nodes.<stepId>}}` templates resolve the same locally and on
 * Core. Every other node id is derived from its stage (`parallel_1--a`,
 * `branch_2--if--bug`, `dowhile_3--first`, `step__2` for a repeated step).
 * Core builds run and checkpoint file names from node ids (a `sub_workflow`
 * child run is `<runId>-sub-<nodeId>`), so node ids are restricted to
 * `[A-Za-z0-9_-]`, and a step id outside that set fails to compile.
 *
 * | DSL                    | Core graph                                                                 |
 * |------------------------|----------------------------------------------------------------------------|
 * | workflow input/output  | `input` node (key `input`) → … → `output` node (key `output`)               |
 * | `createStep`           | `script` node running the step body                                        |
 * | `agentStep`            | `agent` node                                                               |
 * | `toolStep` / `mcpStep` | `tool` / `mcp` node                                                        |
 * | `humanStep`            | `awakeable` node (resume with `POST /workflows/runs/:id/resume`)           |
 * | nested workflow        | `sub_workflow` node + the nested definition in `children`                  |
 * | `.parallel`            | one branch per step from the same source, each tagged by a `script` node,  |
 * |                        | joined by a `script` node (id = the stage id) that builds `{ [id]: out }`  |
 * | `.branch`              | per arm: `condition` → (true) `transform` restoring the value → step → tag; |
 * |                        | an always-on arm keeps the join alive when no condition matches            |
 * | `.foreach`             | one `script` node that runs the step per item with bounded concurrency     |
 * |                        | (script and agent steps)                                                   |
 * | `.dowhile` / `.dountil`| `sub_workflow` (first pass) → `while` over a body workflow                 |
 * | `.map`                 | `script` node running the serialized function                              |
 * | `.sleep`               | `delay` node (a durable timer)                                             |
 *
 * Values cross nodes as text: script steps receive their input as `args`
 * (parsed JSON when it is JSON) and emit strings verbatim, anything else as
 * JSON, so structured values round-trip between script steps.
 */

import { isCoreCondition, negateCoreExpr } from "./conditions.ts";
import {
	CORE_INPUT_KEY,
	CORE_OUTPUT_KEY,
	type CompiledWorkflow,
	type CoreEdge,
	type CoreNode,
	type CoreNodeKind,
	type CoreRawNodeKind,
	type CoreRetryPolicy,
	type CoreWorkflow,
	MAX_CORE_LOOP_ITERATIONS,
} from "./core-types.ts";
import type { StepRetryPolicy } from "./step.ts";
import type { AnyStep, AnyStepLike, Stage, WorkflowLike } from "./workflow.ts";

/** Raised when a workflow cannot be expressed as a Core graph. */
export class WorkflowCompileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowCompileError";
	}
}

const CORE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const INPUT_NODE = "input";
const OUTPUT_NODE = "output";

function assertCoreId(id: string, what = "workflow id"): void {
	if (!CORE_ID.test(id)) {
		throw new WorkflowCompileError(
			`${what} "${id}" is not a valid Core id (use 1-128 of [A-Za-z0-9_-])`
		);
	}
}

/** Join the parts of a derived node id. */
function nodeId(...parts: string[]): string {
	return parts.join("--");
}

function retryPolicy(policy: StepRetryPolicy): CoreRetryPolicy {
	const out: CoreRetryPolicy = {};
	if (policy.maxAttempts !== undefined) {
		out.max_attempts = policy.maxAttempts;
	}
	if (policy.initialIntervalMs !== undefined) {
		out.initial_interval_ms = policy.initialIntervalMs;
	}
	if (policy.backoffCoefficient !== undefined) {
		out.backoff_coefficient = policy.backoffCoefficient;
	}
	if (policy.maxIntervalMs !== undefined) {
		out.max_interval_ms = policy.maxIntervalMs;
	}
	if (policy.nonRetryableErrors !== undefined) {
		out.non_retryable_errors = [...policy.nonRetryableErrors];
	}
	return out;
}

/** Drop absent optional fields so the JSON matches what Core would emit. */
function cleanKind(kind: CoreNodeKind | CoreRawNodeKind): CoreRawNodeKind {
	const out: CoreRawNodeKind = { type: kind.type };
	for (const [key, value] of Object.entries(kind)) {
		if (value !== undefined && value !== null) {
			out[key] = value;
		}
	}
	return out;
}

/** Tag a branch output with its step id for the join. */
function tagScript(stepId: string): string {
	return `return { key: ${JSON.stringify(stepId)}, value: args };`;
}

const JOIN_SCRIPT = [
	'const __lines = typeof args === "string" ? args.split("\\n") : args == null ? [] : [JSON.stringify(args)];',
	"const __out = {};",
	"for (const __line of __lines) {",
	"  if (!__line.trim()) continue;",
	"  const __entry = JSON.parse(__line);",
	'  if (__entry && typeof __entry.key === "string" && !__entry.key.startsWith("__")) __out[__entry.key] = __entry.value;',
	"}",
	"return __out;",
].join("\n");

const NO_MATCH_SCRIPT = 'return { key: "__none", value: null };';

function textExpr(variable: string): string {
	return `(typeof ${variable} === "string" ? ${variable} : JSON.stringify(${variable}))`;
}

/** A JS function body (input `args`) that runs one step inside a script. */
function inlineStepBody(step: AnyStepLike, where: string): string {
	if (step.kind !== "step") {
		throw new WorkflowCompileError(
			`${where}: nested workflow "${step.id}" cannot run per item on Core; use a script or agent step`
		);
	}
	const core = step.core;
	if (core.kind === "script") {
		return core.body;
	}
	if (core.kind === "node" && core.node.type === "agent") {
		const node = core.node;
		const agentId = typeof node.agent_id === "string" ? node.agent_id : "";
		const task = typeof node.task === "string" ? node.task : undefined;
		const prompt = task
			? `${JSON.stringify(task)}.split("{{input}}").join(${textExpr("args")})`
			: textExpr("args");
		return `return await agent(${prompt}, { agent_id: ${JSON.stringify(agentId)} });`;
	}
	if (core.kind === "local") {
		throw new WorkflowCompileError(
			`${where}: step "${step.id}" is local-only: ${core.reason}`
		);
	}
	throw new WorkflowCompileError(
		`${where}: step "${step.id}" (${core.node.type}) cannot run per item on Core; use a script or agent step`
	);
}

function foreachScript(
	body: string,
	concurrency: number,
	stageId: string
): string {
	return [
		`if (!Array.isArray(args)) throw new Error(${JSON.stringify(`.foreach() at "${stageId}" needs an array input`)});`,
		"const __items = args;",
		`const __step = async (args) => {\n${body}\n};`,
		"const __results = new Array(__items.length);",
		"let __next = 0;",
		"const __worker = async () => {",
		"  while (__next < __items.length) {",
		"    const __index = __next++;",
		"    __results[__index] = await __step(__items[__index]);",
		"  }",
		"};",
		`await Promise.all(Array.from({ length: Math.min(${concurrency}, __items.length) }, __worker));`,
		"return __results;",
	].join("\n");
}

interface CompileContext {
	readonly children: Map<string, CoreWorkflow>;
	readonly inProgress: Set<string>;
}

class GraphBuilder {
	readonly edges: CoreEdge[] = [];
	readonly nodes: CoreNode[] = [];
	readonly stepNodes: Record<string, string> = {};
	readonly #ids = new Set<string>();

	add(node: CoreNode, stepId?: string): string {
		assertCoreId(node.id, "Core node id");
		if (this.#ids.has(node.id)) {
			throw new WorkflowCompileError(`duplicate Core node id "${node.id}"`);
		}
		this.#ids.add(node.id);
		this.nodes.push(node);
		if (stepId !== undefined) {
			this.stepNodes[node.id] = stepId;
		}
		return node.id;
	}

	edge(from: string, to: string, branch?: string): void {
		this.edges.push(branch ? { from, to, branch } : { from, to });
	}
}

class Compiler {
	readonly #context: CompileContext;

	constructor(context: CompileContext) {
		this.#context = context;
	}

	/** Compile one workflow definition (primary or child). */
	definition(
		workflow: WorkflowLike,
		primary = false
	): {
		definition: CoreWorkflow;
		stepNodes: Record<string, string>;
	} {
		assertCoreId(workflow.id);
		if (workflow.stages.length === 0) {
			throw new WorkflowCompileError(`workflow "${workflow.id}" has no steps`);
		}
		const graph = new GraphBuilder();
		graph.add({ id: INPUT_NODE, type: "input", key: CORE_INPUT_KEY });
		const tail = this.#stages(graph, workflow, workflow.stages, INPUT_NODE);
		graph.add({ id: OUTPUT_NODE, type: "output", key: CORE_OUTPUT_KEY });
		graph.edge(tail, OUTPUT_NODE);
		const definition: CoreWorkflow = {
			id: workflow.id,
			name: workflow.name,
			nodes: graph.nodes,
			edges: graph.edges,
		};
		if (workflow.description) {
			definition.description = workflow.description;
		}
		if (primary && "triggers" in workflow && Array.isArray(workflow.triggers)) {
			definition.triggers = workflow.triggers;
		}
		return { definition, stepNodes: graph.stepNodes };
	}

	/** Compile a nested workflow once and return its id. */
	#child(workflow: WorkflowLike): string {
		if (this.#context.inProgress.has(workflow.id)) {
			throw new WorkflowCompileError(
				`workflow "${workflow.id}" nests itself; Core workflows must not recurse`
			);
		}
		if (!this.#context.children.has(workflow.id)) {
			this.#context.inProgress.add(workflow.id);
			const { definition } = this.definition(workflow);
			this.#context.inProgress.delete(workflow.id);
			this.#context.children.set(workflow.id, definition);
		}
		return workflow.id;
	}

	/** A one-step body workflow for a loop over a plain step. */
	#loopBody(owner: WorkflowLike, loopId: string, step: AnyStep): string {
		const id = `${owner.id}--${loopId}`.replace(/[^A-Za-z0-9_-]/g, "_");
		assertCoreId(id);
		const graph = new GraphBuilder();
		graph.add({ id: INPUT_NODE, type: "input", key: CORE_INPUT_KEY });
		const reserved = step.id === INPUT_NODE || step.id === OUTPUT_NODE;
		const node = this.#stepNode(
			graph,
			step,
			reserved ? `${step.id}__2` : step.id
		);
		graph.edge(INPUT_NODE, node);
		graph.add({ id: OUTPUT_NODE, type: "output", key: CORE_OUTPUT_KEY });
		graph.edge(node, OUTPUT_NODE);
		this.#context.children.set(id, {
			id,
			name: `${owner.name} · ${loopId}`,
			nodes: graph.nodes,
			edges: graph.edges,
		});
		return id;
	}

	#stepNode(graph: GraphBuilder, step: AnyStepLike, nodeId: string): string {
		assertCoreId(step.id, "step id");
		if (step.kind === "workflow") {
			const workflowId = this.#child(step);
			return graph.add(
				{ id: nodeId, type: "sub_workflow", workflow_id: workflowId },
				step.id
			);
		}
		const core = step.core;
		let kind: CoreRawNodeKind;
		if (core.kind === "local") {
			throw new WorkflowCompileError(
				`step "${step.id}" is local-only: ${core.reason}`
			);
		}
		if (core.kind === "script") {
			kind = { type: "script", code: core.body };
		} else {
			kind = cleanKind(core.node);
		}
		const node: CoreNode = { ...kind, id: nodeId };
		if (step.retry) {
			node.retry = retryPolicy(step.retry);
		}
		if (step.timeoutMs !== undefined) {
			node.timeout_ms = step.timeoutMs;
		}
		return graph.add(node, step.id);
	}

	#stages(
		graph: GraphBuilder,
		owner: WorkflowLike,
		stages: readonly Stage[],
		from: string
	): string {
		const counts = new Map<string, number>();
		const pathFor = (id: string): string => {
			const reserved = id === INPUT_NODE || id === OUTPUT_NODE ? 1 : 0;
			const count = (counts.get(id) ?? reserved) + 1;
			counts.set(id, count);
			return count === 1 ? id : `${id}__${count}`;
		};
		let tail = from;
		for (const stage of stages) {
			tail = this.#stage(graph, owner, stage, tail, pathFor);
		}
		return tail;
	}

	#stage(
		graph: GraphBuilder,
		owner: WorkflowLike,
		stage: Stage,
		from: string,
		pathFor: (id: string) => string
	): string {
		switch (stage.kind) {
			case "step": {
				const node = this.#stepNode(graph, stage.step, pathFor(stage.step.id));
				graph.edge(from, node);
				return node;
			}
			case "parallel": {
				const join = pathFor(stage.id);
				const tags: string[] = [];
				for (const step of stage.steps) {
					const node = this.#stepNode(graph, step, nodeId(join, step.id));
					graph.edge(from, node);
					tags.push(this.#tag(graph, join, step.id, node));
				}
				graph.add({ id: join, type: "script", code: JOIN_SCRIPT });
				for (const tag of tags) {
					graph.edge(tag, join);
				}
				return join;
			}
			case "branch": {
				const join = pathFor(stage.id);
				const tags: string[] = [];
				for (const { condition, step } of stage.branches) {
					if (!isCoreCondition(condition)) {
						throw new WorkflowCompileError(
							`.branch() "${stage.id}": the condition for "${step.id}" is a function; use when.* conditions to run on Core`
						);
					}
					const test = graph.add({
						id: nodeId(join, "if", step.id),
						type: "condition",
						expr: condition.expr,
					});
					graph.edge(from, test);
					// A condition node outputs "true"/"false"; restore the value it tested.
					const restore = graph.add({
						id: nodeId(join, "in", step.id),
						type: "transform",
						op: "template",
						template: `{{nodes.${from}}}`,
					});
					graph.edge(test, restore, "true");
					const node = this.#stepNode(graph, step, nodeId(join, step.id));
					graph.edge(restore, node);
					tags.push(this.#tag(graph, join, step.id, node));
				}
				const none = graph.add({
					id: nodeId(join, "none"),
					type: "script",
					code: NO_MATCH_SCRIPT,
				});
				graph.edge(from, none);
				tags.push(none);
				graph.add({ id: join, type: "script", code: JOIN_SCRIPT });
				for (const tag of tags) {
					graph.edge(tag, join);
				}
				return join;
			}
			case "foreach": {
				const id = pathFor(stage.id);
				const body = inlineStepBody(stage.step, `.foreach() "${stage.id}"`);
				const node = graph.add(
					{
						id,
						type: "script",
						code: foreachScript(body, stage.concurrency, stage.id),
					},
					stage.step.id
				);
				graph.edge(from, node);
				return node;
			}
			case "loop":
				return this.#loop(graph, owner, stage, from, pathFor(stage.id));
			case "map": {
				const node = graph.add(
					{ id: pathFor(stage.id), type: "script", code: stage.script },
					stage.id
				);
				graph.edge(from, node);
				return node;
			}
			case "sleep": {
				const node = graph.add(
					{ id: pathFor(stage.id), type: "delay", ms: stage.ms },
					stage.id
				);
				graph.edge(from, node);
				return node;
			}
			default:
				throw new WorkflowCompileError("unknown workflow stage");
		}
	}

	#tag(
		graph: GraphBuilder,
		join: string,
		stepId: string,
		node: string
	): string {
		const tag = graph.add({
			id: nodeId(join, "tag", stepId),
			type: "script",
			code: tagScript(stepId),
		});
		graph.edge(node, tag);
		return tag;
	}

	#loop(
		graph: GraphBuilder,
		owner: WorkflowLike,
		stage: Extract<Stage, { kind: "loop" }>,
		from: string,
		id: string
	): string {
		if (!isCoreCondition(stage.condition)) {
			throw new WorkflowCompileError(
				`.${stage.mode}() "${stage.id}": the condition is a function; use when.* conditions to run on Core`
			);
		}
		if (stage.maxIterations > MAX_CORE_LOOP_ITERATIONS) {
			throw new WorkflowCompileError(
				`.${stage.mode}() "${stage.id}": Core loops run at most ${MAX_CORE_LOOP_ITERATIONS} passes, got maxIterations ${stage.maxIterations}`
			);
		}
		const expr =
			stage.mode === "dowhile"
				? stage.condition.expr
				: negateCoreExpr(stage.condition.expr);
		const step = stage.step;
		const bodyId =
			step.kind === "workflow"
				? this.#child(step)
				: this.#loopBody(owner, id, step);
		const firstId = stage.maxIterations === 1 ? id : nodeId(id, "first");
		const first = graph.add(
			{ id: firstId, type: "sub_workflow", workflow_id: bodyId },
			step.id
		);
		graph.edge(from, first);
		if (stage.maxIterations === 1) {
			return first;
		}
		const loop = graph.add(
			{
				id,
				type: "while",
				expr,
				body_workflow_id: bodyId,
				max_iterations: stage.maxIterations - 1,
			},
			step.id
		);
		graph.edge(first, loop);
		return loop;
	}
}

/** Compile a committed workflow to Core's JSON graph. */
export function compileWorkflow(workflow: WorkflowLike): CompiledWorkflow {
	const context: CompileContext = {
		children: new Map(),
		inProgress: new Set([workflow.id]),
	};
	const { definition, stepNodes } = new Compiler(context).definition(
		workflow,
		true
	);
	return {
		workflow: definition,
		children: [...context.children.values()],
		stepNodes,
	};
}
