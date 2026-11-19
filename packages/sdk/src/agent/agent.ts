/**
 * `Agent` — the declarative agent runtime for `@ryu/sdk`.
 *
 * Unlike `defineAgent` (a declaration wrapper whose `run()` you write by hand),
 * `Agent` OWNS the loop: give it instructions, a model, a target node, and a
 * set of tools, then call `generate()` / `stream()`. Inference is pointed at the
 * node's gateway; tool calls resolve to local `defineTool` runnables or existing
 * Ryu tools (`ryuTool`) executed through Core.
 *
 * Mirrors Mastra's config-object + `.generate()`/`.stream()` shape; `query()`
 * (see query.ts) wraps the same runtime in a Claude-Agent-SDK-style streaming
 * call.
 */

// biome-ignore lint/correctness/useImportExtensions: Published client exposes only the package root.
import {
	HarnessAPI,
	type HarnessApprovalOption,
	type MultitaskStrategy,
} from "@ryuhq/client";
import { z } from "zod";
import { resolveCoreToken } from "../core-env.ts";
import { defineModel } from "../model/client.ts";
import { resolveGatewayToken, resolveGatewayUrl } from "../model/gateway.ts";
import {
	type PromptInstructions,
	resolveInstructions,
} from "../prompts/instructions.ts";
import {
	createPrimitives,
	httpPrimitiveTransport,
} from "../runnable/primitives.ts";
import type { GatewayClient } from "../runnable/runnable-types.ts";
import { normalizeSchema, type SchemaLike } from "../schema/json-schema.ts";
import type { StandardSchemaWithJsonSchema } from "../schema/standard-schema.ts";
import {
	describeStructuredOutputFailure,
	readStructuredReply,
	STRUCTURED_OUTPUT_ERROR_CODE,
	StructuredOutputError,
} from "../schema/structured-output.ts";
import { AgentVoice, type AgentVoiceConfig } from "../voice/voice.ts";
import { type CompactionOptions, compactionMiddleware } from "./compaction.ts";
import {
	type AgentEvent,
	type AgentEventApprovalRequested,
	type AgentEventAuthRequired,
	type LoopConfig,
	runAgentLoop,
} from "./loop.ts";
import type { AgentMiddleware } from "./middleware.ts";
import type { LoopMessage, ModelUsage } from "./model-call.ts";
import {
	type AgentAsToolOptions,
	type AgentToolRunnable,
	agentAsTool,
	hasHandoffs,
	streamWithHandoffs,
} from "./network.ts";
import { describeSdkError as describeError } from "./runtime-values.ts";
import type {
	AgentApprovalHandler,
	AgentTool,
	ToolExecContext,
} from "./tools.ts";
import {
	createWorkingMemoryHandle,
	mountWorkingMemory,
	type ResolvedWorkingMemory,
	resolveWorkingMemory,
	WORKING_MEMORY_TOOL_NAME,
	type WorkingMemoryOptions,
	workingMemoryMiddleware,
	workingMemoryTool,
} from "./working-memory.ts";

const DEFAULT_MAX_STEPS = 10;
const DEFAULT_CORE_URL = "http://127.0.0.1:7980";

/** A target node for inference / tool execution: a base URL + optional token. */
export interface Endpoint {
	baseUrl?: string;
	token?: string;
}

/** Per-run options for `Agent.stream()`, `streamMessages()`, and networks. */
export interface AgentRunOptions {
	/**
	 * Approval handler for this run, used by every agent in it that has no
	 * `approvalHandler` of its own (a server parks the decision until a client
	 * answers). An agent's configured handler always wins.
	 */
	approvalHandler?: AgentApprovalHandler;
}

/**
 * Declarative configuration for an `Agent`. `TOutput` is inferred from a typed
 * `outputSchema` (zod / valibot / arktype) and types `generate().output`.
 */
