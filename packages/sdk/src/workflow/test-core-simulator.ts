/**
 * Test support: an in-memory model of Core's workflow executor.
 *
 * It runs a `CompiledWorkflow` with the semantics of Core's topological
 * executor (`apps/core/src/workflow/executor.rs`): Kahn traversal, fan-in that
 * joins incoming values with `\n`, `condition` nodes that prune the untaken
 * `true`/`false` edges, skip propagation through joins, `{{…}}` templates,
 * script nodes whose `args` is the parsed input and whose return value is
 * emitted verbatim (strings) or as JSON, `sub_workflow` runs fed
 * `{ input }`, and `while` loops over a body workflow with an iteration cap.
 * Script bodies run as async functions with Core's helpers (`agent`,
 * `parallel`, `pipeline`, `log`, `phase`); `agent()` and `agent` nodes call a
 * test-supplied responder.
 *
 * Tests use it to check that a compiled graph computes what the local
 * executor computes. It is not shipped from any package entry point.
 */

import { evalCoreCondition } from "./conditions.ts";
import type { CompiledWorkflow, CoreNode, CoreWorkflow } from "./core-types.ts";

/** Answers `agent` nodes and script `agent()` calls. */
export type AgentResponder = (agentId: string | null, prompt: string) => string;

interface SimRun {
	output: Record<string, string>;
	status: "completed" | "awaiting_input";
}

const MAX_WHILE_ITERATIONS = 100;

type ScriptFunction = (...args: unknown[]) => Promise<unknown>;

// Core evaluates script bodies in its Deno sandbox; the simulator needs the
// same "string body → async function" step to exercise compiled code.
const AsyncFunctionCtor = Object.getPrototypeOf(async () => undefined)
	.constructor as new (
	...params: string[]
) => ScriptFunction;

function scriptArgs(input: string): unknown {
	if (input.trim() === "") {
		return null;
	}
	try {
		return JSON.parse(input);
	} catch {
		return input;
	}
}

function scriptOutput(value: unknown): string {
	if (value === null || value === undefined) {
		return "";
	}
	if (typeof value === "string") {
		return value;
	}
	return JSON.stringify(value);
}

function resolveTemplate(
	template: string,
	input: string,
	nodes: Map<string, string>
): string {
	return template.replace(/\{\{([^}]*)\}\}/g, (_match, raw: string) => {
		const token = raw.trim();
		if (token === "input") {
			return input;
		}
		if (token.startsWith("nodes.")) {
			return nodes.get(token.slice("nodes.".length)) ?? "";
		}
		return "";
	});
}

function field(node: CoreNode, key: string): unknown {
	return (node as Record<string, unknown>)[key];
}

function stringField(node: CoreNode, key: string): string | undefined {
	const value = field(node, key);
	return typeof value === "string" ? value : undefined;
}

/** Run compiled workflows the way Core would. */
export class CoreSimulator {
	readonly #workflows = new Map<string, CoreWorkflow>();
	readonly #agent: AgentResponder;
	/** Agent prompts seen, in order. */
	readonly prompts: string[] = [];

	constructor(compiled: CompiledWorkflow, agent: AgentResponder = () => "") {
		for (const child of compiled.children) {
			this.#workflows.set(child.id, child);
		}
		this.#workflows.set(compiled.workflow.id, compiled.workflow);
		this.#agent = agent;
	}

	/** Run a workflow by id with Core's `{ input }` run input map. */
	async run(
		workflowId: string,
		input: Record<string, string>
	): Promise<SimRun> {
		const workflow = this.#workflows.get(workflowId);
		if (!workflow) {
			throw new Error(`sub-workflow '${workflowId}' not found`);
		}
		return await this.#execute(workflow, input);
	}

