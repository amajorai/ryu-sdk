/**
 * Multi-agent primitives for the SDK-owned agent loop.
 *
 * Three composition styles share one runner:
 *
 *  - **Agents as tools** (`agent.asTool()`): the calling agent stays in charge
 *    and receives the other agent's answer as a tool result.
 *  - **Handoffs** (`handoff(target)`): the active agent transfers the whole
 *    conversation to another agent inside the same run. The transcript carries
 *    over; the target's own instructions and tools take effect.
 *  - **Networks** (`AgentNetwork`, `createSupervisor`): a set of agents that
 *    route between each other with handoffs until one of them answers without
 *    handing off, bounded by a cap on agent activations. A supervisor network
 *    returns control to the supervisor after every member turn.
 *
 * Handoffs are implemented as outermost middleware on each activation: the
 * handoff tool call is answered without executing anything, the next model
 * round is short-circuited so the loop ends, and the captured transcript seeds
 * the target agent. Every model call still goes through the Gateway and every
 * remote tool still runs through Core.
 */

import { z } from "zod";
import type { RunnableContext } from "../runnable/runnable-types.ts";
import type { ToolInput, ToolRunnable, ToolSchema } from "../runnable/tool.ts";
import {
	Agent,
	type AgentConfig,
	type AgentRunOptions,
	type GenerateResult,
} from "./agent.ts";
import type {
	AgentEvent,
	AgentEventApprovalRequested,
	AgentEventAuthRequired,
	AgentEventResult,
	AgentEventToolResult,
} from "./loop.ts";
import type { AgentMiddleware } from "./middleware.ts";
import type { LoopMessage, ModelUsage } from "./model-call.ts";
import type { AgentTool } from "./tools.ts";

const DEFAULT_NETWORK_MAX_STEPS = 10;
const HANDOFF_FINISH_REASON = "handoff";
const PROMPT_INPUT_SCHEMA: ToolSchema = {
	type: "object",
	properties: {
		prompt: {
			type: "string",
			description:
				"The task or question for the agent, with any context it needs.",
		},
	},
	required: ["prompt"],
};
const HANDOFF_INPUT_SCHEMA: ToolSchema = {
	type: "object",
	properties: {
		reason: {
			type: "string",
			description: "Why the conversation is being handed over.",
		},
	},
};
const IN_PROCESS_ONLY_CODE =
	'throw new Error("multi-agent tools run in the SDK process and cannot ship as inline_js");';
const reasonInputSchema = z.object({ reason: z.string().optional() });
const promptInputSchema = z.object({ prompt: z.string().min(1) });
const toolInputRecordSchema = z.record(z.string(), z.unknown());

// ── Events ────────────────────────────────────────────────────────────────────

/** The active agent handed the conversation to another agent. */
export interface AgentEventHandoff {
	/** Name of the agent that handed off. */
	from: string;
	/** Optional reason the model gave in the handoff call. */
	reason?: string;
	/** Name of the agent that now owns the conversation. */
	to: string;
	type: "handoff";
}

/** The terminal event of a network run. */
export interface NetworkEventResult extends AgentEventResult {
	/** Agent activations used (the network's `maxSteps` bounds this). */
	activations: number;
	/** Name of the agent that produced the final answer. */
	agent: string;
	/** True when the activation cap ended the run before an agent answered. */
	maxStepsReached: boolean;
	/** The shared transcript, without system messages, at the end of the run. */
	messages: LoopMessage[];
}

/** A network event: every agent event is tagged with the active agent's name. */
export type NetworkEvent =
	| ((Exclude<AgentEvent, AgentEventResult> | AgentEventHandoff) & {
			agent: string;
	  })
	| NetworkEventResult;

/** Result of `AgentNetwork.generate()`. */
export interface NetworkResult {
	activations: number;
	/** Name of the agent that produced the final answer. */
	agent: string;
	/** Present when a member paused for human approval. */
	approvalRequired?: AgentEventApprovalRequested;
	/** Present when a member paused for an account connection. */
	authRequired?: AgentEventAuthRequired;
	maxStepsReached: boolean;
	messages: LoopMessage[];
	output?: unknown;
	steps: number;
	text: string;
	usage?: ModelUsage;
}

// ── Agents as tools ───────────────────────────────────────────────────────────