export interface AgentConfig<TOutput = unknown> {
	/** Core agent id — REQUIRED when using `ryuTool` remote tools (governance). */
	agentId?: string;
	/** Optional human decision callback for SDK-managed tool approvals. */
	approvalHandler?: AgentApprovalHandler;
	/**
	 * Summarize older turns once the transcript passes `threshold` estimated
	 * tokens (SDK-owned loop only; a Core agent sets `memory.compaction`).
	 */
	compaction?: CompactionOptions;
	/** Core endpoint for tool discovery/execution. Defaults to env/localhost. */
	core?: Endpoint;
	/**
	 * What this agent is for. Shown to other agents when it is used as a tool
	 * (`asTool`), a handoff target, or a supervisor member.
	 */
	description?: string;
	/**
	 * System prompt / persona: text, or a prompt-registry reference
	 * (`{ prompt: "support-triage", label: "production", variables }`) resolved
	 * when each run starts. See `@ryuhq/sdk/prompts`.
	 */
	instructions?: string | PromptInstructions;
	/**
	 * Re-asks after a final reply that fails `outputSchema` (JSON parse or
	 * validation), each carrying the validation issues back to the model
	 * (default 2; 0 disables repair). SDK-owned loop only: a `sessionId` run is
	 * executed by Core and its output is validated once.
	 */
	maxRepairAttempts?: number;
	/** Hard ceiling on model→tool rounds (default 10). */
	maxSteps?: number;
	/**
	 * In-process middleware for the SDK-owned loop, first entry outermost. Not
	 * supported with `sessionId`: Core owns that run, so customize it with a
	 * plugin hook (`defineFunctionHook`) instead.
	 */
	middleware?: AgentMiddleware[];
	/** Model id routed by the node's gateway. */
	model: string;
	/**
	 * What a `sessionId` run does when the session already has an active run:
	 * `reject` (default) fails, `enqueue` waits in the session's durable queue,
	 * `interrupt` stops the active run and keeps its partial transcript, and
	 * `rollback` stops it and removes its turns before this run starts.
	 */
	multitaskStrategy?: MultitaskStrategy;
	/** Display name. */
	name: string;
	/** Target node for inference. Defaults to the local gateway. */
	node?: Endpoint;
	/**
	 * Schema for the final structured output: any Standard Schema validator
	 * (zod 4, valibot, arktype, …; infers `TOutput`) or a JSON Schema object.
	 * Sent as the model's `response_format` and enforced on the reply.
	 */
	outputSchema?: SchemaLike<TOutput>;
	/**
	 * Reverse-domain plugin id. When set, the composable primitive surface
	 * (`ctx.rag`, `ctx.memory`, `ctx.engines`, …) is mounted on the run context,
	 * routed through this node via the governed host bridge / capability broker.
	 * Omitted = no primitives mounted (the bridge families authenticate a plugin
	 * id, so a half-wired transport is never attached).
	 */
	pluginId?: string;
	/** Optional terminal run id to resume as a new attempt on the first call. */
	resumeRunId?: string;
	/** Existing Core harness session used for durable start/resume semantics. */
	sessionId?: string;
	/** Tools keyed by the model-facing name. */
	tools?: Record<string, AgentTool>;
	/** Composio connected-account entity selector. */
	userId?: string;
	/**
	 * Speech defaults for `agent.voice` (Gateway speech/transcription model
	 * ids, or Core engine ids, plus a default voice).
	 */
	voice?: AgentVoiceConfig;
	/**
	 * Mastra-style working memory: a per-thread or per-resource scratchpad
	 * (Markdown `template` or JSON `schema`) stored in Core, injected into every
	 * model call, and updated by the model through `update_working_memory`.
	 * Also mounted as `ctx.memory.working`. SDK-owned loop only; a Core agent
	 * sets `memory.working_memory` instead.
	 */
	workingMemory?: WorkingMemoryOptions;
}

/** Result of a non-streaming `generate()`. */
export interface GenerateResult<TOutput = unknown> {
	/** Present when a durable run paused for human approval. */
	approvalRequired?: AgentEventApprovalRequested;
	/** Present when the run paused for an account connection. */
	authRequired?: AgentEventAuthRequired;
	/** Validated structured output when `outputSchema` was configured. */
	output?: TOutput;
	/** Number of model→tool rounds taken. */
	steps: number;
	/** Final assistant text. */
	text: string;
	/** Aggregate token usage across all rounds (when reported). */
	usage?: ModelUsage;
}

/** Read `process.env` defensively (SDK may run outside Node typings). */
function env(key: string): string | undefined {
	const value = globalThis.process?.env?.[key];
	return value && value !== "" ? value : undefined;
}

/**
 * Build a `GatewayClient` for local tools that lazily constructs the native
 * `ModelClient` only on first use — so an agent with no gateway-calling local
 * tools never touches the native addon.
 */
function lazyGatewayClient(
	model: string,
	baseUrl: string,
	token?: string
): GatewayClient {
	let client: ReturnType<typeof defineModel> | null = null;
	const get = () => {
		client ??= defineModel(model, { baseUrl, token });
		return client;
	};
	return {
		chat: (messages) => get().chat(messages),
		stream: (messages) => get().stream(messages),
	};
}

