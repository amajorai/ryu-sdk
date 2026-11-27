/**
 * `createRyuServer` — serve SDK agents, workflows, and tools over HTTP.
 *
 * The server is a single Web-standard `fetch(request) => Response` handler, so
 * one object runs under Node (`serve` from `@ryuhq/sdk/server/node`), Bun,
 * Deno, Cloudflare Workers, Vercel, and Netlify, and mounts inside an existing
 * Hono app with `app.all("/api/*", (c) => server.fetch(c.req.raw))`.
 *
 * Routes (under `basePath`, default `/api`):
 *
 *   GET  /                                  registered resources
 *   GET  /openapi.json                      OpenAPI 3.1 document
 *   GET  /agents · /agents/:id
 *   POST /agents/:id/generate               run to completion (JSON)
 *   POST /agents/:id/stream                 run and stream events (SSE)
 *   POST /approvals/:approvalId             approve or deny a paused tool call
 *   GET  /workflows · /workflows/:id        includes the step graph
 *   POST /workflows/:id/start               run (JSON outcome)
 *   POST /workflows/:id/stream              run and stream chunks (SSE)
 *   GET  /workflows/:id/runs · /runs/:runId run history and traces
 *   POST /workflows/:id/runs/:runId/resume  resume a suspended run (+ /stream)
 *   POST /workflows/:id/runs/:runId/cancel
 *   GET  /tools · /tools/:id
 *   POST /tools/:id/execute
 *   GET  /traces · /traces/:runId           local run traces
 */

import { z } from "zod";
import type { Agent } from "../agent/agent.ts";
import type { AgentEvent } from "../agent/loop.ts";
import type { LoopMessage } from "../agent/model-call.ts";
import type { AgentNetwork, NetworkEvent } from "../agent/network.ts";
import type { AgentApprovalHandler } from "../agent/tools.ts";
import { defineModel } from "../model/client.ts";
import type { RunnableContext } from "../runnable/runnable-types.ts";
import type { ToolInput, ToolRunnable } from "../runnable/tool.ts";
import type { StandardSchemaV1 } from "../schema/standard-schema.ts";
import type {
	StreamMode,
	WorkflowResult,
	WorkflowRun,
} from "../workflow/executor.ts";
import type { CreateRunOptions, Stage } from "../workflow/workflow.ts";
import { ApprovalRegistry } from "./approvals.ts";
import { workflowGraph } from "./graph.ts";
import {
	describe,
	errorResponse,
	HttpError,
	json,
	type RouteParams,
	Router,
	readJsonBody,
	requireJsonContentType,
	type SseSink,
	sseResponse,
} from "./http.ts";
import {
	buildOpenApiDocument,
	describeSchema,
	type OpenApiDocument,
} from "./openapi.ts";
import {
	createMemoryRunStore,
	type RunKind,
	type RunRecord,
	RunRecorder,
	type RunStore,
} from "./runs.ts";
import { STUDIO_BASE_PATH_PLACEHOLDER, STUDIO_HTML } from "./studio.ts";

// ── Public types ──────────────────────────────────────────────────────────────

/** An agent the server can run: a single `Agent` or an `AgentNetwork`. */
export type ServerAgent = Agent<unknown> | AgentNetwork;

/** A committed workflow (`createWorkflow(...).commit()`). */
export interface ServerWorkflow {
	createRun(options?: CreateRunOptions): WorkflowRun<unknown, unknown>;
	readonly description?: string;
	readonly id: string;
	readonly inputSchema?: StandardSchemaV1<unknown, unknown>;
	readonly kind: "workflow";
	readonly name: string;
	readonly stages: readonly Stage[];
}

/** A local tool (`defineTool`). */
export type ServerTool = ToolRunnable<ToolInput, unknown>;

/**
 * Decide whether a request may proceed. Return `true` to allow, `false` to
 * reject with 401, or a `Response` to send instead.
 */
export type AuthHook = (
	request: Request
) => boolean | Promise<boolean | Response> | Response;

