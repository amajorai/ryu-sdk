/**
 * Compiled graphs ↔ Core's serde shape.
 *
 * Reads Core's workflow definition types straight from
 * `apps/core/src/workflow/mod.rs` (`NodeKind`, `WorkflowNode`,
 * `WorkflowEdge`, `Workflow`, `RetryPolicy`) and checks that every node the
 * DSL compiler emits deserializes there: its `type` tag names a `NodeKind`
 * variant, every field it sets exists on that variant, and every field serde
 * requires is present. It also re-checks what `WorkflowGraph::build` enforces
 * (unique ids, known edge endpoints, acyclic). A Core-side rename or a new
 * required field fails this suite instead of failing a deploy.
 *
 * Deterministic, filesystem-only, no network.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	agentStep,
	type CompiledWorkflow,
	type CoreWorkflow,
	createStep,
	createWorkflow,
	humanStep,
	mcpStep,
	nodeStep,
	toolStep,
	when,
} from "./index.ts";

const MOD_RS = join(
	import.meta.dir,
	"../../../../apps/core/src/workflow/mod.rs"
);
const source = readFileSync(MOD_RS, "utf8");

interface RustField {
	name: string;
	required: boolean;
}

/** The body of `pub <kind> <name> { … }` at column 0. */
function block(kind: "enum" | "struct", name: string): string {
	const start = source.indexOf(`pub ${kind} ${name} {`);
	if (start < 0) {
		throw new Error(`mod.rs no longer defines ${kind} ${name}`);
	}
	const end = source.indexOf("\n}\n", start);
	return source.slice(source.indexOf("{", start) + 1, end);
}