function selectApprovalOption(
	decision: boolean | string,
	options: HarnessApprovalOption[]
): string | undefined {
	const requestedOption = z.string().safeParse(decision);
	if (requestedOption.success) {
		const optionId = requestedOption.data.trim();
		if (!optionId) {
			return undefined;
		}
		return options.length === 0 ||
			options.some((option) => option.optionId === optionId)
			? optionId
			: undefined;
	}
	if (!decision) {
		return undefined;
	}
	return options.find((option) => {
		const kind = option.kind.toLowerCase().replaceAll("-", "_");
		return kind === "allow_once" || kind === "allow_always";
	})?.optionId;
}

interface HarnessCompletedToolOutput {
	ok: boolean;
	resultHash?: string;
}

/** A declarative, loop-owning agent. */
export class Agent<TOutput = unknown> {
	readonly config: AgentConfig<TOutput>;
	/**
	 * Speech for this agent: `speak`, `listen`, and `realtime`, routed through
	 * the agent's node (Gateway model ids or Core engines).
	 */
	readonly voice: AgentVoice;
	/** `outputSchema` normalized once (throws `SchemaConversionError` early). */
	private readonly outputContract?: StandardSchemaWithJsonSchema<
		unknown,
		TOutput
	>;

	/** `workingMemory` resolved once (throws early on an invalid config). */
	private readonly workingMemory?: ResolvedWorkingMemory;

	constructor(config: AgentConfig<TOutput>) {
		if (config.outputSchema) {
			this.outputContract = normalizeSchema(config.outputSchema);
		}
		if (config.workingMemory) {
			this.workingMemory = resolveWorkingMemory(config.workingMemory);
		}
		this.config = config;
		this.voice = new AgentVoice(config.voice ?? {}, () => ({
			agentId: this.config.agentId,
			core: {
				baseUrl:
					this.config.core?.baseUrl ?? env("RYU_CORE_URL") ?? DEFAULT_CORE_URL,
				token: this.config.core?.token ?? resolveCoreToken(),
			},
			gateway: {
				baseUrl: this.config.node?.baseUrl ?? resolveGatewayUrl(),
				token: this.config.node?.token ?? resolveGatewayToken(),
			},
		}));
	}

	/**
	 * Assemble the loop config for a transcript. This agent's `instructions`
	 * replace any system messages carried in from another agent.
	 */
	private buildLoopConfig(
		transcript: LoopMessage[],
		signal?: AbortSignal,
		outerMiddleware: AgentMiddleware[] = [],
		instructions?: string,
		fallbackApprovalHandler?: AgentApprovalHandler
	): LoopConfig {
		const gatewayBaseUrl = this.config.node?.baseUrl ?? resolveGatewayUrl();
		const gatewayToken = this.config.node?.token ?? resolveGatewayToken();
		const coreBaseUrl =
			this.config.core?.baseUrl ?? env("RYU_CORE_URL") ?? DEFAULT_CORE_URL;
		const coreToken = this.config.core?.token ?? resolveCoreToken();

		const messages: LoopMessage[] = [];
		if (instructions) {
			messages.push({ role: "system", content: instructions });
		}
		for (const message of transcript) {
			if (!(instructions && message.role === "system")) {
				messages.push(message);
			}
		}
		const middleware = [...outerMiddleware, ...(this.config.middleware ?? [])];
		let tools: Record<string, AgentTool> = this.config.tools ?? {};

		const runnableContext: ToolExecContext["runnableContext"] = {
			gateway: lazyGatewayClient(
				this.config.model,
				gatewayBaseUrl,
				gatewayToken
			),
			signal,
		};
		if (this.config.pluginId) {
			Object.assign(
				runnableContext,
				createPrimitives(
					httpPrimitiveTransport({
						baseUrl: coreBaseUrl,
						token: coreToken,
						pluginId: this.config.pluginId,
					})
				)
			);
		}
		if (this.workingMemory) {
			const handle = createWorkingMemoryHandle(this.workingMemory, {
				coreBaseUrl,
				coreToken,
			});
			mountWorkingMemory(runnableContext, handle);
			middleware.push(workingMemoryMiddleware(this.workingMemory, handle));
			if (!(WORKING_MEMORY_TOOL_NAME in tools)) {
				tools = {
					...tools,
					[WORKING_MEMORY_TOOL_NAME]: workingMemoryTool(
						this.workingMemory,
						handle
					),
				};
			}
		}
		if (this.config.compaction) {
			// Innermost, so it sees the final outbound messages (working memory
			// included) and never summarizes away the system block.
			middleware.push(
				compactionMiddleware(this.config.compaction, {
					baseUrl: gatewayBaseUrl,
					model: this.config.model,
					token: gatewayToken,
				})
			);
		}
		const toolCtx: ToolExecContext = {
			agentId: this.config.agentId,
			coreBaseUrl,
			coreToken,
			userId: this.config.userId,
			signal,
			runnableContext,
		};

		return {
			model: this.config.model,
			gatewayBaseUrl,
			gatewayToken,
			messages,
			tools,
			approvalHandler: this.config.approvalHandler ?? fallbackApprovalHandler,
			middleware: middleware.length > 0 ? middleware : undefined,
			outputSchema: this.outputContract,
			maxRepairAttempts: this.config.maxRepairAttempts,
			toolCtx,
			maxSteps: this.config.maxSteps ?? DEFAULT_MAX_STEPS,
			signal,
		};
	}

