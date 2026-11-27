/**
 * Steps backed by a dedicated Core node kind: agents, tools, MCP tools, human
 * gates, and raw nodes. Each compiles to that node on Core and runs through a
 * local implementation (an SDK `Agent`, a tool function, or `suspend()`) in the
 * local executor.
 */

import type { Runnable } from "../runnable/runnable-types.ts";
import { coreText } from "./conditions.ts";
import type { CoreJson, CoreNodeKind, CoreRawNodeKind } from "./core-types.ts";
import type { StandardSchemaV1 } from "./schema.ts";
import type { Step, StepCommonOptions, StepExecuteContext } from "./step.ts";

/**
 * Resolve Core's template grammar locally: `{{input}}`, `{{nodes.<stepId>}}`,
 * and `{{state.<key>}}`. Values render as Core text (strings verbatim, other
 * values as JSON); unknown tokens render empty, as on Core.
 */
export function renderTemplate(
	template: string,
	context: Pick<
		StepExecuteContext<unknown>,
		"inputData" | "getStepResult" | "state"
	>
): string {
	return template.replace(/\{\{([^}]*)\}\}/g, (_match, raw: string) => {
		const token = raw.trim();
		if (token === "input") {
			return coreText(context.inputData);
		}
		if (token.startsWith("nodes.")) {
			return coreText(context.getStepResult(token.slice("nodes.".length)));
		}
		if (token.startsWith("state.")) {
			return coreText(context.state[token.slice("state.".length)]);
		}
		return "";
	});
}

function resolveArgs(
	value: CoreJson,
	context: Pick<
		StepExecuteContext<unknown>,
		"inputData" | "getStepResult" | "state"
	>
): CoreJson {
	if (typeof value === "string") {
		return renderTemplate(value, context);
	}
	if (Array.isArray(value)) {
		return value.map((item) => resolveArgs(item, context));
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, CoreJson> = {};
		for (const [key, item] of Object.entries(value)) {
			out[key] = resolveArgs(item, context);
		}
		return out;
	}
	return value;
}

/**
 * The arguments a Core tool node sends: `args` (templates resolved) with the
 * step input folded in as `input` unless `args` already sets it.
 */
export function toolCallArgs(
	args: CoreJson | undefined,
	context: Pick<
		StepExecuteContext<unknown>,
		"inputData" | "getStepResult" | "state"
	>
): Record<string, CoreJson> {
	let resolved: Record<string, CoreJson>;
	if (args === undefined || args === null) {
		resolved = {};
	} else if (typeof args === "object" && !Array.isArray(args)) {
		const value = resolveArgs(args, context);
		resolved =
			value !== null && typeof value === "object" && !Array.isArray(value)
				? value
				: {};
	} else {
		resolved = { args: resolveArgs(args, context) };
	}
	if (!("input" in resolved)) {
		resolved.input = coreText(context.inputData);
	}
	return resolved;
}

/** Something that can answer a prompt locally: an SDK `Agent` or a Runnable. */
export type LocalAgent =
	| {
			generate(prompt: string, signal?: AbortSignal): Promise<{ text: string }>;
	  }
	| Runnable<string, unknown>;

/** Options for {@link agentStep}. */
export interface AgentStepOptions<TId extends string, TInput>
	extends StepCommonOptions<TId> {
	/** Local implementation used by the in-process executor. */
	agent?: LocalAgent;
	/** The configured Core agent id the step runs. */
	agentId: string;
	inputSchema?: StandardSchemaV1<unknown, TInput>;
	/**
	 * Task template; `{{input}}`, `{{nodes.<stepId>}}`, and `{{state.<key>}}`
	 * are resolved before the run. Absent = the step input is the task.
	 */
	task?: string;
}

/**
 * A step that hands its input to a configured agent and outputs the agent's
 * final text. Compiles to a Core `agent` node.
 */
export function agentStep<TId extends string, TInput = unknown>(
	options: AgentStepOptions<TId, TInput>
): Step<TId, TInput, string> {
	const node: CoreNodeKind = {
		type: "agent",
		agent_id: options.agentId,
		task: options.task ?? null,
	};
	return {
		kind: "step",
		id: options.id,
		description: options.description,
		inputSchema: options.inputSchema,
		retry: options.retry,
		timeoutMs: options.timeoutMs,
		core: { kind: "node", node },
		async execute(context) {
			const local = options.agent;
			if (!local) {
				throw new Error(
					`agent step "${options.id}" has no local agent; pass \`agent\` to run it in-process or run the workflow on Core`
				);
			}
			const prompt = options.task
				? renderTemplate(options.task, context)
				: coreText(context.inputData);
			if ("generate" in local) {
				const result = await local.generate(prompt, context.signal);
				return result.text;
			}
			if (!context.runtime) {
				throw new Error(
					`agent step "${options.id}" runs a Runnable and needs \`runtime\` in createRun()`
				);
			}
			return coreText(await local.run(prompt, context.runtime));
		},
	};
}

/** A local tool implementation: a function or a `defineTool` Runnable. */
export type LocalToolCall =
	| ((args: Record<string, CoreJson>, signal: AbortSignal) => unknown)
	| Runnable<Record<string, CoreJson>, unknown>;

/** Options shared by {@link toolStep} and {@link mcpStep}. */
interface ToolLikeOptions<TId extends string, TInput>
	extends StepCommonOptions<TId> {
	/**
	 * Tool arguments. String leaves are templates (`{{input}}`,
	 * `{{nodes.<stepId>}}`, `{{state.<key>}}`). The step input is added as
	 * `input` unless set here.
	 */
	args?: CoreJson;
	/** Local implementation used by the in-process executor. */
	call?: LocalToolCall;
	inputSchema?: StandardSchemaV1<unknown, TInput>;
}