/** Options for `agent.asTool()`. */
export interface AgentAsToolOptions {
	/** What the calling model is told the tool does. Defaults to the agent's description. */
	description?: string;
	/** Stable tool id. Defaults to `agent-<name>`. */
	id?: string;
	/**
	 * JSON Schema for the tool arguments. The default is `{ prompt: string }`
	 * and the prompt is passed through as the agent's task; with a custom
	 * schema the arguments are sent to the agent as JSON.
	 */
	inputSchema?: ToolSchema;
	/** Ask the calling agent's approval handler before delegating. */
	needsApproval?: boolean;
}

/** A local tool that runs another agent (or network) in-process. */
export type AgentToolRunnable = ToolRunnable<ToolInput, unknown>;

/** Anything that can answer a prompt with a `generate()`-shaped result. */
interface Delegate {
	readonly description?: string;
	generate(
		prompt: string,
		signal?: AbortSignal
	): Promise<
		Pick<
			GenerateResult,
			"approvalRequired" | "authRequired" | "output" | "text"
		>
	>;
	readonly name: string;
}

function slug(name: string): string {
	const cleaned = name
		.trim()
		.toLowerCase()
		.replaceAll(/[^a-z0-9_-]+/g, "_")
		.replaceAll(/^_+|_+$/g, "");
	return cleaned === "" ? "agent" : cleaned.slice(0, 48);
}

function delegatePrompt(
	input: ToolInput,
	custom: boolean,
	name: string
): string {
	if (custom) {
		return JSON.stringify(input);
	}
	const parsed = promptInputSchema.safeParse(input);
	if (!parsed.success) {
		throw new Error(
			`[ryu-sdk] agent tool "${name}" needs a non-empty "prompt" string`
		);
	}
	return parsed.data.prompt;
}

function checkRequired(input: ToolInput, schema: ToolSchema, name: string) {
	for (const key of schema.required ?? []) {
		if (!(key in input)) {
			throw new Error(
				`[ryu-sdk] agent tool "${name}" input missing required field "${key}"`
			);
		}
	}
}

/** Build a tool that delegates a task to `delegate` and returns its answer. */
export function delegateTool(
	delegate: Delegate,
	options: AgentAsToolOptions = {}
): AgentToolRunnable {
	const schema = options.inputSchema ?? PROMPT_INPUT_SCHEMA;
	const custom = options.inputSchema !== undefined;
	const tool: AgentToolRunnable = {
		id: options.id ?? `agent-${slug(delegate.name)}`,
		name: delegate.name,
		kind: "tool",
		schema,
		description:
			options.description ??
			delegate.description ??
			`Delegate a task to the ${delegate.name} agent and get its answer.`,
		code: IN_PROCESS_ONLY_CODE,
		async run(input: ToolInput, ctx: RunnableContext) {
			const record = toolInputRecordSchema.parse(input);
			checkRequired(record, schema, delegate.name);
			const result = await delegate.generate(
				delegatePrompt(record, custom, delegate.name),
				ctx.signal
			);
			if (result.authRequired) {
				const where = result.authRequired.url
					? `: ${result.authRequired.url}`
					: "";
				throw new Error(
					`[ryu-sdk] agent "${delegate.name}" needs an account connection for ${result.authRequired.tool}${where}`
				);
			}
			if (result.approvalRequired) {
				throw new Error(
					`[ryu-sdk] agent "${delegate.name}" paused for approval: ${result.approvalRequired.summary}`
				);
			}
			return result.output ?? result.text;
		},
	};
	if (options.needsApproval !== undefined) {
		return { ...tool, needsApproval: options.needsApproval };
	}
	return tool;
}

/** `agent.asTool()` implementation. */
export function agentAsTool(
	agent: Agent,
	options: AgentAsToolOptions = {}
): AgentToolRunnable {
	return delegateTool(
		{
			name: agent.config.name,
			description: agent.config.description,
			generate: (prompt, signal) => agent.generate(prompt, signal),
		},
		options
	);
}

// ── Handoffs ──────────────────────────────────────────────────────────────────

/** Options for `handoff()`. */
export interface HandoffOptions {
	/** What the model is told about the target. Defaults to the target's description. */
	description?: string;
	/** Ask the approval handler before handing off. */
	needsApproval?: boolean;
}

/** A tool that transfers the conversation to `target`. */
export interface HandoffTool extends AgentToolRunnable {
	readonly target: Agent;
}

const handoffTargets = new WeakMap<object, Agent>();

/** The model-facing tool name `createSupervisor` uses for a member. */
export function handoffToolName(agent: Agent): string {
	return `transfer_to_${slug(agent.config.name)}`;
}