	/** Consume a Core-owned run's durable event stream into SDK events. */
	private async *consumeHarnessRun(
		harness: HarnessAPI,
		runId: string,
		signal?: AbortSignal,
		after = 0
	): AsyncGenerator<AgentEvent> {
		let text = "";
		let steps = 0;
		for await (const event of harness.events(runId, after, signal)) {
			switch (event.type) {
				case "text_delta":
					text += event.delta;
					yield { type: "text", content: event.delta };
					break;
				case "input_accepted":
					// The input boundary is durable provenance for reconnecting
					// clients, not a second user-visible message.
					break;
				case "tool_call_started":
					steps += 1;
					yield {
						type: "tool_call",
						id: event.toolCallId,
						name: event.name,
						input: {},
					};
					break;
				case "tool_call_completed": {
					const output: HarnessCompletedToolOutput = { ok: event.ok };
					if (event.resultHash) {
						output.resultHash = event.resultHash;
					}
					yield {
						type: "tool_result",
						id: event.toolCallId,
						name: event.name,
						output,
					};
					break;
				}

				case "approval_requested": {
					const approvalOptions: HarnessApprovalOption[] = event.options ?? [];
					yield {
						type: "approval_requested",
						approvalId: event.approvalId,
						name: "runtime",
						options: approvalOptions,
						summary: event.summary,
					};
					if (!this.config.approvalHandler) {
						return;
					}
					try {
						const decision = await this.config.approvalHandler({
							approvalId: event.approvalId,
							input: undefined,
							name: "runtime",
							options: approvalOptions,
							summary: event.summary,
						});
						const optionId = selectApprovalOption(decision, approvalOptions);
						if (
							z.string().safeParse(decision).success &&
							approvalOptions.length > 0 &&
							!optionId
						) {
							yield {
								type: "error",
								message: "approval handler returned an unknown option id",
							};
							return;
						}
						const resolved = await harness.resolvePermission(
							event.approvalId,
							optionId
						);
						if (!resolved) {
							yield {
								type: "error",
								message: "approval request is no longer active",
							};
							return;
						}
					} catch (error) {
						await harness
							.resolvePermission(event.approvalId)
							.catch(() => false);
						yield { type: "error", message: describeError(error) };
						return;
					}
					break;
				}
				case "run_failed":
					yield { type: "error", message: event.message };
					return;
				case "run_completed": {
					if (!this.outputContract) {
						yield { type: "result", text, steps };
						return;
					}
					// Core owns this run, so there is no repair round: validate once.
					const reply = await readStructuredReply(
						event.output ?? text,
						this.outputContract
					);
					if (reply.ok) {
						yield { type: "result", text, steps, output: reply.value };
					} else {
						yield {
							type: "error",
							code: STRUCTURED_OUTPUT_ERROR_CODE,
							message: describeStructuredOutputFailure(reply.issues, 1),
							issues: reply.issues,
							attempts: 1,
							text,
						};
					}
					return;
				}
				case "run_canceled":
					yield { type: "error", message: "durable run canceled" };
					return;
				case "run_interrupted":
					yield { type: "error", message: "durable run interrupted" };
					return;
				case "run_queued":
				case "run_started":
				case "checkpoint":
				case "ui_frame":
					break;
			}
		}
	}

