/**
 * The Core workflow wire format the DSL compiles to.
 *
 * These types mirror the serde shape of Core's workflow definition
 * (`Workflow`, `WorkflowNode`, `NodeKind`, `WorkflowEdge`, `RetryPolicy`): a
 * node is `{ id, type, ...kind fields, retry?, timeout_ms?, repeat? }` with the
 * kind flattened onto the node and tagged by a snake_case `type`. Only the node
 * kinds the compiler emits are modelled field-by-field; `CoreRawNode` is the
 * escape hatch for any other kind. `core-contract.test.ts` checks every field
 * here against the Rust definition so the two cannot drift.
 */

/** JSON value accepted inside node `args`. */
export type CoreJson =
	| string
	| number
	| boolean
	| null
	| CoreJson[]
	| { [key: string]: CoreJson };

/** Core's per-node retry policy (snake_case, every field optional). */
export interface CoreRetryPolicy {
	backoff_coefficient?: number;
	initial_interval_ms?: number;
	jitter_fraction?: number;
	max_attempts?: number;
	max_interval_ms?: number;
	non_retryable_errors?: string[];
}

/** Fields every compiled node carries next to its kind. */
export interface CoreNodeCommon {
	id: string;
	retry?: CoreRetryPolicy;
	timeout_ms?: number;
}

/** The node kinds the DSL compiler emits, keyed by their `type` tag. */
export type CoreNodeKind =
	| { type: "input"; key?: string | null }
	| { type: "output"; key?: string | null }
	| { type: "agent"; agent_id: string; task?: string | null }
	| { type: "tool"; name: string; args?: CoreJson }
	| { type: "mcp"; server: string; tool: string; args?: CoreJson }
	| {
			type: "script";
			code: string;
			agent_id?: string | null;
			preset?: "research" | "code_read" | "code_write" | "summarise" | null;
	  }
	| { type: "condition"; expr: string }
	| { type: "transform"; op: string; template?: string | null }
	| { type: "sub_workflow"; workflow_id: string }
	| {
			type: "while";
			expr: string;
			body_workflow_id?: string | null;
			max_iterations?: number | null;
	  }
	| { type: "awakeable"; prompt?: string | null }
	| { type: "delay"; ms: number }
	| { type: "prompt"; prompt: string; agent_id?: string | null };

/** Any other Core node kind, passed through verbatim (escape hatch). */
export interface CoreRawNodeKind {
	type: string;
	[field: string]: CoreJson | undefined;
}

/** A compiled node: common fields plus its flattened kind. */
export type CoreNode = CoreNodeCommon & (CoreNodeKind | CoreRawNodeKind);

/** A directed edge; `branch` gates it on a `condition` node's `true`/`false`. */
export interface CoreEdge {
	branch?: string;
	from: string;
	to: string;
}

/** Core's trigger declaration (`WorkflowTrigger`, tagged by `type`). */
export type CoreTrigger =
	| { type: "manual" }
	| {
			type: "schedule";
			cron?: string | null;
			every?: string | null;
			require_approval?: boolean;
	  }
	| { type: "webhook"; secret?: string | null }
	| {
			type: "composio";
			toolkit: string;
			trigger_slug: string;
			connected_account_id?: string | null;
	  }
	| { type: "event"; event: string };

/** A complete Core workflow definition, ready for `POST /workflows`. */
export interface CoreWorkflow {
	description?: string | null;
	edges: CoreEdge[];
	id: string;
	name: string;
	nodes: CoreNode[];
	triggers?: CoreTrigger[];
}

/**
 * The output of compiling a DSL workflow: the primary definition plus every
 * workflow it references by id (nested workflows and loop bodies). Deploy the
 * `children` before `workflow`; Core resolves `sub_workflow` and `while` bodies
 * by id at run time.
 */
export interface CompiledWorkflow {
	children: CoreWorkflow[];
	/** Core node id → the DSL step id it runs, for mapping run state to steps. */
	stepNodes: Record<string, string>;
	workflow: CoreWorkflow;
}

/** The run-input key the compiled `input` node reads. */
export const CORE_INPUT_KEY = "input";
/** The run-output key the compiled `output` node writes. */
export const CORE_OUTPUT_KEY = "output";

/** Default bound on `.dowhile` / `.dountil` passes. */
export const DEFAULT_LOOP_ITERATIONS = 100;
/** One first pass plus Core's `while` cap of 100 iterations. */
export const MAX_CORE_LOOP_ITERATIONS = 101;
