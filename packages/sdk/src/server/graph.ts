/**
 * A display graph of a workflow's program, for the studio's step view and the
 * `GET /workflows/:id` route.
 *
 * Top-level stages become nodes joined in order. Control-flow stages
 * (`parallel`, `branch`, `foreach`, `loop`) carry their inner steps as
 * `children`, so the studio can draw them as groups. Node ids are step ids, so
 * the `stepId` on a run's `step-*` events maps straight onto the graph.
 */

import type { AnyStepLike, Stage, WorkflowLike } from "../workflow/workflow.ts";

/** What a graph node stands for. */
export type WorkflowGraphNodeKind =
	| "branch"
	| "foreach"
	| "loop"
	| "map"
	| "parallel"
	| "sleep"
	| "step"
	| "workflow";

/** One node of a workflow graph. */
export interface WorkflowGraphNode {
	children?: WorkflowGraphNode[];
	description?: string;
	id: string;
	kind: WorkflowGraphNodeKind;
	label: string;
}

/** A directed edge between two top-level nodes. */
export interface WorkflowGraphEdge {
	from: string;
	to: string;
}

/** The display graph of a workflow. */
export interface WorkflowGraph {
	edges: WorkflowGraphEdge[];
	nodes: WorkflowGraphNode[];
}

function stepNode(step: AnyStepLike): WorkflowGraphNode {
	const node: WorkflowGraphNode = {
		id: step.id,
		kind: step.kind === "workflow" ? "workflow" : "step",
		label: step.kind === "workflow" ? step.name : step.id,
	};
	if (step.description) {
		node.description = step.description;
	}
	if (step.kind === "workflow") {
		node.children = workflowGraph(step).nodes;
	}
	return node;
}

function stageNode(stage: Stage): WorkflowGraphNode {
	switch (stage.kind) {
		case "step":
			return stepNode(stage.step);
		case "parallel":
			return {
				id: stage.id,
				kind: "parallel",
				label: "parallel",
				children: stage.steps.map(stepNode),
			};
		case "branch":
			return {
				id: stage.id,
				kind: "branch",
				label: "branch",
				children: stage.branches.map((branch) => stepNode(branch.step)),
			};
		case "foreach":
			return {
				id: stage.id,
				kind: "foreach",
				label: `foreach (concurrency ${stage.concurrency})`,
				children: [stepNode(stage.step)],
			};
		case "loop":
			return {
				id: stage.id,
				kind: "loop",
				label: `${stage.mode} (max ${stage.maxIterations})`,
				children: [stepNode(stage.step)],
			};
		case "map":
			return { id: stage.id, kind: "map", label: "map" };
		case "sleep":
			return { id: stage.id, kind: "sleep", label: `sleep ${stage.ms}ms` };
		default:
			return stage satisfies never;
	}
}

/** Build the display graph of `workflow`. */
export function workflowGraph(workflow: WorkflowLike): WorkflowGraph {
	const nodes = workflow.stages.map(stageNode);
	const edges: WorkflowGraphEdge[] = [];
	for (let index = 1; index < nodes.length; index++) {
		const from = nodes[index - 1];
		const to = nodes[index];
		if (from && to) {
			edges.push({ from: from.id, to: to.id });
		}
	}
	return { nodes, edges };
}