	/** Stream a Core-owned durable harness session when one is configured. */
	private async *streamHarness(
		prompt: string,
		signal?: AbortSignal,
		resumeRunId?: string
	): AsyncGenerator<AgentEvent> {
		const coreBaseUrl =
			this.config.core?.baseUrl ?? env("RYU_CORE_URL") ?? DEFAULT_CORE_URL;
		const coreToken = this.config.core?.token ?? resolveCoreToken();
		if ((this.config.middleware?.length ?? 0) > 0) {
			yield {
				type: "error",
				message:
					"middleware runs only in the SDK-owned loop; a sessionId run is executed by Core, so use a plugin hook instead",
			};
			return;
		}
		if (this.config.workingMemory || this.config.compaction) {
			yield {
				type: "error",
				message:
					"workingMemory and compaction run only in the SDK-owned loop; a sessionId run is executed by Core, so set memory.working_memory / memory.compaction on the Core agent instead",
			};
			return;
		}
		const harness = new HarnessAPI({ baseUrl: coreBaseUrl, token: coreToken });
		let runId: string | undefined;
		try {
			const startOptions: Parameters<HarnessAPI["startRun"]>[2] = {};
			if (resumeRunId) {
				startOptions.resumeRunId = resumeRunId;
			}
			if (this.config.multitaskStrategy) {
				startOptions.multitaskStrategy = this.config.multitaskStrategy;
			}
			const started = await harness.startRun(
				this.config.sessionId ?? "",
				{ prompt },
				startOptions
			);
			const currentRunId = started.run.id;
			runId = currentRunId;
			yield* this.consumeHarnessRun(harness, currentRunId, signal);
		} catch (error) {
			if (signal?.aborted) {
				if (runId) {
					await harness.cancel(runId).catch(() => false);
				}
				return;
			}
			yield { type: "error", message: describeError(error) };
		}
	}

	/** Resolve a pending native-runtime permission request for this session. */
	async resolvePermission(
		requestId: string,
		optionId?: string
	): Promise<boolean> {
		const coreBaseUrl =
			this.config.core?.baseUrl ?? env("RYU_CORE_URL") ?? DEFAULT_CORE_URL;
		const coreToken = this.config.core?.token ?? resolveCoreToken();
		return new HarnessAPI({
			baseUrl: coreBaseUrl,
			token: coreToken,
		}).resolvePermission(requestId, optionId);
	}

	/** Continue observing a pending durable run without creating a new attempt. */
	streamRun(
		runId: string,
		after = 0,
		signal?: AbortSignal
	): AsyncGenerator<AgentEvent> {
		const coreBaseUrl =
			this.config.core?.baseUrl ?? env("RYU_CORE_URL") ?? DEFAULT_CORE_URL;
		const coreToken = this.config.core?.token ?? resolveCoreToken();
		const harness = new HarnessAPI({ baseUrl: coreBaseUrl, token: coreToken });
		const consume = this.consumeHarnessRun(harness, runId, signal, after);
		return (async function* () {
			try {
				yield* consume;
			} catch (error) {
				yield { type: "error", message: describeError(error) };
			}
		})();
	}

	/**
	 * Stream loop events (text / tool_call / tool_result / auth_required / …).
	 * When the agent has `handoff()` tools, a handoff hands the conversation to
	 * the target agent inside this same run.
	 */
	stream(
		prompt: string,
		signal?: AbortSignal,
		options: AgentRunOptions = {}
	): AsyncGenerator<AgentEvent> {
		if (this.config.sessionId) {
			return this.streamHarness(prompt, signal, this.config.resumeRunId);
		}
		const transcript: LoopMessage[] = [{ role: "user", content: prompt }];
		if (hasHandoffs(this.config.tools)) {
			return streamWithHandoffs(
				this,
				transcript,
				signal,
				options.approvalHandler
			);
		}
		return this.runLoop(transcript, signal, [], options.approvalHandler);
	}

	/**
	 * Run the SDK-owned loop, first resolving a prompt-registry reference in
	 * `instructions` so every run reads the label's current version.
	 */
	private runLoop(
		transcript: LoopMessage[],
		signal?: AbortSignal,
		middleware?: AgentMiddleware[],
		approvalHandler?: AgentApprovalHandler
	): AsyncGenerator<AgentEvent> {
		const configured = this.config.instructions;
		if (configured === undefined || typeof configured === "string") {
			return runAgentLoop(
				this.buildLoopConfig(
					transcript,
					signal,
					middleware,
					configured,
					approvalHandler
				)
			);
		}
		return this.runResolvedLoop(
			configured,
			transcript,
			signal,
			middleware,
			approvalHandler
		);
	}