/** Configuration for {@link createRyuServer}. */
export interface RyuServerConfig {
	/** Agents keyed by route id (`/agents/:id`). */
	agents?: Record<string, ServerAgent>;
	/**
	 * Let `POST /tools/:id/execute` run tools marked `needsApproval` directly,
	 * with no human decision. Off by default (such calls get 403
	 * `approval_required`); the local dev studio, where the person at the
	 * keyboard is the approver, turns it on unless this is set to `false`.
	 */
	allowDirectApprovalTools?: boolean;
	/** How long a tool approval may wait for a decision (default 10 minutes). */
	approvalTimeoutMs?: number;
	/** Guard every API route (the studio page itself is static and unguarded). */
	auth?: AuthHook;
	/** Path prefix for the API (default `/api`). */
	basePath?: string;
	/** OpenAPI `info` block. */
	info?: { description?: string; title?: string; version?: string };
	/** Run history / trace persistence (default: in memory, 200 runs). */
	runStore?: RunStore;
	/**
	 * Context handed to tools and workflow steps. Defaults to a gateway client
	 * for `RYU_MODEL` (or `default`) at the node's gateway, built on first use.
	 */
	runtime?: () => RunnableContext;
	/** Serve the browser studio at `/` and `/studio` (used by `ryu dev --studio`). */
	studio?: boolean;
	/** Tools keyed by route id (`/tools/:id`). */
	tools?: Record<string, ServerTool>;
	/** Workflows keyed by route id (`/workflows/:id`). */
	workflows?: Record<string, ServerWorkflow>;
}

/** A running server definition. */
export interface RyuServer {
	/** The normalized base path, e.g. `/api`. */
	readonly basePath: string;
	readonly config: RyuServerConfig;
	/** Handle one request. */
	fetch(request: Request): Promise<Response>;
	/** The OpenAPI 3.1 document for the registered resources. */
	openapi(): OpenApiDocument;
}

// ── Request contracts ─────────────────────────────────────────────────────────

const toolCallSchema = z.object({
	id: z.string(),
	type: z.literal("function"),
	function: z.object({ name: z.string(), arguments: z.string() }),
});

const loopMessageSchema = z.union([
	z.object({
		role: z.enum(["system", "user"]),
		content: z.string(),
	}),
	z.object({
		role: z.literal("assistant"),
		content: z.string().nullable(),
		tool_calls: z.array(toolCallSchema).optional(),
	}),
	z.object({
		role: z.literal("tool"),
		content: z.string(),
		tool_call_id: z.string(),
	}),
]);

const agentRequestSchema = z
	.object({
		prompt: z.string().min(1).optional(),
		messages: z.array(loopMessageSchema).min(1).optional(),
	})
	.refine(
		(body) => (body.prompt === undefined) !== (body.messages === undefined),
		{
			message: "send exactly one of `prompt` or `messages`",
		}
	);

const approvalDecisionSchema = z
	.object({
		approved: z.boolean().optional(),
		optionId: z.string().min(1).optional(),
	})
	.refine((body) => body.approved !== undefined || body.optionId, {
		message: "send `approved` or `optionId`",
	});

const streamModeSchema = z.enum(["events", "updates", "values"]);

const workflowStartSchema = z.object({
	inputData: z.unknown().optional(),
	initialState: z.record(z.string(), z.unknown()).optional(),
	runId: z.string().min(1).max(200).optional(),
	streamMode: z
		.union([streamModeSchema, z.array(streamModeSchema).min(1)])
		.optional(),
});

const workflowResumeSchema = z.object({
	resumeData: z.unknown().optional(),
	step: z.string().min(1).optional(),
	streamMode: z
		.union([streamModeSchema, z.array(streamModeSchema).min(1)])
		.optional(),
});

const toolExecuteSchema = z.object({
	input: z.record(z.string(), z.unknown()).default(() => ({})),
});

const traceQuerySchema = z.object({
	kind: z.enum(["agent", "tool", "workflow"]).optional(),
	target: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(500).optional(),
});

