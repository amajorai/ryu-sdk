/**
 * SDK MCP stdio server — exposes a set of SDK Runnables (and optional
 * passthrough registrations from Ghost / Shadow) as MCP tools over stdio,
 * so any MCP host can discover and call them.
 *
 * The server speaks the same JSON-RPC 2.0 / newline-delimited protocol as
 * `apps/core/src/sidecar/mcp/client.rs` and as `client.ts` in this package.
 *
 * POLICY NOTE: this server does NOT implement tool-approval, permission grants,
 * or any Gateway-level policy.  Approval stays in the chat layer; policy stays
 * in the Gateway (per issue #86).  Callers must not route policy decisions
 * through this server.
 *
 * ## Minimal Runnable contract
 *
 * The full `defineAgent / defineWorkflow / defineTool / defineSkill` authoring
 * API is delivered by issue #205.  This unit only needs the *consume side*:
 * an executable object with a name and a `run()` method.  Once #205 ships, its
 * builders will produce objects that satisfy this same interface.
 */

import { createInterface } from "node:readline";
import type { JSONSchema7 } from "json-schema";
import { z } from "zod";
import {
	type PrimitiveJsonValue,
	primitiveJsonSchema,
} from "../runnable/primitive-contracts.ts";
import type { McpStdioCommand, McpTool } from "./client.ts";
import {
	callTool,
	listTools,
	MCP_LEGACY_PROTOCOL_VERSION,
	MCP_PROTOCOL_VERSION,
} from "./client.ts";

const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_META_KEY =
	"io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";
const SERVER_INFO = { name: "ryu-sdk-server", version: "0.0.1" } as const;
const PUBLIC_CACHE_TTL_MS = 60_000;

// ── Minimal Runnable contract ─────────────────────────────────────────────────

/** JSON Schema fragment — enough to describe a tool's input arguments. */
export type JsonSchema = JSONSchema7;

/**
 * The minimal executable Runnable interface consumed by this bridge.
 *
 * When #205 ships its `defineAgent / defineTool / ...` API, those builders must
 * return objects that satisfy this interface so they plug straight in here
 * without any adapter.
 */
export interface SdkRunnable {
	/** Human-readable description shown to MCP hosts. */
	description?: string;
	/** JSON Schema for the tool's input arguments. */
	inputSchema?: JsonSchema;
	/** Stable, unique tool name (no spaces; used as the MCP tool name). */
	name: string;
	/**
	 * Execute the runnable with the given arguments and return a result.
	 * The result is JSON-encoded into an MCP `text` content block.
	 */
	run(
		args: PrimitiveJsonValue | undefined
	): Promise<PrimitiveJsonValue | undefined>;
}

// ── Passthrough (Ghost / Shadow) ──────────────────────────────────────────────

/**
 * A passthrough registration forwards `tools/list` + `tools/call` to a remote
 * MCP server (e.g. Ghost at its stdio command, or Shadow at :3030).  The tools
 * are re-advertised under their original names; calls are forwarded verbatim.
 *
 * This is the mechanism by which orphaned Ghost (29 computer-use tools) and
 * Shadow (:3030 capture/search tools) can be advertised to any MCP host without
 * embedding their implementation in the SDK.
 */
export interface PassthroughRegistration {
	/** Command descriptor for the upstream MCP stdio server. */
	command: McpStdioCommand;
	/** Label used in error messages (e.g. "ghost", "shadow"). */
	label: string;
}

// ── JSON-RPC helpers ──────────────────────────────────────────────────────────

interface JsonRpcRequest {
	id?: number | string | null;
	jsonrpc: "2.0";
	method: string;
	params?: PrimitiveJsonValue;
}

interface JsonRpcResponse {
	error?: { code: number; data?: PrimitiveJsonValue; message: string };
	id: number | string | null;
	jsonrpc: "2.0";
	result?: PrimitiveJsonValue;
}

function respond<T>(
	id: number | string | null | undefined,
	result: T
): JsonRpcResponse {
	return {
		jsonrpc: "2.0",
		id: id ?? null,
		result:
			result === undefined
				? undefined
				: primitiveJsonSchema.parse(JSON.parse(JSON.stringify(result))),
	};
}

function respondError(
	id: number | string | null | undefined,
	code: number,
	message: string,
	data?: PrimitiveJsonValue
): JsonRpcResponse {
	return {
		jsonrpc: "2.0",
		id: id ?? null,
		error: data === undefined ? { code, message } : { code, message, data },
	};
}

const recordSchema = z.record(z.string(), primitiveJsonSchema);
const requestContract = z.object({
	jsonrpc: z.literal("2.0"),
	method: z.string(),
	id: z.union([z.number(), z.string(), z.null()]).optional(),
	params: primitiveJsonSchema.optional(),
});
const contentContract = z
	.object({
		content: z.array(primitiveJsonSchema).optional(),
	})
	.nullable()
	.optional();