	private async *runResolvedLoop(
		reference: PromptInstructions,
		transcript: LoopMessage[],
		signal?: AbortSignal,
		middleware?: AgentMiddleware[],
		approvalHandler?: AgentApprovalHandler
	): AsyncGenerator<AgentEvent> {
		let instructions: string | undefined;
		try {
			instructions = await resolveInstructions(reference);
		} catch (error) {
			yield {
				type: "error",
				message: `instructions prompt could not be resolved: ${describeError(error)}`,
			};
			return;
		}
		yield* runAgentLoop(
			this.buildLoopConfig(
				transcript,
				signal,
				middleware,
				instructions,
				approvalHandler
			)
		);
	}

	/**
	 * Run this agent's own SDK loop over an existing transcript. By default it
	 * does not follow handoffs (multi-agent runners use it to continue a
	 * conversation another agent started); pass `followHandoffs: true` to
	 * continue a conversation the way `stream()` would. `middleware` entries
	 * wrap outside the agent's own.
	 */
	streamMessages(
		messages: LoopMessage[],
		options: AgentRunOptions & {
			followHandoffs?: boolean;
			middleware?: AgentMiddleware[];
			signal?: AbortSignal;
		} = {}
	): AsyncGenerator<AgentEvent> {
		if (this.config.sessionId) {
			return (async function* () {
				yield {
					type: "error" as const,
					message:
						"a sessionId agent runs in Core and cannot continue an SDK transcript",
				};
			})();
		}
		if (options.followHandoffs && hasHandoffs(this.config.tools)) {
			return streamWithHandoffs(
				this,
				messages,
				options.signal,
				options.approvalHandler
			);
		}
		return this.runLoop(
			messages,
			options.signal,
			options.middleware,
			options.approvalHandler
		);
	}

	/**
	 * Expose this agent as a tool another agent can call. The calling agent
	 * sends a task, this agent runs to completion, and its answer (or structured
	 * output) becomes the tool result.
	 */
	asTool(options: AgentAsToolOptions = {}): AgentToolRunnable {
		return agentAsTool(this, options);
	}

	/** Resume a terminal run as a new durable attempt while preserving lineage. */
	resume(
		runId: string,
		prompt: string,
		signal?: AbortSignal
	): AsyncGenerator<AgentEvent> {
		if (!this.config.sessionId) {
			return (async function* () {
				yield {
					type: "error" as const,
					message: "resuming a durable run requires sessionId",
				};
			})();
		}
		return this.streamHarness(prompt, signal, runId);
	}

	/**
	 * Run to completion and return the final text, step count, and usage. With
	 * `outputSchema`, `output` is the validated value; a reply that never
	 * validates (after `maxRepairAttempts`) throws `StructuredOutputError`.
	 */
	async generate(
		prompt: string,
		signal?: AbortSignal
	): Promise<GenerateResult<TOutput>> {
		let text = "";
		let steps = 0;
		let usage: ModelUsage | undefined;
		let authRequired: AgentEventAuthRequired | undefined;
		let approvalRequired: AgentEventApprovalRequested | undefined;
		let output: TOutput | undefined;

		for await (const event of this.stream(prompt, signal)) {
			if (event.type === "result") {
				text = event.text;
				steps = event.steps;
				usage = event.usage;
				// SAFETY: a result only carries `output` after it validated against
				// `this.outputContract`, whose parsed type is `TOutput`.
				output = event.output as TOutput | undefined;
			} else if (event.type === "auth_required") {
				authRequired = event;
			} else if (event.type === "approval_requested") {
				approvalRequired = event;
			} else if (event.type === "error") {
				const message = `[ryu-sdk] agent "${this.config.name}": ${event.message}`;
				if (event.code === STRUCTURED_OUTPUT_ERROR_CODE) {
					throw new StructuredOutputError(message, {
						attempts: event.attempts ?? 1,
						issues: event.issues ?? [],
						text: event.text ?? text,
					});
				}
				throw new Error(message);
			}
		}

		return { text, steps, usage, authRequired, approvalRequired, output };
	}
}

/** Factory alias for `new Agent(config)`. */
export function createAgent<TOutput = unknown>(
	config: AgentConfig<TOutput>
): Agent<TOutput> {
	return new Agent(config);
}