async function parseBody<T>(
	request: Request,
	schema: z.ZodType<T>
): Promise<T> {
	const parsed = schema.safeParse(await readJsonBody(request));
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
		throw new HttpError(
			400,
			"invalid_request",
			`${where}${issue?.message ?? "invalid request body"}`
		);
	}
	return parsed.data;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeBasePath(basePath: string | undefined): string {
	const trimmed = (basePath ?? "/api").trim().replace(/\/+$/, "");
	if (trimmed === "") {
		return "";
	}
	return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function env(key: string): string | undefined {
	const value = globalThis.process?.env?.[key];
	return value && value !== "" ? value : undefined;
}

/** The default tool/step context: a lazily built gateway client. */
function defaultRuntime(): RunnableContext {
	let client: ReturnType<typeof defineModel> | undefined;
	const get = () => {
		client ??= defineModel(env("RYU_MODEL") ?? "default");
		return client;
	};
	return {
		gateway: {
			chat: (messages) => get().chat(messages),
			stream: (messages) => get().stream(messages),
		},
	};
}

function lookup<T>(
	registry: Record<string, T> | undefined,
	id: string,
	kind: string
): T {
	const value =
		registry && Object.hasOwn(registry, id) ? registry[id] : undefined;
	if (value === undefined) {
		throw new HttpError(404, "not_found", `${kind} "${id}" is not registered`);
	}
	return value;
}

/**
 * Duck-typed so a network built against another copy of the SDK (the CLI's
 * bundle vs. the project's install) is still recognized.
 */
function isNetwork(agent: ServerAgent): agent is AgentNetwork {
	return "entry" in agent && "agents" in agent && !("config" in agent);
}

function agentSummary(id: string, agent: ServerAgent) {
	if (isNetwork(agent)) {
		return {
			id,
			kind: "network" as const,
			name: agent.name,
			description: agent.description,
			entry: agent.entry.config.name,
			members: agent.agents.map((member) => member.config.name),
		};
	}
	const tools = Object.entries(agent.config.tools ?? {}).map(
		([name, tool]) => ({
			name,
			kind: tool.kind === "remote" ? "remote" : "local",
			id: tool.id,
			description: tool.description,
			needsApproval: tool.needsApproval === true,
		})
	);
	return {
		id,
		kind: "agent" as const,
		name: agent.config.name,
		description: agent.config.description,
		model: agent.config.model,
		instructions: agent.config.instructions,
		structuredOutput: agent.config.outputSchema !== undefined,
		tools,
	};
}

function workflowSummary(id: string, workflow: ServerWorkflow) {
	return {
		id,
		workflowId: workflow.id,
		name: workflow.name,
		description: workflow.description,
		inputSchema: describeSchema(workflow.inputSchema),
		graph: workflowGraph(workflow),
	};
}

function toolSummary(id: string, tool: ServerTool) {
	return {
		id,
		toolId: tool.id,
		name: tool.name,
		description: tool.description,
		needsApproval: tool.needsApproval === true,
		schema: tool.schema,
	};
}

function traceSummary(record: RunRecord) {
	const { events, snapshot: _snapshot, ...rest } = record;
	return { ...rest, eventCount: events.length };
}

type AnyAgentEvent = AgentEvent | NetworkEvent;

type SerializedWorkflowResult = {
	runId: string;
	state: Record<string, unknown>;
	status: WorkflowResult<unknown>["status"];
	steps: WorkflowResult<unknown>["steps"];
} & (
	| { result: unknown; status: "success" }
	| { status: "suspended"; suspended: unknown }
	| { error: string; status: "failed" }
);

function serializeWorkflowResult(
	runId: string,
	result: WorkflowResult<unknown>
): SerializedWorkflowResult {
	const base = { runId, state: result.state, steps: result.steps };
	switch (result.status) {
		case "success":
			return { ...base, status: "success", result: result.result };
		case "suspended":
			return { ...base, status: "suspended", suspended: result.suspended };
		case "failed":
			return { ...base, status: "failed", error: result.error.message };
		default:
			return result satisfies never;
	}
}

// ── createRyuServer ───────────────────────────────────────────────────────────

/**
 * Create an HTTP server for SDK agents, workflows, and tools.
 *
 * @example
 * ```ts
 * import { createRyuServer } from "@ryuhq/sdk/server";
 * import { serve } from "@ryuhq/sdk/server/node";
 *
 * const server = createRyuServer({
 *   agents: { support },
 *   workflows: { triage },
 *   tools: { weather },
 *   auth: bearerAuth(process.env.API_TOKEN),
 * });
 * await serve({ fetch: server.fetch, port: 3000 });
 * ```
 */
export function createRyuServer(config: RyuServerConfig = {}): RyuServer {
	const basePath = normalizeBasePath(config.basePath);
	const store = config.runStore ?? createMemoryRunStore();
	const runtime = config.runtime ?? defaultRuntime;
	const approvals = new ApprovalRegistry(config.approvalTimeoutMs);
	const liveWorkflowRuns = new Map<string, WorkflowRun<unknown, unknown>>();
	const router = new Router();

	const openapi = (): OpenApiDocument =>
		buildOpenApiDocument({
			basePath,
			secured: config.auth !== undefined,
			info: {
				title: config.info?.title ?? "Ryu server",
				version: config.info?.version ?? "1.0.0",
				description: config.info?.description,
			},
			agents: Object.entries(config.agents ?? {}).map(([id, agent]) => ({
				id,
				name: isNetwork(agent) ? agent.name : agent.config.name,
				description: isNetwork(agent)
					? agent.description
					: agent.config.description,
			})),
			workflows: Object.entries(config.workflows ?? {}).map(([id, wf]) => ({
				id,
				name: wf.name,
				description: wf.description,
				inputSchema: wf.inputSchema,
			})),
			tools: Object.entries(config.tools ?? {}).map(([id, tool]) => ({
				id,
				name: tool.name,
				description: tool.description,
				schema: tool.schema,
			})),
		});

	// ── agents ────────────────────────────────────────────────────────────────

	function agentEvents(
		agent: ServerAgent,
		body: z.output<typeof agentRequestSchema>,
		signal: AbortSignal,
		approvalHandler?: AgentApprovalHandler
	): AsyncGenerator<AnyAgentEvent> {
		const input: string | LoopMessage[] =
			body.messages ?? (body.prompt as string);
		// The handler only answers for agents without one of their own, and it
		// reaches every member of a network and every handoff target.
		const options = { approvalHandler };
		if (isNetwork(agent)) {
			return agent.stream(input, signal, options);
		}
		if (typeof input === "string") {
			return agent.stream(input, signal, options);
		}
		return agent.streamMessages(input, {
			...options,
			followHandoffs: true,
			signal,
		});
	}

	function recordAgentEvent(recorder: RunRecorder, event: AnyAgentEvent): void {
		recorder.event(event.type, event);
	}

	async function finishAgentRun(
		recorder: RunRecorder,
		outcome: {
			error?: string;
			paused: boolean;
			result?: Extract<AnyAgentEvent, { type: "result" }>;
		}
	): Promise<"failed" | "paused" | "success"> {
		if (outcome.error !== undefined) {
			await recorder.finish("failed", { error: outcome.error });
			return "failed";
		}
		if (outcome.result) {
			await recorder.finish("success", {
				output: {
					text: outcome.result.text,
					output: outcome.result.output,
					steps: outcome.result.steps,
					usage: outcome.result.usage,
				},
			});
			return "success";
		}
		await recorder.finish(outcome.paused ? "paused" : "failed", {
			error: outcome.paused ? undefined : "run ended without a result",
		});
		return outcome.paused ? "paused" : "failed";
	}

	router.add("GET", "/agents", () =>
		json({
			agents: Object.entries(config.agents ?? {}).map(([id, agent]) =>
				agentSummary(id, agent)
			),
		})
	);
	router.add("GET", "/agents/:id", (_request, params) =>
		json(
			agentSummary(
				params.id ?? "",
				lookup(config.agents, params.id ?? "", "agent")
			)
		)
	);

	router.add("POST", "/agents/:id/generate", async (request, params) => {
		const id = params.id ?? "";
		const agent = lookup(config.agents, id, "agent");
		const body = await parseBody(request, agentRequestSchema);
		const recorder = new RunRecorder(store, {
			kind: "agent",
			target: id,
			input: body,
		});
		await recorder.save();
		let result: Extract<AnyAgentEvent, { type: "result" }> | undefined;
		let error: string | undefined;
		let approvalRequired: AnyAgentEvent | undefined;
		let authRequired: AnyAgentEvent | undefined;
		try {
			for await (const event of agentEvents(agent, body, request.signal)) {
				recordAgentEvent(recorder, event);
				if (event.type === "result") {
					result = event;
				} else if (event.type === "error") {
					error = event.message;
				} else if (event.type === "approval_requested") {
					approvalRequired = event;
				} else if (event.type === "auth_required") {
					authRequired = event;
				}
			}
		} catch (thrown) {
			error = describe(thrown);
		}
		const status = await finishAgentRun(recorder, {
			error,
			result,
			paused: approvalRequired !== undefined || authRequired !== undefined,
		});
		if (status === "failed") {
			return json(
				{
					runId: recorder.record.id,
					error: {
						code: "run_failed",
						message: error ?? "run ended without a result",
					},
				},
				500
			);
		}
		return json({
			runId: recorder.record.id,
			status,
			text: result?.text ?? "",
			steps: result?.steps ?? 0,
			usage: result?.usage,
			output: result?.output,
			agent: result && "agent" in result ? result.agent : undefined,
			approvalRequired,
			authRequired,
		});
	});

	router.add("POST", "/agents/:id/stream", async (request, params) => {
		const id = params.id ?? "";
		const agent = lookup(config.agents, id, "agent");
		const body = await parseBody(request, agentRequestSchema);
		const recorder = new RunRecorder(store, {
			kind: "agent",
			target: id,
			input: body,
		});
		await recorder.save();
		const runId = recorder.record.id;
		return sseResponse(async (sink: SseSink, signal) => {
			sink.send("run", { runId, agent: id });
			let result: Extract<AnyAgentEvent, { type: "result" }> | undefined;
			let error: string | undefined;
			let paused = false;
			const handler = approvals.handlerFor(runId, signal);
			try {
				for await (const event of agentEvents(agent, body, signal, handler)) {
					recordAgentEvent(recorder, event);
					sink.send(event.type, event);
					if (event.type === "result") {
						result = event;
					} else if (event.type === "error") {
						error = event.message;
					} else if (
						event.type === "approval_requested" ||
						event.type === "auth_required"
					) {
						paused = true;
					}
				}
			} catch (thrown) {
				error = describe(thrown);
				sink.send("error", { type: "error", message: error });
			}
			const status = await finishAgentRun(recorder, {
				error,
				result,
				paused: paused && !result,
			});
			sink.send("done", { runId, status });
		}, request.signal);
	});

	router.add("POST", "/approvals/:approvalId", async (request, params) => {
		const body = await parseBody(request, approvalDecisionSchema);
		const decision = body.optionId ?? body.approved === true;
		if (!approvals.decide(params.approvalId ?? "", decision)) {
			throw new HttpError(
				404,
				"not_found",
				`approval "${params.approvalId}" is not pending`
			);
		}
		return json({ approvalId: params.approvalId, decided: true });
	});

	// ── workflows ─────────────────────────────────────────────────────────────

	function watchRun(
		run: WorkflowRun<unknown, unknown>,
		recorder: RunRecorder
	): () => void {
		return run.watch((event) => {
			recorder.event(event.type, event);
		});
	}

	async function settleWorkflowRun(
		run: WorkflowRun<unknown, unknown>,
		recorder: RunRecorder,
		result: WorkflowResult<unknown>
	): Promise<SerializedWorkflowResult> {
		const serialized = serializeWorkflowResult(run.runId, result);
		// A suspended run resumes from its stored snapshot, so the live object is
		// only needed while it executes (for cancel).
		liveWorkflowRuns.delete(run.runId);
		await recorder.finish(result.status, {
			output: result.status === "success" ? result.result : undefined,
			error: result.status === "failed" ? result.error.message : undefined,
			snapshot: run.snapshot(),
		});
		return serialized;
	}

	/** A prepared workflow run, plus how to undo the preparation if it never begins. */
	interface PreparedWorkflowRun {
		/** Called when `start`/`resume` refuses to begin (unknown step, busy run). */
		abandon(): Promise<void>;
		recorder: RunRecorder;
		run: WorkflowRun<unknown, unknown>;
	}

	async function prepareWorkflowStart(
		id: string,
		body: z.output<typeof workflowStartSchema>
	): Promise<PreparedWorkflowRun> {
		const workflow = lookup(config.workflows, id, "workflow");
		if (body.runId && (await store.get(body.runId))) {
			throw new HttpError(
				409,
				"conflict",
				`run "${body.runId}" already exists`
			);
		}
		const run = workflow.createRun({ runId: body.runId, runtime: runtime() });
		const recorder = new RunRecorder(store, {
			id: run.runId,
			kind: "workflow",
			target: id,
			input: body.inputData,
		});
		await recorder.save();
		liveWorkflowRuns.set(run.runId, run);
		return {
			run,
			recorder,
			async abandon() {
				liveWorkflowRuns.delete(run.runId);
				await recorder.finish("failed", { error: "run did not start" });
			},
		};
	}

	async function prepareWorkflowResume(
		id: string,
		runId: string
	): Promise<PreparedWorkflowRun> {
		const workflow = lookup(config.workflows, id, "workflow");
		const record = await store.get(runId);
		if (!(record?.kind === "workflow" && record.target === id)) {
			throw new HttpError(404, "not_found", `run "${runId}" was not found`);
		}
		if (record.status !== "suspended" || liveWorkflowRuns.has(runId)) {
			throw new HttpError(
				409,
				"conflict",
				`run "${runId}" is ${record.status === "suspended" ? "already resuming" : record.status}, not suspended`
			);
		}
		if (!record.snapshot) {
			throw new HttpError(
				409,
				"conflict",
				`run "${runId}" has no snapshot to resume from`
			);
		}
		const run = workflow.createRun({
			snapshot: record.snapshot,
			runtime: runtime(),
		});
		const suspended = { ...record };
		const recorder = RunRecorder.resume(store, record);
		// Claim the run before it executes, so a second resume (here or on
		// another instance sharing the store) sees it as running.
		liveWorkflowRuns.set(runId, run);
		await recorder.save();
		return {
			run,
			recorder,
			async abandon() {
				liveWorkflowRuns.delete(runId);
				await store.save(suspended);
			},
		};
	}

	function streamWorkflow(
		request: Request,
		prepared: PreparedWorkflowRun,
		begin: () => {
			[Symbol.asyncIterator](): AsyncIterator<{
				data: unknown;
				mode: StreamMode;
			}>;
			readonly result: Promise<WorkflowResult<unknown>>;
		}
	): Promise<Response> {
		const { run, recorder } = prepared;
		const unwatch = watchRun(run, recorder);
		let stream: ReturnType<typeof begin>;
		try {
			stream = begin();
		} catch (thrown) {
			unwatch();
			// Misuse (unknown step, busy run) leaves the run as it was.
			return prepared.abandon().then(() => {
				throw new HttpError(409, "conflict", describe(thrown));
			});
		}
		return Promise.resolve(
			sseResponse(async (sink) => {
				sink.send("run", { runId: run.runId });
				try {
					for await (const chunk of stream) {
						sink.send(chunk.mode, chunk.data);
					}
				} finally {
					// The run keeps going if the client disconnects; record its end.
					const result = await stream.result;
					unwatch();
					const settled = await settleWorkflowRun(run, recorder, result);
					sink.send("result", settled);
					sink.send("done", { runId: run.runId, status: result.status });
				}
			}, request.signal)
		);
	}

	async function runWorkflowOnce(
		prepared: PreparedWorkflowRun,
		begin: () => Promise<WorkflowResult<unknown>>
	): Promise<Response> {
		const { run, recorder } = prepared;
		const unwatch = watchRun(run, recorder);
		try {
			let started: Promise<WorkflowResult<unknown>>;
			try {
				started = begin();
			} catch (thrown) {
				// `start`/`resume` throw synchronously for misuse (unknown step,
				// busy run); the run is left as it was.
				await prepared.abandon();
				throw new HttpError(409, "conflict", describe(thrown));
			}
			return json(await settleWorkflowRun(run, recorder, await started));
		} finally {
			unwatch();
		}
	}

	router.add("GET", "/workflows", () =>
		json({
			workflows: Object.entries(config.workflows ?? {}).map(([id, wf]) =>
				workflowSummary(id, wf)
			),
		})
	);
	router.add("GET", "/workflows/:id", (_request, params) =>
		json(
			workflowSummary(
				params.id ?? "",
				lookup(config.workflows, params.id ?? "", "workflow")
			)
		)
	);
	router.add("POST", "/workflows/:id/start", async (request, params) => {
		const id = params.id ?? "";
		const body = await parseBody(request, workflowStartSchema);
		const prepared = await prepareWorkflowStart(id, body);
		return runWorkflowOnce(prepared, () =>
			prepared.run.start({
				inputData: body.inputData,
				initialState: body.initialState,
			})
		);
	});
	router.add("POST", "/workflows/:id/stream", async (request, params) => {
		const id = params.id ?? "";
		const body = await parseBody(request, workflowStartSchema);
		const prepared = await prepareWorkflowStart(id, body);
		return streamWorkflow(request, prepared, () =>
			prepared.run.stream({
				inputData: body.inputData,
				initialState: body.initialState,
				streamMode: body.streamMode,
			})
		);
	});
	router.add("GET", "/workflows/:id/runs", async (_request, params, url) => {
		const id = params.id ?? "";
		lookup(config.workflows, id, "workflow");
		const query = traceQuerySchema.parse(Object.fromEntries(url.searchParams));
		const runs = await store.list({
			kind: "workflow",
			target: id,
			limit: query.limit,
		});
		return json({ runs: runs.map(traceSummary) });
	});
	router.add("GET", "/workflows/:id/runs/:runId", async (_request, params) => {
		const id = params.id ?? "";
		lookup(config.workflows, id, "workflow");
		const record = await store.get(params.runId ?? "");
		if (!(record?.kind === "workflow" && record.target === id)) {
			throw new HttpError(
				404,
				"not_found",
				`run "${params.runId}" was not found`
			);
		}
		return json(record);
	});
	router.add(
		"POST",
		"/workflows/:id/runs/:runId/resume",
		async (request, params) => {
			const body = await parseBody(request, workflowResumeSchema);
			const prepared = await prepareWorkflowResume(
				params.id ?? "",
				params.runId ?? ""
			);
			return runWorkflowOnce(prepared, () =>
				prepared.run.resume({ resumeData: body.resumeData, step: body.step })
			);
		}
	);
	router.add(
		"POST",
		"/workflows/:id/runs/:runId/resume/stream",
		async (request, params) => {
			const body = await parseBody(request, workflowResumeSchema);
			const prepared = await prepareWorkflowResume(
				params.id ?? "",
				params.runId ?? ""
			);
			return streamWorkflow(request, prepared, () =>
				prepared.run.resumeStream({
					resumeData: body.resumeData,
					step: body.step,
					streamMode: body.streamMode,
				})
			);
		}
	);
	router.add(
		"POST",
		"/workflows/:id/runs/:runId/cancel",
		(_request, params) => {
			lookup(config.workflows, params.id ?? "", "workflow");
			const run = liveWorkflowRuns.get(params.runId ?? "");
			if (run?.status !== "running") {
				throw new HttpError(
					409,
					"conflict",
					`run "${params.runId}" is not running`
				);
			}
			run.cancel();
			return json({ runId: run.runId, cancelled: true });
		}
	);

	// ── tools ─────────────────────────────────────────────────────────────────

	router.add("GET", "/tools", () =>
		json({
			tools: Object.entries(config.tools ?? {}).map(([id, tool]) =>
				toolSummary(id, tool)
			),
		})
	);
	router.add("GET", "/tools/:id", (_request, params) =>
		json(
			toolSummary(
				params.id ?? "",
				lookup(config.tools, params.id ?? "", "tool")
			)
		)
	);
	router.add("POST", "/tools/:id/execute", async (request, params) => {
		const id = params.id ?? "";
		const tool = lookup(config.tools, id, "tool");
		if (
			tool.needsApproval === true &&
			!(config.allowDirectApprovalTools ?? config.studio === true)
		) {
			throw new HttpError(
				403,
				"approval_required",
				`tool "${id}" needs approval; run it through an agent so a person can approve the call`
			);
		}
		const body = await parseBody(request, toolExecuteSchema);
		const recorder = new RunRecorder(store, {
			kind: "tool",
			target: id,
			input: body.input,
		});
		try {
			const output = await tool.run(body.input, {
				...runtime(),
				signal: request.signal,
			});
			recorder.event("tool_result", { output });
			await recorder.finish("success", { output });
			return json({ runId: recorder.record.id, output });
		} catch (thrown) {
			const message = describe(thrown);
			recorder.event("error", { message });
			await recorder.finish("failed", { error: message });
			return json(
				{
					runId: recorder.record.id,
					error: { code: "tool_failed", message },
				},
				422
			);
		}
	});

	// ── traces + meta ─────────────────────────────────────────────────────────

	router.add("GET", "/traces", async (_request, _params, url) => {
		const query = traceQuerySchema.safeParse(
			Object.fromEntries(url.searchParams)
		);
		if (!query.success) {
			throw new HttpError(400, "invalid_request", "invalid trace filter");
		}
		const runs = await store.list({
			kind: query.data.kind as RunKind | undefined,
			target: query.data.target,
			limit: query.data.limit,
		});
		return json({ runs: runs.map(traceSummary) });
	});
	router.add("GET", "/traces/:runId", async (_request, params) => {
		const record = await store.get(params.runId ?? "");
		if (!record) {
			throw new HttpError(
				404,
				"not_found",
				`run "${params.runId}" was not found`
			);
		}
		return json({
			...record,
			pendingApprovals: approvals.pendingIds(record.id),
		});
	});
	router.add("GET", "/openapi.json", () => json(openapi()));
	router.add("GET", "/", () =>
		json({
			name: config.info?.title ?? "Ryu server",
			basePath,
			agents: Object.keys(config.agents ?? {}),
			workflows: Object.keys(config.workflows ?? {}),
			tools: Object.keys(config.tools ?? {}),
			openapi: `${basePath}/openapi.json`,
		})
	);

	async function handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		if (
			config.studio &&
			request.method === "GET" &&
			(path === "/" || path === "/studio" || path === "/studio/")
		) {
			return new Response(
				STUDIO_HTML.replace(STUDIO_BASE_PATH_PLACEHOLDER, () =>
					JSON.stringify(basePath).replaceAll("<", "\\u003c")
				),
				{
					headers: {
						"content-type": "text/html; charset=utf-8",
						"content-security-policy":
							"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
					},
				}
			);
		}

		let rel: string;
		if (basePath === "") {
			rel = path;
		} else if (path === basePath || path.startsWith(`${basePath}/`)) {
			rel = path.slice(basePath.length) || "/";
		} else {
			return errorResponse(404, "not_found", `no route for ${path}`);
		}

		requireJsonContentType(request);

		if (config.auth) {
			const verdict = await config.auth(request);
			if (verdict instanceof Response) {
				return verdict;
			}
			if (verdict !== true) {
				return errorResponse(401, "unauthorized", "authentication required");
			}
		}

		const match = router.match(request.method, rel);
		if (match === "method_not_allowed") {
			return errorResponse(
				405,
				"method_not_allowed",
				`${request.method} is not allowed on ${path}`
			);
		}
		if (!match) {
			return errorResponse(404, "not_found", `no route for ${path}`);
		}
		return await match.handler(request, match.params as RouteParams, url);
	}

	return {
		basePath,
		config,
		openapi,
		async fetch(request: Request): Promise<Response> {
			try {
				return await handle(request);
			} catch (error) {
				if (error instanceof HttpError) {
					return errorResponse(error.status, error.code, error.message);
				}
				return errorResponse(500, "internal_error", describe(error));
			}
		},
	};
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

function constantTimeEqual(a: string, b: string): boolean {
	const left = new TextEncoder().encode(a);
	const right = new TextEncoder().encode(b);
	let diff = left.length ^ right.length;
	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index++) {
		diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
	}
	return diff === 0;
}