/**
 * A tool that hands the conversation to `target` within the same run. Put it
 * in an agent's `tools` under any name; when the model calls it, `target`
 * continues with the full transcript and its own instructions and tools.
 *
 * @example
 * ```ts
 * const billing = new Agent({ name: "billing", model, instructions: "…" });
 * const triage = new Agent({
 *   name: "triage",
 *   model,
 *   tools: { transfer_to_billing: handoff(billing, { description: "Invoices and refunds" }) },
 * });
 * const { text } = await triage.generate("I was charged twice");
 * ```
 */
export function handoff(
	target: Agent,
	options: HandoffOptions = {}
): HandoffTool {
	const description = options.description ?? target.config.description;
	const base: HandoffTool = {
		id: `handoff-${slug(target.config.name)}`,
		name: `Transfer to ${target.config.name}`,
		kind: "tool",
		schema: HANDOFF_INPUT_SCHEMA,
		description: description
			? `Hand the conversation to the ${target.config.name} agent: ${description}`
			: `Hand the conversation to the ${target.config.name} agent.`,
		code: IN_PROCESS_ONLY_CODE,
		target,
		run() {
			return Promise.reject(
				new Error(
					`[ryu-sdk] handoff to "${target.config.name}" only runs inside an SDK agent run`
				)
			);
		},
	};
	const tool: HandoffTool =
		options.needsApproval === undefined
			? base
			: { ...base, needsApproval: options.needsApproval };
	handoffTargets.set(tool, target);
	return tool;
}

function handoffTarget(tool: AgentTool | undefined): Agent | undefined {
	return tool ? handoffTargets.get(tool) : undefined;
}

/** True when any of `tools` is a `handoff()` tool. */
export function hasHandoffs(
	tools: Record<string, AgentTool> | undefined
): boolean {
	return Object.values(tools ?? {}).some(
		(tool) => handoffTarget(tool) !== undefined
	);
}

// ── Runner ────────────────────────────────────────────────────────────────────

interface ActivationState {
	/** True once the handoff short-circuited a model round. */
	closed: boolean;
	handoff?: { reason?: string; target: Agent };
	/** Tool messages produced after the last captured model call. */
	pendingTools: LoopMessage[];
	/** Model rounds that reached the agent's model-call chain. */
	rounds: number;
	/** Transcript seen by the last model call, plus its reply. */
	transcript?: LoopMessage[];
}

function withoutSystem(messages: readonly LoopMessage[]): LoopMessage[] {
	return messages.filter((message) => message.role !== "system");
}

function activationMiddleware(
	tools: Record<string, AgentTool> | undefined,
	state: ActivationState
): AgentMiddleware {
	return {
		name: "ryu-handoff",
		wrapModelCall: async (request, next) => {
			if (state.handoff) {
				// Capture once: an `afterTurn` follow-up added after the handoff is
				// the transferring agent's, so it is not carried to the target.
				if (!state.closed) {
					state.transcript = withoutSystem(request.messages);
					state.pendingTools = [];
				}
				state.closed = true;
				return {
					finishReason: HANDOFF_FINISH_REASON,
					message: { role: "assistant", content: "" },
				};
			}
			state.rounds += 1;
			const result = await next(request);
			state.transcript = [...withoutSystem(request.messages), result.message];
			state.pendingTools = [];
			return result;
		},
		wrapToolCall: (request, next) => {
			const target = handoffTarget(tools?.[request.name]);
			if (!target) {
				return next(request);
			}
			if (state.handoff) {
				return Promise.resolve({
					output: {
						error: `already handing off to ${state.handoff.target.config.name}`,
					},
				});
			}
			const reason = reasonInputSchema.safeParse(request.input);
			state.handoff = {
				target,
				reason: reason.success ? reason.data.reason : undefined,
			};
			return Promise.resolve({
				output: { transferred_to: target.config.name },
			});
		},
	};
}

function toolMessage(
	id: string,
	output: AgentEventToolResult["output"]
): LoopMessage {
	const text = z.string().safeParse(output);
	return {
		role: "tool",
		tool_call_id: id,
		content: text.success ? text.data : JSON.stringify(output),
	};
}

function addUsage(
	a: ModelUsage | undefined,
	b: ModelUsage | undefined
): ModelUsage | undefined {
	if (!(a || b)) {
		return undefined;
	}
	return {
		promptTokens: (a?.promptTokens ?? 0) + (b?.promptTokens ?? 0),
		completionTokens: (a?.completionTokens ?? 0) + (b?.completionTokens ?? 0),
		totalTokens: (a?.totalTokens ?? 0) + (b?.totalTokens ?? 0),
	};
}

