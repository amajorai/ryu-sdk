/**
 * Tool resolution + execution for the Ryu agent runtime.
 *
 * Two kinds of tool feed the same model `tools[]` array:
 *
 *  - **Local** tools are `ToolRunnable`s from `defineTool` — they run in-process
 *    via their `run(input, ctx)` implementation.
 *  - **Remote** tools are references to existing Ryu tools (e.g.
 *    `composio.GMAIL_SEARCH_EMAILS`) created with `ryuTool(id)`. Their schema is
 *    lazily fetched from Core `GET /api/tools/describe` and they execute through
 *    Core `POST /api/mcp/tools/call`, which enforces the agent's allowlist and
 *    selects the Composio connected-account entity via `user_id`.
 *
 * The model-facing function name is the **config key** the developer chose (e.g.
 * `gmailSearch`), not the raw Composio slug — internals stay hidden and names
 * stay OpenAI-safe.
 */

import { z } from "zod";
import { appToolJsonObjectSchema } from "../runnable/app.ts";
import { primitiveJsonSchema } from "../runnable/primitive-contracts.ts";
import type { RunnableContext } from "../runnable/runnable-types.ts";
import type { ToolRunnable } from "../runnable/tool.ts";
import { type SchemaLike, toJsonSchema } from "../schema/json-schema.ts";
import type { ToolFunctionDef } from "./model-call.ts";

// ── Remote tool reference ─────────────────────────────────────────────────────

/** A reference to an existing Ryu tool, resolved + executed via Core. */
export interface RemoteToolRef {
	/** One-line description shown to the model (overrides Core's describe). */
	description?: string;
	/** Fully-qualified Ryu tool id, e.g. `composio.GMAIL_SEARCH_EMAILS`. */
	id: string;
	readonly kind: "remote";
	/** Pause before dispatching this tool when the caller supplied an approval handler. */
	needsApproval?: boolean;
	/**
	 * JSON Schema for the tool's arguments. Optional: when omitted, a permissive
	 * open-object schema is used (Composio `describe` is shallow), so supplying
	 * this materially improves the model's tool-call accuracy.
	 */
	parameters?: z.output<typeof appToolJsonObjectSchema>;
}

/** Options accepted by `ryuTool`. */
export interface RyuToolOptions {
	description?: string;
	needsApproval?: boolean;
	/**
	 * Argument schema: a JSON Schema object or any Standard Schema validator
	 * that can describe itself as JSON Schema (zod 4, arktype, …). It is
	 * converted to JSON Schema once, here; Core validates the remote call.
	 */
	parameters?: SchemaLike;
}

/**
 * Reference an existing Ryu tool by id so an `Agent` can call it.
 *
 * @example
 * ```ts
 * ryuTool("composio.GMAIL_SEARCH_EMAILS", {
 *   description: "Search the user's Gmail",
 *   parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
 * });
 * // or with a typed schema:
 * ryuTool("composio.GMAIL_SEARCH_EMAILS", { parameters: z.object({ query: z.string() }) });
 * ```
 */
export function ryuTool(id: string, opts: RyuToolOptions = {}): RemoteToolRef {
	return {
		kind: "remote",
		id,
		description: opts.description,
		needsApproval: opts.needsApproval,
		parameters:
			opts.parameters === undefined
				? undefined
				: appToolJsonObjectSchema.parse(toJsonSchema(opts.parameters, "input")),
	};
}

/** A tool an `Agent` can expose to the model: local runnable or remote ref. */
export type AgentTool = RemoteToolRef | ToolRunnable;

/** Narrow to a local `defineTool` runnable. */
function isLocalTool(tool: AgentTool): tool is ToolRunnable {
	return tool.kind === "tool";
}

// ── Execution context ─────────────────────────────────────────────────────────

/** Everything the tool layer needs to resolve schemas + execute calls. */
export interface ToolExecContext {
	/** Core agent id — REQUIRED for remote tools (governs execution). */
	agentId?: string;
	/** Core base URL (no trailing `/api`). */
	coreBaseUrl: string;
	/** Bearer token for Core (`RYU_CORE_TOKEN`, then `RYU_TOKEN`); may be undefined on loopback dev. */
	coreToken?: string;
	/** RunnableContext handed to local tools so they may call the gateway. */
	runnableContext: RunnableContext;
	/** Abort signal. */
	signal?: AbortSignal;
	/** Composio connected-account entity selector. */
	userId?: string;
}

/** Data passed to an SDK-local approval handler. */
export interface AgentApprovalOption {
	kind: string;
	name: string;
	optionId: string;
}

export interface AgentApprovalRequest {
	approvalId: string;
	input: unknown;
	name: string;
	options?: AgentApprovalOption[];
	summary: string;
}

/** Resolve a local/remote SDK tool approval before it executes. */
export type AgentApprovalDecision = boolean | string;

export type AgentApprovalHandler = (
	request: AgentApprovalRequest
) => Promise<AgentApprovalDecision>;

const PERMISSIVE_OBJECT_SCHEMA = {
	type: "object",
	additionalProperties: true,
};

/** Core `/api/tools/describe` response subset we read. */
const describeResponseSchema = z.object({
	description: z.string().nullish(),
	name: z.string().nullish(),
});
const toolCallReplySchema = z.object({
	error: z.string().nullish(),
	ok: z.boolean().nullish(),
	output: primitiveJsonSchema.optional(),
});
const elicitationContract = z
	.object({
		kind: z.string().optional(),
		message: z.string().optional(),
		url: z.string().optional(),
	})
	.passthrough();
