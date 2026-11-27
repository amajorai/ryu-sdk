/**
 * Wrap a remote A2A agent as an `AgentTool`, so an SDK `Agent` can delegate to
 * an agent running anywhere that speaks A2A v1 (another Ryu node, or any other
 * A2A server).
 */

import { z } from "zod";
import type { AgentToolRunnable } from "../agent/network.ts";
import {
	type PrimitiveJsonValue,
	primitiveJsonSchema,
} from "../runnable/primitive-contracts.ts";
import type { RunnableContext } from "../runnable/runnable-types.ts";
import type { ToolInput, ToolSchema } from "../runnable/tool.ts";
import type { A2AClient } from "./client.ts";
import {
	A2A_TERMINAL_STATES,
	type A2AArtifact,
	type A2AMessage,
	type A2AMessageInput,
	type A2APart,
	type A2ASendMessageParams,
	type A2AStreamResponse,
	type A2ATask,
	type A2ATaskState,
	a2aMessageInputSchema,
} from "./types.ts";

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 300_000;
const INTERRUPTED_STATES: ReadonlySet<A2ATaskState> = new Set([
	"TASK_STATE_INPUT_REQUIRED",
	"TASK_STATE_AUTH_REQUIRED",
]);
const FAILED_STATES: ReadonlySet<A2ATaskState> = new Set([
	"TASK_STATE_FAILED",
	"TASK_STATE_REJECTED",
	"TASK_STATE_CANCELED",
]);
const PROMPT_SCHEMA: ToolSchema = {
	type: "object",
	properties: {
		prompt: {
			type: "string",
			description: "The task or question for the remote agent.",
		},
	},
	required: ["prompt"],
};
const promptInputSchema = z.object({ prompt: z.string().min(1) });
const IN_PROCESS_ONLY_CODE =
	'throw new Error("A2A agent tools run in the SDK process and cannot ship as inline_js");';

/** Options for `a2aAgentTool` / `client.asTool()`. */
export interface A2AToolOptions {
	/** What the calling model is told. Defaults to the Agent Card description and skills. */
	description?: string;
	/** Stable tool id. Defaults to `a2a-<card name>`. */
	id?: string;
	/** Continue the same A2A context across calls (default true). */
	keepContext?: boolean;
	/**
	 * Request metadata sent with every message, e.g. `{ ryuAgentId }` to pick
	 * one agent on a Ryu node that publishes several.
	 */
	metadata?: Record<string, PrimitiveJsonValue>;
	/** Display name. Defaults to the Agent Card name. */
	name?: string;
	needsApproval?: boolean;
	/** Interval between `GetTask` polls for a non-streaming task (default 1 s). */
	pollIntervalMs?: number;
	/** Use `SendStreamingMessage`. Defaults to the card's `capabilities.streaming`. */
	stream?: boolean;
	/** Give up waiting for a terminal state after this long (default 300 s). */
	timeoutMs?: number;
}

/** Options for one `runA2ATask` call. */
export interface RunA2ATaskOptions {
	/** Request-level `SendMessageRequest.metadata`. */
	metadata?: Record<string, PrimitiveJsonValue>;
	pollIntervalMs?: number;
	signal?: AbortSignal;
	stream?: boolean;
	timeoutMs?: number;
}

/** What a remote agent produced for one message. */
export interface A2ATaskOutcome {
	contextId?: string;
	/** Structured `data` parts, in order. */
	data: PrimitiveJsonValue[];
	/** Final task state, or `message` for a direct reply without a task. */
	state: A2ATaskState | "message";
	taskId?: string;
	/** Text parts joined with newlines (artifacts first, else the status message). */
	text: string;
}

function collectParts(
	parts: readonly A2APart[],
	text: string[],
	data: PrimitiveJsonValue[]
) {
	for (const part of parts) {
		if (part.text !== undefined) {
			text.push(part.text);
		} else if (part.data !== undefined) {
			const value = primitiveJsonSchema.safeParse(part.data);
			if (value.success) {
				data.push(value.data);
			}
		} else if (part.url !== undefined) {
			text.push(part.url);
		}
	}
}