/** The note that hands control back to `returnTo` after `from` answers. */
function returnNote(from: string, returnTo: Agent): string {
	return `[${from} finished its turn; its reply is the previous assistant message. ${returnTo.config.name}, continue: delegate the next step or give the final answer.]`;
}

/** Inputs for one multi-agent run. */
export interface AgentChainOptions {
	/** Approval handler for members that have none of their own. */
	approvalHandler?: AgentRunOptions["approvalHandler"];
	/** The agent that receives the first turn. */
	entry: Agent;
	/** Cap on agent activations (each agent turn counts as one). */
	maxSteps: number;
	/** When set, only these agents may receive a handoff. */
	members?: ReadonlySet<Agent>;
	/** Seed transcript (usually a single user message). */
	messages: LoopMessage[];
	/** Hand control back to this agent whenever another agent finishes. */
	returnTo?: Agent;
	signal?: AbortSignal;
}

interface ActivationOutcome {
	result?: AgentEventResult;
	state: ActivationState;
}

/**
 * Run one agent activation, re-yielding its events tagged with the agent name.
 * Returns the loop's result, or none when the activation ended on an error or
 * a pause.
 */
async function* runActivation(
	active: Agent,
	transcript: LoopMessage[],
	signal: AbortSignal | undefined,
	approvalHandler: AgentRunOptions["approvalHandler"]
): AsyncGenerator<NetworkEvent, ActivationOutcome> {
	const state: ActivationState = {
		closed: false,
		pendingTools: [],
		rounds: 0,
	};
	const agent = active.config.name;
	let result: AgentEventResult | undefined;
	const events = active.streamMessages(transcript, {
		middleware: [activationMiddleware(active.config.tools, state)],
		signal,
		approvalHandler,
	});
	for await (const event of events) {
		if (state.closed && (event.type === "text" || event.type === "error")) {
			// The synthetic round that ends a handoff carries no content, and a
			// structured-output check against it is not a real failure.
			continue;
		}
		if (event.type === "result") {
			result = event;
			continue;
		}
		if (event.type === "tool_result") {
			state.pendingTools.push(toolMessage(event.id, event.output));
		}
		yield { ...event, agent };
		if (event.type === "error") {
			return { state };
		}
	}
	if (!result && state.closed) {
		// A structured-output agent's synthetic handoff round ends in a dropped
		// output-validation error instead of a result; the handoff still stands.
		result = { type: "result", text: "", steps: state.rounds };
	}
	return { result, state };
}

/**
 * Drive a multi-agent run: activate `entry`, follow handoffs, and return to
 * `returnTo` after other agents finish, until an agent answers without
 * handing off or `maxSteps` activations are used.
 */
export async function* runAgentChain(
	options: AgentChainOptions
): AsyncGenerator<NetworkEvent> {
	let active = options.entry;
	let transcript = withoutSystem(options.messages);
	let steps = 0;
	let usage: ModelUsage | undefined;
	let lastText = "";

	for (let activation = 1; activation <= options.maxSteps; activation++) {
		const agent = active.config.name;
		const { result, state } = yield* runActivation(
			active,
			transcript,
			options.signal,
			options.approvalHandler
		);
		if (!result) {
			return;
		}
		steps += state.rounds;
		usage = addUsage(usage, result.usage);
		transcript = [...(state.transcript ?? transcript), ...state.pendingTools];

		if (state.handoff) {
			const { target, reason } = state.handoff;
			if (options.members && !options.members.has(target)) {
				yield {
					type: "error",
					agent,
					message: `agent "${agent}" handed off to "${target.config.name}", which is not a member of this network`,
				};
				return;
			}
			const event: AgentEventHandoff & { agent: string } = {
				type: "handoff",
				agent,
				from: agent,
				to: target.config.name,
			};
			if (reason) {
				event.reason = reason;
			}
			yield event;
			active = target;
			continue;
		}

		lastText = result.text;
		if (options.returnTo && active !== options.returnTo) {
			// The member's reply is the last (assistant) message. Many providers
			// treat a trailing assistant message as a prefill to continue, or
			// reject it, so hand control back with a user-role note that names
			// who answered.
			transcript = [
				...transcript,
				{ role: "user", content: returnNote(agent, options.returnTo) },
			];
			yield {
				type: "handoff",
				agent,
				from: agent,
				to: options.returnTo.config.name,
				reason: "completed",
			};
			active = options.returnTo;
			continue;
		}

		yield {
			type: "result",
			agent,
			text: result.text,
			steps,
			usage,
			output: result.output,
			activations: activation,
			maxStepsReached: false,
			messages: transcript,
		};
		return;
	}

	yield {
		type: "result",
		agent: active.config.name,
		text: lastText,
		steps,
		usage,
		activations: options.maxSteps,
		maxStepsReached: true,
		messages: transcript,
	};
}