/** Options for {@link toolStep}. */
export interface ToolStepOptions<TId extends string, TInput>
	extends ToolLikeOptions<TId, TInput> {
	/** Fully-qualified Core tool id, `<server>.<tool>`. */
	tool: string;
}

/** Options for {@link mcpStep}. */
export interface McpStepOptions<TId extends string, TInput>
	extends ToolLikeOptions<TId, TInput> {
	/** MCP server name. */
	server: string;
	/** Tool name on that server. */
	tool: string;
}

function toolExecutor<TId extends string, TInput>(
	options: ToolLikeOptions<TId, TInput>,
	label: string
): Step<TId, TInput, unknown>["execute"] {
	return async (context) => {
		const call = options.call;
		if (!call) {
			throw new Error(
				`${label} step "${options.id}" has no local implementation; pass \`call\` to run it in-process or run the workflow on Core`
			);
		}
		const args = toolCallArgs(options.args, context);
		if (typeof call === "function") {
			return await call(args, context.signal);
		}
		if (!context.runtime) {
			throw new Error(
				`${label} step "${options.id}" runs a Runnable and needs \`runtime\` in createRun()`
			);
		}
		return await call.run(args, context.runtime);
	};
}

/** A step that calls a Core tool by id. Compiles to a Core `tool` node. */
export function toolStep<TId extends string, TInput = unknown>(
	options: ToolStepOptions<TId, TInput>
): Step<TId, TInput, unknown> {
	if (!options.tool.includes(".")) {
		throw new Error(
			`tool step "${options.id}": tool must be "<server>.<tool>", got "${options.tool}"`
		);
	}
	const node: CoreNodeKind = {
		type: "tool",
		name: options.tool,
		args: options.args ?? null,
	};
	return {
		kind: "step",
		id: options.id,
		description: options.description,
		inputSchema: options.inputSchema,
		retry: options.retry,
		timeoutMs: options.timeoutMs,
		core: { kind: "node", node },
		execute: toolExecutor(options, "tool"),
	};
}

/** A step that calls one tool on a named MCP server. Compiles to `mcp`. */
export function mcpStep<TId extends string, TInput = unknown>(
	options: McpStepOptions<TId, TInput>
): Step<TId, TInput, unknown> {
	const node: CoreNodeKind = {
		type: "mcp",
		server: options.server,
		tool: options.tool,
		args: options.args ?? null,
	};
	return {
		kind: "step",
		id: options.id,
		description: options.description,
		inputSchema: options.inputSchema,
		retry: options.retry,
		timeoutMs: options.timeoutMs,
		core: { kind: "node", node },
		execute: toolExecutor(options, "mcp"),
	};
}

/** Options for {@link humanStep}. */
export interface HumanStepOptions<TId extends string, TResume>
	extends Omit<StepCommonOptions<TId>, "retry"> {
	/** What the reviewer is asked; sent as the suspend payload. */
	prompt?: string;
	/** Validates the reviewer's answer. */
	resumeSchema?: StandardSchemaV1<unknown, TResume>;
}

/**
 * A human-in-the-loop gate. The run suspends here with `{ prompt }`; the value
 * passed to `resume({ resumeData })` becomes the step output. Compiles to a
 * Core `awakeable` node, resumed through `POST /workflows/runs/:id/resume`.
 */
export function humanStep<TId extends string, TResume = unknown>(
	options: HumanStepOptions<TId, TResume>
): Step<TId, unknown, TResume, TResume, { prompt: string | null }> {
	const node: CoreNodeKind = {
		type: "awakeable",
		prompt: options.prompt ?? null,
	};
	return {
		kind: "step",
		id: options.id,
		description: options.description,
		resumeSchema: options.resumeSchema,
		timeoutMs: options.timeoutMs,
		core: { kind: "node", node },
		async execute(context) {
			if (context.resumeData !== undefined) {
				return context.resumeData;
			}
			return await context.suspend({ prompt: options.prompt ?? null });
		},
	};
}

/** Options for {@link nodeStep}. */
export interface NodeStepOptions<TId extends string, TInput, TOutput>
	extends StepCommonOptions<TId> {
	/** Local implementation; absent = the step only runs on Core. */
	execute?: Step<TId, TInput, TOutput>["execute"];
	inputSchema?: StandardSchemaV1<unknown, TInput>;
	/** The Core node kind, e.g. `{ type: "skill", skill: "summarize" }`. */
	node: CoreNodeKind | CoreRawNodeKind;
	outputSchema?: StandardSchemaV1<unknown, TOutput>;
}

/** A step that compiles to any Core node kind (escape hatch). */
export function nodeStep<
	TId extends string,
	TInput = unknown,
	TOutput = unknown,
>(options: NodeStepOptions<TId, TInput, TOutput>): Step<TId, TInput, TOutput> {
	const local = options.execute;
	return {
		kind: "step",
		id: options.id,
		description: options.description,
		inputSchema: options.inputSchema,
		outputSchema: options.outputSchema,
		retry: options.retry,
		timeoutMs: options.timeoutMs,
		core: { kind: "node", node: options.node },
		async execute(context) {
			if (!local) {
				throw new Error(
					`step "${options.id}" (${options.node.type}) only runs on Core; pass \`execute\` to run it in-process`
				);
			}
			return await local(context);
		},
	};
}