function isRecord(
	value: PrimitiveJsonValue | undefined
): value is Record<string, PrimitiveJsonValue> {
	return recordSchema.safeParse(value).success;
}
function isJsonRpcRequest(
	value: Parameters<typeof requestContract.safeParse>[0]
): value is JsonRpcRequest {
	return requestContract.safeParse(value).success;
}
function modernResult<T>(result: T) {
	const parsed = z
		.object({ _meta: primitiveJsonSchema.optional() })
		.safeParse(result);
	const metadata =
		parsed.success && isRecord(parsed.data._meta) ? parsed.data._meta : {};
	return {
		...result,
		resultType: "complete",
		_meta: { ...metadata, [SERVER_INFO_META_KEY]: SERVER_INFO },
	};
}
/** Wrap a JSON runnable result in an MCP text content block. */
function wrapContent(value: PrimitiveJsonValue | undefined) {
	const text = z.string().safeParse(value);
	return {
		content: [
			{ type: "text", text: text.success ? text.data : JSON.stringify(value) },
		],
	};
}
/** Decode the first text block, preserving raw non-envelope JSON and text. */
export function unwrapContent(
	raw: Parameters<typeof primitiveJsonSchema.parse>[0]
) {
	const value = primitiveJsonSchema.optional().parse(raw);
	const content = contentContract.safeParse(value);
	const first = z
		.object({ text: z.string().optional() })
		.safeParse(content.success ? content.data?.content?.[0] : undefined);
	const text = first.success ? first.data.text : undefined;
	if (text === undefined) {
		return value;
	}
	try {
		return primitiveJsonSchema.parse(JSON.parse(text));
	} catch {
		return text;
	}
}

// ── McpServer ─────────────────────────────────────────────────────────────────

/**
 * An MCP stdio server that exposes SDK Runnables and optional passthrough
 * registrations as MCP tools.
 *
 * @example
 * ```ts
 * import { McpServer } from "@ryuhq/sdk/mcp/server"
 *
 * const server = new McpServer()
 *   .register({ name: "greet", run: (a) => Promise.resolve(`Hello!`) })
 *
 * await server.serve()  // reads stdin, writes stdout until EOF
 * ```
 */
export class McpServer {
	private readonly runnables = new Map<string, SdkRunnable>();
	private readonly passthroughs: PassthroughRegistration[] = [];

	/**
	 * Register an SDK Runnable as an MCP tool.
	 * Returns `this` for chaining.
	 */
	register(runnable: SdkRunnable): this {
		this.runnables.set(runnable.name, runnable);
		return this;
	}

	/**
	 * Register a passthrough to an external MCP stdio server (e.g. Ghost or
	 * Shadow).  Tools from that server are fetched lazily and re-advertised.
	 * Returns `this` for chaining.
	 */
	passthrough(registration: PassthroughRegistration): this {
		this.passthroughs.push(registration);
		return this;
	}

	/** Fetch all tools: local Runnables + passthrough tools. */
	private async allTools(): Promise<McpTool[]> {
		const local: McpTool[] = [...this.runnables.values()].map((r) => ({
			name: r.name,
			description: r.description,
			inputSchema:
				r.inputSchema === undefined
					? undefined
					: primitiveJsonSchema.parse(
							JSON.parse(JSON.stringify(r.inputSchema))
						),
		}));

		const remote: McpTool[] = [];
		for (const pt of this.passthroughs) {
			try {
				const tools = await listTools(pt.command);
				remote.push(...tools);
			} catch (err) {
				// Degrade gracefully: log but don't crash the server.
				process.stderr.write(
					`[mcp-server] passthrough '${pt.label}' list_tools failed: ${err}\n`
				);
			}
		}

		return [...local, ...remote];
	}

	/** Handle a `tools/call` request. */
	private async handleCallTool(
		name: string,
		args: PrimitiveJsonValue | undefined
	) {
		const local = this.runnables.get(name);
		if (local) {
			const result = await local.run(args);
			return wrapContent(result);
		}

		// Not a local Runnable — try passthrough servers in order.
		for (const pt of this.passthroughs) {
			try {
				const tools = await listTools(pt.command);
				if (tools.some((t) => t.name === name)) {
					return primitiveJsonSchema
						.optional()
						.parse(await callTool(pt.command, name, args));
				}
			} catch {
				// continue to next passthrough
			}
		}

		throw new Error(`Unknown tool: ${name}`);
	}