/** Parse `pub? name: Type,` fields with their serde attributes. */
function fields(body: string, indent: string): RustField[] {
	const out: RustField[] = [];
	let hasDefault = false;
	for (const line of body.split("\n")) {
		if (!line.startsWith(indent) || line.startsWith(`${indent} `)) {
			continue;
		}
		const text = line.trim();
		if (text.startsWith("#[serde(") && text.includes("default")) {
			hasDefault = true;
			continue;
		}
		const field = /^(?:pub\s+)?(r#)?([a-z_][a-z0-9_]*)\s*:\s*(.+),$/.exec(text);
		if (field?.[2] && field[3]) {
			const isOption = field[3].startsWith("Option<");
			out.push({ name: field[2], required: !(hasDefault || isOption) });
			hasDefault = false;
		} else if (!(text.startsWith("///") || text.startsWith("#["))) {
			hasDefault = false;
		}
	}
	return out;
}

function snakeCase(name: string): string {
	return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** `NodeKind` variants (snake_case tag) → their fields. */
function nodeKindVariants(): Map<string, RustField[]> {
	const body = block("enum", "NodeKind");
	const variants = new Map<string, RustField[]>();
	const pattern = /^ {4}([A-Z][A-Za-z]*)\s*(\{|,)/gm;
	const starts: { index: number; name: string; struct: boolean }[] = [];
	for (const match of body.matchAll(pattern)) {
		if (match[1]) {
			starts.push({
				index: match.index ?? 0,
				name: match[1],
				struct: match[2] === "{",
			});
		}
	}
	starts.forEach((start, position) => {
		const end = starts[position + 1]?.index ?? body.length;
		const variantBody = body.slice(start.index, end);
		const firstLine = variantBody.split("\n")[0] ?? "";
		const inline = /\{(.*)\}/.exec(firstLine);
		let variantFields: RustField[] = [];
		if (inline?.[1] !== undefined) {
			// One-line form: `SubWorkflow { workflow_id: String },`.
			variantFields = inline[1]
				.split(",")
				.map((part) => part.trim())
				.filter((part) => part.length > 0)
				.map((part) => ({
					name: part.split(":")[0]?.trim() ?? "",
					required: !part.includes("Option<"),
				}));
		} else if (start.struct) {
			variantFields = fields(variantBody, "        ");
		}
		variants.set(snakeCase(start.name), variantFields);
	});
	return variants;
}

const VARIANTS = nodeKindVariants();
const NODE_FIELDS = fields(block("struct", "WorkflowNode"), "    ");
const EDGE_FIELDS = fields(block("struct", "WorkflowEdge"), "    ");
const WORKFLOW_FIELDS = fields(block("struct", "Workflow"), "    ");
const RETRY_FIELDS = fields(block("struct", "RetryPolicy"), "    ");

function names(list: RustField[]): Set<string> {
	return new Set(list.map((field) => field.name));
}

/** Every way `workflow` would fail Core's deserialization or graph build. */
function workflowProblems(workflow: CoreWorkflow): string[] {
	const problems: string[] = [];
	const workflowFields = names(WORKFLOW_FIELDS);
	for (const key of Object.keys(workflow)) {
		if (!workflowFields.has(key)) {
			problems.push(`Workflow has no field "${key}"`);
		}
	}
	const common = names(NODE_FIELDS);
	common.delete("kind");
	const retryFields = names(RETRY_FIELDS);
	const ids = new Set<string>();
	for (const node of workflow.nodes) {
		if (ids.has(node.id)) {
			problems.push(`duplicate node id ${node.id}`);
		}
		ids.add(node.id);
		// Core names child runs `<runId>-sub-<nodeId>` and script checkpoints
		// `<runId>/<nodeId>`; both go through ryu_durable::validate_id.
		if (!PATH_SAFE_ID.test(node.id)) {
			problems.push(`node id ${node.id} is not path-safe`);
		}
		const variant = VARIANTS.get(node.type);
		if (!variant) {
			problems.push(`NodeKind has no variant tagged "${node.type}"`);
			continue;
		}
		const variantFields = names(variant);
		for (const key of Object.keys(node)) {
			if (key !== "type" && !common.has(key) && !variantFields.has(key)) {
				problems.push(`NodeKind::${node.type} has no field "${key}"`);
			}
		}
		for (const field of variant) {
			if (field.required && !(field.name in node)) {
				problems.push(
					`node ${node.id} (${node.type}) misses required "${field.name}"`
				);
			}
		}
		for (const key of Object.keys(node.retry ?? {})) {
			if (!retryFields.has(key)) {
				problems.push(`RetryPolicy has no field "${key}"`);
			}
		}
	}
	const edgeFields = names(EDGE_FIELDS);
	const outgoing = new Map<string, string[]>();
	for (const edge of workflow.edges) {
		for (const key of Object.keys(edge)) {
			if (!edgeFields.has(key)) {
				problems.push(`WorkflowEdge has no field "${key}"`);
			}
		}
		for (const end of [edge.from, edge.to]) {
			if (!ids.has(end)) {
				problems.push(`edge references unknown node id: ${end}`);
			}
		}
		outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
	}
	// Acyclic: depth-first search with a recursion stack.
	const state = new Map<string, "open" | "done">();
	const visit = (id: string): void => {
		state.set(id, "open");
		for (const next of outgoing.get(id) ?? []) {
			if (state.get(next) === "open") {
				problems.push(`cycle through ${id} → ${next}`);
			} else if (!state.has(next)) {
				visit(next);
			}
		}
		state.set(id, "done");
	};
	for (const id of ids) {
		if (!state.has(id)) {
			visit(id);
		}
	}
	return problems;
}

const PATH_SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Problems across a compiled bundle, including dangling workflow references. */
function compiledProblems(compiled: CompiledWorkflow): string[] {
	const all = [compiled.workflow, ...compiled.children];
	const problems = all.flatMap(workflowProblems);
	const known = new Set(all.map((workflow) => workflow.id));
	for (const workflow of all) {
		for (const node of workflow.nodes) {
			for (const key of ["workflow_id", "body_workflow_id"] as const) {
				const value = (node as Record<string, unknown>)[key];
				if (typeof value === "string" && !known.has(value)) {
					problems.push(`${node.id} references unknown workflow ${value}`);
				}
			}
		}
	}
	return problems;
}

describe("compiled workflows match Core's serde shape", () => {
	test("the Rust parser sees the variants the compiler emits", () => {
		for (const tag of [
			"input",
			"output",
			"agent",
			"tool",
			"mcp",
			"script",
			"condition",
			"transform",
			"sub_workflow",
			"while",
			"awakeable",
			"delay",
			"skill",
		]) {
			expect(VARIANTS.has(tag), `NodeKind::${tag}`).toBe(true);
		}
		expect(VARIANTS.get("agent")).toEqual([
			{ name: "agent_id", required: true },
			{ name: "task", required: false },
		]);
		expect(VARIANTS.get("sub_workflow")).toEqual([
			{ name: "workflow_id", required: true },
		]);
		expect(VARIANTS.get("while")).toEqual([
			{ name: "expr", required: true },
			{ name: "body_workflow_id", required: false },
			{ name: "max_iterations", required: false },
		]);
		expect(VARIANTS.get("script")?.find((f) => f.name === "code")).toEqual({
			name: "code",
			required: true,
		});
		expect(names(NODE_FIELDS)).toEqual(
			new Set(["id", "kind", "retry", "timeout_ms", "repeat"])
		);
	});

	test("every stage kind compiles to nodes Core deserializes", () => {
		const code = createStep({
			id: "code",
			retry: {
				maxAttempts: 2,
				initialIntervalMs: 10,
				backoffCoefficient: 3,
				maxIntervalMs: 100,
				nonRetryableErrors: ["fatal"],
			},
			timeoutMs: 500,
			execute: ({ inputData }) => inputData,
		});
		const inner = createWorkflow({ id: "contract-inner" }).then(code).commit();
		const wf = createWorkflow({
			id: "contract",
			description: "every stage",
			triggers: [{ type: "schedule", cron: "0 9 * * *" }],
		})
			.then(code)
			.then(agentStep({ id: "agent", agentId: "a1" }))
			.then(toolStep({ id: "tool", tool: "srv.do", args: { x: 1 } }))
			.then(mcpStep({ id: "mcp", server: "srv", tool: "do" }))
			.then(humanStep({ id: "gate" }))
			.then(nodeStep({ id: "skill", node: { type: "skill", skill: "s" } }))
			.parallel([code, inner])
			.branch([
				[when.nonEmpty(), code],
				[when.equals("x"), inner],
			])
			.foreach(code, { concurrency: 2 })
			.dowhile(code, when.lt(3))
			.dountil(inner, when.equals("done"))
			.map(({ inputData }) => inputData)
			.sleep(10)
			.commit();
		const compiled = wf.toCore();
		expect(compiledProblems(compiled)).toEqual([]);
		const types = new Set(
			[compiled.workflow, ...compiled.children].flatMap((workflow) =>
				workflow.nodes.map((node) => node.type)
			)
		);
		expect([...types].sort()).toEqual(
			[
				"agent",
				"awakeable",
				"condition",
				"delay",
				"input",
				"mcp",
				"output",
				"script",
				"skill",
				"sub_workflow",
				"tool",
				"transform",
				"while",
			].sort()
		);
	});

	test("the checker catches what Core would reject", () => {
		const broken: CompiledWorkflow = {
			stepNodes: {},
			children: [],
			workflow: {
				id: "broken",
				name: "broken",
				nodes: [
					{ id: "a", type: "sub_workflow" },
					{ id: "b", type: "agent", agent_id: "x", persona: "nope" },
					{ id: "c", type: "teleport" },
					{ id: "a", type: "input" },
					{ id: "d.e", type: "input" },
				],
				edges: [
					{ from: "a", to: "b" },
					{ from: "b", to: "a" },
					{ from: "b", to: "ghost" },
				],
			},
		};
		expect(compiledProblems(broken)).toEqual([
			'node a (sub_workflow) misses required "workflow_id"',
			'NodeKind::agent has no field "persona"',
			'NodeKind has no variant tagged "teleport"',
			"duplicate node id a",
			"node id d.e is not path-safe",
			"edge references unknown node id: ghost",
			"cycle through b → a",
		]);
	});
});