	#callAgent(agentId: string | null, prompt: string): string {
		this.prompts.push(prompt);
		return this.#agent(agentId, prompt);
	}

	async #script(code: string, input: string): Promise<string> {
		const agent = (prompt: string, options?: { agent_id?: string }) =>
			Promise.resolve(this.#callAgent(options?.agent_id ?? null, prompt));
		const parallel = (thunks: (() => Promise<unknown>)[]) =>
			Promise.all(thunks.map((thunk) => thunk()));
		const pipeline = (
			items: unknown[],
			...stages: ((v: unknown) => unknown)[]
		) =>
			Promise.all(
				items.map(async (item) => {
					let value = item;
					for (const stage of stages) {
						value = await stage(value);
					}
					return value;
				})
			);
		const noop = () => undefined;
		const fn = new AsyncFunctionCtor(
			"args",
			"agent",
			"parallel",
			"pipeline",
			"log",
			"phase",
			code
		);
		const result = await fn(
			scriptArgs(input),
			agent,
			parallel,
			pipeline,
			noop,
			noop
		);
		return scriptOutput(result);
	}

	async #node(
		node: CoreNode,
		input: string,
		nodes: Map<string, string>
	): Promise<string> {
		switch (node.type) {
			case "input":
			case "output":
			case "delay":
				return input;
			case "transform":
				return resolveTemplate(
					stringField(node, "template") ?? "",
					input,
					nodes
				);
			case "condition":
				return String(
					evalCoreCondition(stringField(node, "expr") ?? "", input)
				);
			case "script":
				return await this.#script(stringField(node, "code") ?? "", input);
			case "agent": {
				const task = stringField(node, "task") ?? "{{input}}";
				return this.#callAgent(
					stringField(node, "agent_id") ?? null,
					resolveTemplate(task, input, nodes)
				);
			}
			case "sub_workflow": {
				const child = await this.run(stringField(node, "workflow_id") ?? "", {
					input,
				});
				return Object.values(child.output)[0] ?? "";
			}
			case "while":
				return await this.#while(node, input);
			default:
				throw new Error(`simulator does not model node type ${node.type}`);
		}
	}

	async #while(node: CoreNode, input: string): Promise<string> {
		const configured = field(node, "max_iterations");
		const cap =
			typeof configured === "number" && configured > 0
				? Math.min(configured, MAX_WHILE_ITERATIONS)
				: MAX_WHILE_ITERATIONS;
		const body = stringField(node, "body_workflow_id") ?? "";
		const expr = stringField(node, "expr") ?? "";
		let carry = input;
		let counter = 0;
		while (evalCoreCondition(expr, carry) && counter < cap) {
			counter += 1;
			const result = await this.run(body, { input: carry });
			carry = Object.values(result.output)[0] ?? "";
		}
		return carry;
	}

	async #execute(
		workflow: CoreWorkflow,
		input: Record<string, string>
	): Promise<SimRun> {
		const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
		const indegree = new Map<string, number>();
		for (const node of workflow.nodes) {
			indegree.set(node.id, 0);
		}
		for (const edge of workflow.edges) {
			if (!(byId.has(edge.from) && byId.has(edge.to))) {
				throw new Error(
					`edge references unknown node id: ${edge.from} → ${edge.to}`
				);
			}
			indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
		}
		const active = new Set(workflow.edges.map((_edge, index) => index));
		const values = new Map<string, string>();
		const skipped = new Set<string>();
		const queue = workflow.nodes
			.filter((node) => indegree.get(node.id) === 0)
			.map((node) => node.id);
		const resolveSuccessors = (id: string, wasSkipped: boolean) => {
			workflow.edges.forEach((edge, index) => {
				if (edge.from !== id) {
					return;
				}
				if (wasSkipped) {
					active.delete(index);
				}
				const remaining = Math.max(0, (indegree.get(edge.to) ?? 0) - 1);
				indegree.set(edge.to, remaining);
				if (remaining !== 0) {
					return;
				}
				const live = workflow.edges.some(
					(other, otherIndex) => other.to === edge.to && active.has(otherIndex)
				);
				if (!live) {
					skipped.add(edge.to);
				}
				queue.push(edge.to);
			});
		};
		while (queue.length > 0) {
			const id = queue.shift() ?? "";
			const node = byId.get(id);
			if (!node) {
				continue;
			}
			if (skipped.has(id)) {
				resolveSuccessors(id, true);
				continue;
			}
			const incoming = workflow.edges
				.map((edge, index) => ({ edge, index }))
				.filter(({ edge, index }) => edge.to === id && active.has(index))
				.map(({ edge }) => values.get(edge.from))
				.filter((value): value is string => value !== undefined);
			let nodeInput: string;
			if (incoming.length > 0) {
				nodeInput = incoming.join("\n");
			} else {
				const key = stringField(node, "key") ?? node.id;
				nodeInput =
					node.type === "input" ? (input[key] ?? "") : (input[node.id] ?? "");
			}
			if (node.type === "awakeable") {
				return { status: "awaiting_input", output: {} };
			}
			const produced = await this.#node(node, nodeInput, values);
			values.set(id, produced);
			if (node.type === "condition") {
				workflow.edges.forEach((edge, index) => {
					if (edge.from === id && edge.branch && edge.branch !== produced) {
						active.delete(index);
					}
				});
			}
			resolveSuccessors(id, false);
		}
		const output: Record<string, string> = {};
		for (const node of workflow.nodes) {
			const value = values.get(node.id);
			if (node.type === "output" && value !== undefined) {
				output[stringField(node, "key") ?? node.id] = value;
			}
		}
		return { status: "completed", output };
	}
}