const elicitationEnvelopeSchema = z.object({
	__ryu_elicitation__: z.custom<z.output<typeof elicitationContract>>(
		(value) => elicitationContract.safeParse(value).success
	),
});

function normalize(baseUrl: string): string {
	return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function authHeaders(token?: string) {
	const headers = new Headers({ "content-type": "application/json" });
	if (token) {
		headers.set("authorization", `Bearer ${token}`);
	}
	return headers;
}

/**
 * Build the OpenAI `tools[]` array the model sees, keyed by the developer's
 * config names. Remote tools without an explicit `parameters` schema are
 * described from Core (`describe` is shallow) and given a permissive schema.
 */
export async function resolveToolDefs(
	tools: Record<string, AgentTool>,
	ctx: ToolExecContext
): Promise<ToolFunctionDef[]> {
	const defs: ToolFunctionDef[] = [];

	for (const [name, tool] of Object.entries(tools)) {
		if (isLocalTool(tool)) {
			defs.push({
				type: "function",
				function: {
					name,
					description: tool.description ?? tool.name,
					parameters: appToolJsonObjectSchema.parse(tool.schema),
				},
			});
			continue;
		}

		// Remote: prefer an explicit schema; else describe from Core.
		let description = tool.description;
		if (!description) {
			description = await describeRemoteTool(tool.id, ctx);
		}
		defs.push({
			type: "function",
			function: {
				name,
				description: description ?? tool.id,
				parameters: appToolJsonObjectSchema.parse(
					tool.parameters ?? PERMISSIVE_OBJECT_SCHEMA
				),
			},
		});
	}

	return defs;
}

async function describeRemoteTool(
	id: string,
	ctx: ToolExecContext
): Promise<string | undefined> {
	const url = `${normalize(ctx.coreBaseUrl)}/api/tools/describe?id=${encodeURIComponent(id)}`;
	try {
		const res = await fetch(url, {
			headers: authHeaders(ctx.coreToken),
			signal: ctx.signal,
		});
		if (!res.ok) {
			return undefined;
		}
		const json = describeResponseSchema.parse(await res.json());
		return json.description || json.name || undefined;
	} catch {
		// Describe is best-effort — a missing description never blocks the loop.
		return undefined;
	}
}

// ── Execution ─────────────────────────────────────────────────────────────────

/** Result of executing one tool call. */
export interface ToolExecResult {
	/** Raw tool output (already JSON-parsed when the tool returned JSON). */
	output: unknown;
}

/**
 * Execute a single model tool call by config `name`, dispatching to the local
 * runnable or the Core `/api/mcp/tools/call` endpoint.
 *
 * `argsJson` is the raw JSON string from `tool_call.function.arguments`.
 */
export interface RemoteToolCallBody {
	agent_id: string;
	arguments: z.output<typeof primitiveJsonSchema>;
	tool: string;
	user_id?: string;
}

export async function executeTool(
	name: string,
	argsJson: string,
	tools: Record<string, AgentTool>,
	ctx: ToolExecContext
): Promise<ToolExecResult> {
	const tool = tools[name];
	if (!tool) {
		throw new Error(`[ryu-sdk] model called unknown tool "${name}"`);
	}

	const args = parseArgs(argsJson, name);

	if (isLocalTool(tool)) {
		const output = await tool.run(
			appToolJsonObjectSchema.parse(args),
			ctx.runnableContext
		);
		return { output };
	}

	// Remote tool — requires a Core agent id for governance.
	if (!ctx.agentId) {
		throw new Error(
			`[ryu-sdk] remote tool "${name}" (${tool.id}) requires an agentId — ` +
				"set it on the Agent config so Core can govern the call"
		);
	}

	const url = `${normalize(ctx.coreBaseUrl)}/api/mcp/tools/call`;
	const body: RemoteToolCallBody = {
		tool: tool.id,
		arguments: args,
		agent_id: ctx.agentId,
	};
	if (ctx.userId) {
		body.user_id = ctx.userId;
	}
	const res = await fetch(url, {
		method: "POST",
		headers: authHeaders(ctx.coreToken),
		signal: ctx.signal,
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(
			`[ryu-sdk] Core tools/call ${res.status} for "${tool.id}"${text ? `: ${text}` : ""}`
		);
	}

	const json = toolCallReplySchema.parse(await res.json());
	if (json.ok === false) {
		throw new Error(
			`[ryu-sdk] tool "${tool.id}" failed: ${json.error ?? "unknown error"}`
		);
	}
	return { output: json.output };
}

function parseArgs(argsJson: string, name: string) {
	const trimmed = (argsJson ?? "").trim();
	if (trimmed === "") {
		return {};
	}
	try {
		return primitiveJsonSchema.parse(JSON.parse(trimmed));
	} catch {
		throw new Error(
			`[ryu-sdk] tool "${name}" arguments were not valid JSON: ${argsJson}`
		);
	}
}

// ── Elicitation (connection-required) detection ───────────────────────────────

/** The connect-required envelope Core returns when an account isn't linked. */
export interface Elicitation {
	kind?: string;
	message?: string;
	url?: string;
}

/**
 * Detect Ryu's connection-required envelope in a tool output. Mirrors Core's
 * `detect_elicitation` (apps/core/src/sidecar/mcp/composio.rs): the first Gmail
 * call for an unconnected account returns `{ "__ryu_elicitation__": { url } }`.
 */
export function detectElicitation(
	output: Parameters<typeof elicitationEnvelopeSchema.safeParse>[0]
): Elicitation | null {
	const parsed = elicitationEnvelopeSchema.safeParse(output);
	return parsed.success ? parsed.data.__ryu_elicitation__ : null;
}