/**
 * `Agent.stream()` for an agent with handoff tools: follow handoffs and report
 * the run with the single-agent event surface.
 */
export async function* streamWithHandoffs(
	entry: Agent,
	messages: LoopMessage[],
	signal?: AbortSignal,
	approvalHandler?: AgentRunOptions["approvalHandler"]
): AsyncGenerator<AgentEvent> {
	for await (const event of runAgentChain({
		entry,
		messages,
		maxSteps: DEFAULT_NETWORK_MAX_STEPS,
		signal,
		approvalHandler,
	})) {
		if (event.type === "handoff") {
			continue;
		}
		if (event.type === "result") {
			yield {
				type: "result",
				text: event.text,
				steps: event.steps,
				usage: event.usage,
				output: event.output,
			};
			continue;
		}
		yield event;
	}
}

// ── Networks ──────────────────────────────────────────────────────────────────

/** Configuration for an `AgentNetwork`. */
export interface AgentNetworkConfig {
	/** Member agents. Names must be unique; handoffs may only target members. */
	agents: Agent[];
	/** Describes the network when it is used as a tool. */
	description?: string;
	/** The agent that takes the first turn. Defaults to `agents[0]`. */
	entry?: Agent;
	/** Cap on agent activations for one run (default 10). */
	maxSteps?: number;
	/** Display name, used when the network is exposed as a tool. */
	name?: string;
	/** Return control to this agent after any other agent finishes a turn. */
	returnTo?: Agent;
}

/**
 * A set of agents that route a conversation between each other with handoffs.
 * Without `returnTo` it behaves as a swarm (the last agent to answer ends the
 * run); with `returnTo` every member reports back to that agent.
 */
export class AgentNetwork {
	readonly agents: readonly Agent[];
	readonly description?: string;
	readonly entry: Agent;
	readonly maxSteps: number;
	readonly name: string;
	readonly returnTo?: Agent;
	private readonly members: ReadonlySet<Agent>;

	constructor(config: AgentNetworkConfig) {
		const members = new Set(config.agents);
		if (config.entry) {
			members.add(config.entry);
		}
		if (config.returnTo) {
			members.add(config.returnTo);
		}
		const entry = config.entry ?? config.agents[0];
		if (!entry) {
			throw new Error("[ryu-sdk] an agent network needs at least one agent");
		}
		const names = new Set<string>();
		for (const member of members) {
			if (names.has(member.config.name)) {
				throw new Error(
					`[ryu-sdk] agent network members need unique names; "${member.config.name}" is repeated`
				);
			}
			names.add(member.config.name);
		}
		const maxSteps = config.maxSteps ?? DEFAULT_NETWORK_MAX_STEPS;
		if (!Number.isInteger(maxSteps) || maxSteps < 1) {
			throw new Error("[ryu-sdk] agent network maxSteps must be at least 1");
		}
		this.agents = [...members];
		this.members = members;
		this.entry = entry;
		this.returnTo = config.returnTo;
		this.maxSteps = maxSteps;
		this.name = config.name ?? `${entry.config.name}-network`;
		this.description = config.description;
	}

	/**
	 * Stream the run; every event names the agent that produced it.
	 * `options.approvalHandler` answers tool approvals for members that have
	 * no handler of their own.
	 */
	stream(
		input: string | LoopMessage[],
		signal?: AbortSignal,
		options: AgentRunOptions = {}
	): AsyncGenerator<NetworkEvent> {
		const messages: LoopMessage[] = Array.isArray(input)
			? [...input]
			: [{ role: "user", content: input }];
		return runAgentChain({
			entry: this.entry,
			messages,
			maxSteps: this.maxSteps,
			members: this.members,
			returnTo: this.returnTo,
			signal,
			approvalHandler: options.approvalHandler,
		});
	}