/**
 * An {@link AuthHook} that accepts `Authorization: Bearer <token>`. Throws at
 * construction when the token is empty, so a missing secret never silently
 * opens the API.
 */
export function bearerAuth(token: string | undefined): AuthHook {
	if (!token) {
		throw new Error(
			"[ryu-sdk] bearerAuth needs a non-empty token (set it from your deployment's secret store)"
		);
	}
	return (request) => {
		const header = request.headers.get("authorization") ?? "";
		const match = /^Bearer\s+(.+)$/i.exec(header);
		return match?.[1] !== undefined && constantTimeEqual(match[1], token);
	};
}

// ── Project modules ───────────────────────────────────────────────────────────

const projectModuleSchema = z.object({
	default: z.unknown().optional(),
	agents: z.unknown().optional(),
	workflows: z.unknown().optional(),
	tools: z.unknown().optional(),
	server: z.unknown().optional(),
});

function isServer(value: unknown): value is RyuServer {
	return (
		typeof value === "object" &&
		value !== null &&
		"fetch" in value &&
		typeof value.fetch === "function" &&
		"config" in value
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve a project entry module into a server. The module may export:
 *
 *   - `default` (or `server`): a `createRyuServer(...)` result, or
 *   - `default`: a {@link RyuServerConfig} object, or
 *   - named `agents` / `workflows` / `tools` records.
 *
 * `overrides` are merged over the resolved config (the dev studio sets
 * `studio: true`).
 */
export function resolveRyuServer(
	moduleValue: unknown,
	overrides: Partial<RyuServerConfig> = {}
): RyuServer {
	const mod = projectModuleSchema.parse(moduleValue);
	const candidate = mod.server ?? mod.default;
	let config: RyuServerConfig;
	if (isServer(candidate)) {
		if (Object.keys(overrides).length === 0) {
			return candidate;
		}
		config = candidate.config;
	} else if (isRecord(candidate)) {
		config = candidate as RyuServerConfig;
	} else if (mod.agents || mod.workflows || mod.tools) {
		config = {
			agents: mod.agents as RyuServerConfig["agents"],
			workflows: mod.workflows as RyuServerConfig["workflows"],
			tools: mod.tools as RyuServerConfig["tools"],
		};
	} else {
		throw new Error(
			"[ryu-sdk] the project entry must export a server (createRyuServer), a server config as default, or named `agents` / `workflows` / `tools`"
		);
	}
	return createRyuServer({ ...config, ...overrides });
}

/** Environment variable that explicitly opts a deployed server out of auth. */
export const PUBLIC_SERVER_ENV = "RYU_SERVER_PUBLIC";

function deployEnv(name: string): string | undefined {
	return typeof process === "undefined" ? undefined : process.env?.[name];
}

/**
 * Resolve a project entry for a production deployment (`ryu build`). Unlike
 * {@link resolveRyuServer}, this fails closed: a server with no `auth` hook
 * would let anyone who can reach it run agents (spending the deployer's
 * gateway budget) and tools, so it refuses to start unless the deployment sets
 * `RYU_SERVER_PUBLIC=1` to say the API is meant to be open.
 */
export function resolveDeployedServer(moduleValue: unknown): RyuServer {
	const server = resolveRyuServer(moduleValue);
	const optedOut = ["1", "true"].includes(
		(deployEnv(PUBLIC_SERVER_ENV) ?? "").toLowerCase()
	);
	if (server.config.auth === undefined && !optedOut) {
		throw new Error(
			`[ryu-sdk] refusing to start without authentication: export a server with \`auth: bearerAuth(process.env.RYU_SERVER_TOKEN)\`, or set ${PUBLIC_SERVER_ENV}=1 if the API is meant to be public`
		);
	}
	return server;
}