function messageOutcome(message: A2AMessage): A2ATaskOutcome {
	const text: string[] = [];
	const data: PrimitiveJsonValue[] = [];
	collectParts(message.parts, text, data);
	const outcome: A2ATaskOutcome = {
		state: "message",
		text: text.join("\n"),
		data,
	};
	if (message.contextId) {
		outcome.contextId = message.contextId;
	}
	if (message.taskId) {
		outcome.taskId = message.taskId;
	}
	return outcome;
}

/** Summarize a task: artifact content first, otherwise its status message. */
export function taskOutcome(task: A2ATask): A2ATaskOutcome {
	const text: string[] = [];
	const data: PrimitiveJsonValue[] = [];
	for (const artifact of task.artifacts ?? []) {
		collectParts(artifact.parts, text, data);
	}
	if (text.length === 0 && data.length === 0 && task.status.message) {
		collectParts(task.status.message.parts, text, data);
	}
	return {
		state: task.status.state,
		taskId: task.id,
		contextId: task.contextId,
		text: text.join("\n"),
		data,
	};
}

function settled(state: A2ATaskState): boolean {
	return A2A_TERMINAL_STATES.has(state) || INTERRUPTED_STATES.has(state);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function streamTask(
	client: A2AClient,
	params: A2ASendMessageParams,
	timeoutMs: number,
	signal?: AbortSignal
): Promise<A2ATaskOutcome> {
	const state: StreamState = { artifacts: new Map() };
	const deadline = AbortSignal.timeout(timeoutMs);
	const streamSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
	try {
		for await (const event of client.sendStreamingMessage(
			params,
			streamSignal
		)) {
			applyStreamEvent(event, state);
			if (state.task && settled(state.task.status.state)) {
				// The task finished or needs input; stop reading even if the peer
				// keeps the stream open.
				break;
			}
		}
	} catch (error) {
		// Past the deadline a still-running task is returned as-is, like the
		// polling path; with nothing received yet the timeout is an error.
		if (!(deadline.aborted && !signal?.aborted)) {
			throw error;
		}
		if (!(state.task || state.reply)) {
			throw new Error(
				`[ryu-sdk] A2A stream produced no task or message within ${timeoutMs} ms`
			);
		}
	}
	if (state.task) {
		return taskOutcome({
			...state.task,
			artifacts: [...state.artifacts.values()],
		});
	}
	if (state.reply) {
		return messageOutcome(state.reply);
	}
	throw new Error("[ryu-sdk] A2A stream ended without a task or message");
}

/** What a streamed task has produced so far. */
interface StreamState {
	artifacts: Map<string, A2AArtifact>;
	reply?: A2AMessage;
	task?: A2ATask;
}

function applyStreamEvent(event: A2AStreamResponse, state: StreamState) {
	const { artifacts } = state;
	switch (event.kind) {
		case "message":
			state.reply = event.message;
			break;
		case "task":
			state.task = event.task;
			for (const artifact of event.task.artifacts ?? []) {
				artifacts.set(artifact.artifactId, artifact);
			}
			break;
		case "status_update":
			state.task = {
				...(state.task ?? {
					id: event.statusUpdate.taskId,
					contextId: event.statusUpdate.contextId,
				}),
				status: event.statusUpdate.status,
			};
			break;
		case "artifact_update": {
			const update = event.artifactUpdate.artifact;
			const existing = artifacts.get(update.artifactId);
			artifacts.set(
				update.artifactId,
				event.artifactUpdate.append && existing
					? { ...existing, parts: [...existing.parts, ...update.parts] }
					: update
			);
			break;
		}
		default:
			break;
	}
}

/**
 * Send one message to a remote agent and wait for its answer: stream when
 * asked, otherwise send and poll `GetTask` until the task completes, fails, or
 * asks for input. A task still running at `timeoutMs` is returned as-is.
 */
export async function runA2ATask(
	client: A2AClient,
	message: A2AMessageInput | string,
	options: RunA2ATaskOptions = {}
): Promise<A2ATaskOutcome> {
	const input = a2aMessageInputSchema.parse(message);
	const params: A2ASendMessageParams = { message: input };
	if (options.metadata) {
		params.metadata = options.metadata;
	}
	if (options.stream) {
		return streamTask(
			client,
			params,
			options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			options.signal
		);
	}
	const response = await client.sendMessage(params, options.signal);
	if (response.kind === "message") {
		return messageOutcome(response.message);
	}
	let task = response.task;
	const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	while (!settled(task.status.state) && Date.now() < deadline) {
		await sleep(
			options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
			options.signal
		);
		task = await client.getTask(task.id, { signal: options.signal });
	}
	return taskOutcome(task);
}

function cardDescription(client: A2AClient): string | undefined {
	const card = client.card;
	if (!card) {
		return;
	}
	const skills = card.skills
		.slice(0, 12)
		.map((skill) => `${skill.name}: ${skill.description}`)
		.join("; ");
	return skills ? `${card.description} Skills: ${skills}` : card.description;
}

function slug(name: string): string {
	const cleaned = name
		.trim()
		.toLowerCase()
		.replaceAll(/[^a-z0-9_-]+/g, "_")
		.replaceAll(/^_+|_+$/g, "");
	return cleaned === "" ? "remote" : cleaned.slice(0, 48);
}

/**
 * Wrap a remote A2A agent as a tool. The model sends `{ prompt }`; a completed
 * task returns its text (or structured data), a failed/rejected/canceled task
 * becomes a tool error, and a task that needs more input returns its state so
 * the model can reply — the next call continues the same task.
 */
export function a2aAgentTool(
	client: A2AClient,
	options: A2AToolOptions = {}
): AgentToolRunnable {
	const name = options.name ?? client.card?.name ?? client.endpoint.url.host;
	const keepContext = options.keepContext ?? true;
	const stream = options.stream ?? client.card?.capabilities.streaming === true;
	let contextId: string | undefined;
	let pendingTaskId: string | undefined;

	const tool: AgentToolRunnable = {
		id: options.id ?? `a2a-${slug(name)}`,
		name,
		kind: "tool",
		schema: PROMPT_SCHEMA,
		description:
			options.description ??
			cardDescription(client) ??
			`Delegate a task to the remote ${name} agent.`,
		code: IN_PROCESS_ONLY_CODE,
		async run(input: ToolInput, ctx: RunnableContext) {
			const parsed = promptInputSchema.safeParse(input);
			if (!parsed.success) {
				throw new Error(
					`[ryu-sdk] A2A tool "${name}" needs a non-empty "prompt" string`
				);
			}
			const message: A2AMessageInput = {
				parts: [{ text: parsed.data.prompt }],
			};
			if (keepContext && contextId) {
				message.contextId = contextId;
			}
			if (keepContext && pendingTaskId) {
				message.taskId = pendingTaskId;
			}
			const outcome = await runA2ATask(client, message, {
				stream,
				signal: ctx.signal,
				metadata: options.metadata,
				pollIntervalMs: options.pollIntervalMs,
				timeoutMs: options.timeoutMs,
			});
			if (keepContext) {
				contextId = outcome.contextId ?? contextId;
				pendingTaskId =
					outcome.state !== "message" && INTERRUPTED_STATES.has(outcome.state)
						? outcome.taskId
						: undefined;
			}
			if (outcome.state !== "message" && FAILED_STATES.has(outcome.state)) {
				throw new Error(
					`[ryu-sdk] remote agent "${name}" ended in ${outcome.state}${outcome.text ? `: ${outcome.text}` : ""}`
				);
			}
			if (
				outcome.state === "message" ||
				outcome.state === "TASK_STATE_COMPLETED"
			) {
				if (outcome.text !== "" || outcome.data.length === 0) {
					return outcome.text;
				}
				return outcome.data.length === 1 ? outcome.data[0] : outcome.data;
			}
			return {
				state: outcome.state,
				text: outcome.text,
				taskId: outcome.taskId,
				contextId: outcome.contextId,
			};
		},
	};
	if (options.needsApproval !== undefined) {
		return { ...tool, needsApproval: options.needsApproval };
	}
	return tool;
}