	/** Run to completion. Throws when a member reports an error. */
	async generate(
		input: string | LoopMessage[],
		signal?: AbortSignal
	): Promise<NetworkResult> {
		let final: NetworkEventResult | undefined;
		let authRequired: AgentEventAuthRequired | undefined;
		let approvalRequired: AgentEventApprovalRequested | undefined;
		for await (const event of this.stream(input, signal)) {
			if (event.type === "result") {
				final = event;
			} else if (event.type === "auth_required") {
				authRequired = event;
			} else if (event.type === "approval_requested") {
				approvalRequired = event;
			} else if (event.type === "error") {
				throw new Error(
					`[ryu-sdk] network "${this.name}" agent "${event.agent}": ${event.message}`
				);
			}
		}
		return {
			text: final?.text ?? "",
			steps: final?.steps ?? 0,
			usage: final?.usage,
			output: final?.output,
			agent: final?.agent ?? this.entry.config.name,
			activations: final?.activations ?? 0,
			maxStepsReached: final?.maxStepsReached ?? false,
			messages: final?.messages ?? [],
			authRequired,
			approvalRequired,
		};
	}

	/** Expose the whole network as a tool of another agent. */
	asTool(options: AgentAsToolOptions = {}): AgentToolRunnable {
		return delegateTool(
			{
				name: this.name,
				description: this.description,
				generate: (prompt, signal) => this.generate(prompt, signal),
			},
			options
		);
	}
}

/** Configuration for `createSupervisor`. */
export interface SupervisorConfig
	extends Omit<
		AgentConfig,
		"instructions" | "maxSteps" | "name" | "resumeRunId" | "sessionId" | "tools"
	> {
	/** Member agents the supervisor routes between. */
	agents: Agent[];
	/** Supervisor persona; the team roster and routing rules are appended. */
	instructions?: string;
	/** Cap on agent activations, supervisor turns included (default 10). */
	maxSteps?: number;
	/** Supervisor name (default `supervisor`). */
	name?: string;
	/** Model rounds per supervisor turn (default 10). */
	supervisorMaxSteps?: number;
	/** Extra tools for the supervisor besides the member handoffs. */
	tools?: Record<string, AgentTool>;
}

/** An `AgentNetwork` whose entry and return point is a supervisor agent. */
export class SupervisorNetwork extends AgentNetwork {
	readonly supervisor: Agent;

	constructor(config: AgentNetworkConfig & { supervisor: Agent }) {
		const { supervisor, ...network } = config;
		super({ ...network, entry: supervisor, returnTo: supervisor });
		this.supervisor = supervisor;
	}
}

function supervisorInstructions(
	name: string,
	agents: Agent[],
	instructions: string | undefined
): string {
	const roster = agents
		.map((agent) => {
			const about = agent.config.description ?? "No description provided.";
			return `- ${agent.config.name} (call ${handoffToolName(agent)}): ${about}`;
		})
		.join("\n");
	const intro =
		instructions ??
		`You are ${name}, a supervisor that coordinates a team of agents to answer the user.`;
	return [
		intro,
		"",
		"Team:",
		roster,
		"",
		"Delegate one step at a time by calling the matching transfer tool. The agent's answer comes back to you in the conversation. When the request is fully answered, reply with the final answer yourself without calling a tool.",
	].join("\n");
}

/**
 * Create a supervisor that routes between `agents` until the task is done.
 * Each member turn returns control to the supervisor, which either delegates
 * again or answers. Events from `stream()` carry the active agent's name.
 *
 * @example
 * ```ts
 * const team = createSupervisor({
 *   model: "your-model-id",
 *   agents: [researcher, writer],
 *   maxSteps: 8,
 * });
 * for await (const event of team.stream("Write a brief on solid-state batteries")) {
 *   if (event.type === "text") process.stdout.write(`[${event.agent}] ${event.content}`);
 * }
 * ```
 */
export function createSupervisor(config: SupervisorConfig): SupervisorNetwork {
	const {
		agents,
		maxSteps,
		name = "supervisor",
		supervisorMaxSteps,
		tools,
		instructions,
		...agentConfig
	} = config;
	if (agents.length === 0) {
		throw new Error("[ryu-sdk] a supervisor needs at least one member agent");
	}
	const handoffs: Record<string, AgentTool> = {};
	for (const member of agents) {
		handoffs[handoffToolName(member)] = handoff(member);
	}
	const supervisor = new Agent({
		...agentConfig,
		name,
		instructions: supervisorInstructions(name, agents, instructions),
		maxSteps: supervisorMaxSteps,
		tools: { ...tools, ...handoffs },
	});
	return new SupervisorNetwork({
		agents: [supervisor, ...agents],
		supervisor,
		maxSteps,
		name,
		description: agentConfig.description,
	});
}