	/**
	 * Handle a single parsed JSON-RPC request line. Returns the response to write
	 * (or null for notifications that require no response).
	 */
	private async handleRequest(
		req: JsonRpcRequest,
		initialized: { value: boolean },
		write: (obj: JsonRpcResponse) => void
	): Promise<void> {
		const { id, method, params } = req;
		if (id === undefined) {
			return;
		}

		const requestParams = isRecord(params) ? params : {};
		const requestMeta = isRecord(requestParams._meta)
			? requestParams._meta
			: {};
		const requestProtocolVersion = requestMeta[PROTOCOL_VERSION_META_KEY];
		const hasModernMetadata = Object.keys(requestMeta).some((key) =>
			key.startsWith("io.modelcontextprotocol/")
		);
		if (hasModernMetadata && requestProtocolVersion !== MCP_PROTOCOL_VERSION) {
			write(
				respondError(id, -32_022, "Unsupported MCP protocol version", {
					supported: [MCP_PROTOCOL_VERSION],
				})
			);
			return;
		}
		const modern = requestProtocolVersion === MCP_PROTOCOL_VERSION;
		if (modern && !isRecord(requestMeta[CLIENT_CAPABILITIES_META_KEY])) {
			write(
				respondError(id, -32_602, "Modern requests require clientCapabilities")
			);
			return;
		}

		if (method === "initialize") {
			if (modern) {
				write(respondError(id, -32_601, "Method not found: initialize"));
				return;
			}
			initialized.value = true;
			write(
				respond(id, {
					protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: SERVER_INFO,
				})
			);
			return;
		}

		if (method === "server/discover") {
			if (!modern) {
				write(
					respondError(
						id,
						-32_022,
						"Modern discovery requires protocol metadata",
						{ supported: [MCP_PROTOCOL_VERSION] }
					)
				);
				return;
			}
			write(
				respond(
					id,
					modernResult({
						cacheScope: "public",
						capabilities: { tools: {} },
						instructions:
							"This MCP server exposes registered SDK Runnables as tools.",
						supportedVersions: [MCP_PROTOCOL_VERSION],
						ttlMs: PUBLIC_CACHE_TTL_MS,
					})
				)
			);
			return;
		}

		if (method === "notifications/initialized") {
			// Notification — no response required.
			return;
		}

		if (!(modern || initialized.value)) {
			write(respondError(id, -32_002, "Server not initialized"));
			return;
		}

		if (method === "ping") {
			write(respond(id, modern ? modernResult({}) : {}));
			return;
		}

		if (method === "tools/list") {
			try {
				const tools = await this.allTools();
				write(
					respond(
						id,
						modern
							? modernResult({
									cacheScope: "private",
									ttlMs: 0,
									tools,
								})
							: { tools }
					)
				);
			} catch (err) {
				write(respondError(id, -32_603, String(err)));
			}
			return;
		}

		if (method === "tools/call") {
			await this.handleToolsCall(id, params, modern, write);
			return;
		}

		write(respondError(id, -32_601, `Method not found: ${method}`));
	}

	/** Handle a `tools/call` JSON-RPC request. */
	private async handleToolsCall(
		id: number | string | null | undefined,
		params: PrimitiveJsonValue | undefined,
		modern: boolean,
		write: (obj: JsonRpcResponse) => void
	): Promise<void> {
		const p = isRecord(params) ? params : {};
		const toolName = z.string().safeParse(p?.name);
		const toolArgs = p?.arguments ?? {};
		if (!toolName.success) {
			write(respondError(id, -32_602, "tools/call requires 'name'"));
			return;
		}
		try {
			const result = await this.handleCallTool(toolName.data, toolArgs);
			if (modern) {
				if (!isRecord(result)) {
					write(
						respondError(id, -32_603, "Tool returned an invalid MCP result")
					);
					return;
				}
				write(respond(id, modernResult(result)));
				return;
			}
			write(respond(id, result));
		} catch (err) {
			const result = {
				content: [{ type: "text", text: String(err) }],
				isError: true,
			};
			write(respond(id, modern ? modernResult(result) : result));
		}
	}

	/**
	 * Start reading JSON-RPC requests from the given readable stream and writing
	 * responses to the given writable stream.
	 *
	 * Defaults to `process.stdin` / `process.stdout`.  Passing explicit streams
	 * lets tests inject a pair of in-process pipes.
	 *
	 * Resolves when the input stream ends (EOF).
	 */
	serve(
		input: NodeJS.ReadableStream = process.stdin,
		output: NodeJS.WritableStream = process.stdout
	): Promise<void> {
		const write = (obj: JsonRpcResponse) => {
			output.write(`${JSON.stringify(obj)}\n`);
		};

		const initialized = { value: false };

		return new Promise<void>((resolve) => {
			const rl = createInterface({
				input,
				crlfDelay: Number.POSITIVE_INFINITY,
			});

			rl.on("line", (rawLine) => {
				const line = rawLine.trim();
				if (!line) {
					return;
				}

				let value: PrimitiveJsonValue;
				try {
					value = primitiveJsonSchema.parse(JSON.parse(line));
				} catch {
					write(respondError(null, -32_700, "Parse error"));
					return;
				}
				if (!isJsonRpcRequest(value)) {
					write(respondError(null, -32_600, "Invalid JSON-RPC request"));
					return;
				}
				const req = value;

				this.handleRequest(req, initialized, write).catch((err) => {
					write(respondError(req.id, -32_603, String(err)));
				});
			});

			rl.on("close", resolve);
		});
	}
}
