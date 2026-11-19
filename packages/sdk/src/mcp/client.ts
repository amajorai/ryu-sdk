/**
 * SDK MCP stdio client — a TypeScript mirror of the wire contract in
 * `apps/core/src/sidecar/mcp/client.rs`.
 *
 * This implements JSON-RPC 2.0 over newline-delimited stdio. It probes with
 * `server/discover` using the 2026-07-28 per-request envelope, then falls back
 * to the legacy `initialize` handshake when the server does not support it.
 *
 * POLICY NOTE: this client does NOT implement tool-approval or request-level
 * policy enforcement.  Approval and policy live in the chat layer and the
 * Gateway (per issue #86).  Any policy that must run before a tool call must be
 * wired upstream by the caller, not here.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";
import {
	type PrimitiveJsonValue,
	primitiveJsonSchema,
} from "../runnable/primitive-contracts.ts";

/** Latest stateless MCP protocol version used for modern per-request metadata. */
export const MCP_PROTOCOL_VERSION = "2026-07-28";

/** Legacy version used when discovery shows the peer needs an initialize handshake. */
export const MCP_LEGACY_PROTOCOL_VERSION = "2024-11-05";

const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
const CLIENT_CAPABILITIES_META_KEY =
	"io.modelcontextprotocol/clientCapabilities";
const CLIENT_INFO = { name: "ryu-sdk", version: "0.0.1" } as const;
const MODERN_PROTOCOL_ERROR_CODES = new Set([-32_020, -32_021, -32_022]);

/** Timeout (ms) waiting for a single JSON-RPC response. */
const RPC_TIMEOUT_MS = 60_000;

/** A tool entry from `tools/list`. */
export interface McpTool {
	description?: string;
	/** JSON Schema object for the tool's input arguments. */
	inputSchema?: PrimitiveJsonValue;
	name: string;
}

/** Command descriptor for spawning an MCP stdio server. */
export interface McpStdioCommand {
	args?: string[];
	command: string;
	env?: Record<string, string>;
}

/** A line-delimited JSON value read from the server's stdout. */
interface JsonRpcFrame {
	error?: { code: number; message: string; data?: PrimitiveJsonValue };
	id?: number | string | null;
	jsonrpc: "2.0";
	method?: string;
	params?: PrimitiveJsonValue;
	result?: PrimitiveJsonValue;
}

/**
 * Pending response waiter: each in-flight request registers a handler that
 * receives the next line whose `id` matches.
 */
interface ResponseWaiter {
	id: number;
	reject: (err: Error) => void;
	resolve: (result: PrimitiveJsonValue) => void;
	timer: ReturnType<typeof setTimeout>;
}

class McpRpcError extends Error {
	readonly code: number;

	constructor(code: number, message: string) {
		super(message);
		this.name = "McpRpcError";
		this.code = code;
	}
}

const recordSchema = z.record(z.string(), primitiveJsonSchema);
const frameContract = z.object({
	jsonrpc: z.literal("2.0"),
	id: z.union([z.number(), z.string(), z.null()]).optional(),
	method: z.string().optional(),
	params: primitiveJsonSchema.optional(),
	result: primitiveJsonSchema.optional(),
	error: z
		.object({
			code: z.number(),
			message: z.string(),
			data: primitiveJsonSchema.optional(),
		})
		.optional(),
});
const frameSchema = z.custom<JsonRpcFrame>(
	(value) =>
		primitiveJsonSchema.safeParse(value).success &&
		frameContract.safeParse(value).success
);
function isRecord(
	value: PrimitiveJsonValue | undefined
): value is Record<string, PrimitiveJsonValue> {
	return recordSchema.safeParse(value).success;
}
function withModernMetadata(params: PrimitiveJsonValue | undefined) {
	const source = isRecord(params) ? params : {};
	const metadata = isRecord(source._meta) ? source._meta : {};
	return {
		...source,
		_meta: {
			...metadata,
			[PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION,
			[CLIENT_INFO_META_KEY]: CLIENT_INFO,
			[CLIENT_CAPABILITIES_META_KEY]: {},
		},
	};
}

interface ProtocolState {
	era: "legacy" | "modern";
}

/** A live connection to a spawned MCP stdio server. */
class McpConnection {
	private readonly proc: ReturnType<typeof spawn>;
	private readonly protocol: ProtocolState = { era: "modern" };
	private nextId = 1;
	private closed = false;
	private readonly waiters: ResponseWaiter[] = [];

	private constructor(proc: ReturnType<typeof spawn>) {
		this.proc = proc;
	}

	/** Spawn the server, probe modern discovery, then fall back to legacy init. */
	static async connect(cmd: McpStdioCommand): Promise<McpConnection> {
		const env = { ...process.env, ...cmd.env };
		const proc = spawn(cmd.command, cmd.args ?? [], {
			stdio: ["pipe", "pipe", "pipe"],
			env,
		});

		if (!(proc.stdin && proc.stdout)) {
			proc.kill();
			throw new Error(`MCP server '${cmd.command}' stdin/stdout unavailable`);
		}

		// Forward server stderr to process.stderr for diagnosability.
		if (proc.stderr) {
			proc.stderr.on("data", (chunk: Buffer) => {
				process.stderr.write(`[mcp-server] ${chunk.toString()}`);
			});
		}

		const conn = new McpConnection(proc);

		// Fail every in-flight request once the transport is gone. Registered
		// before the first await: Node and Bun both report a failed spawn (for
		// example ENOENT for a missing binary) as an async `error` event, which
		// would otherwise be an unhandled emitter error that kills the host.
		const failPending = (error: Error) => {
			conn.closed = true;
			for (const waiter of conn.waiters.splice(0)) {
				clearTimeout(waiter.timer);
				waiter.reject(error);
			}
		};
		proc.on("error", (error) =>
			failPending(
				new Error(
					`MCP server '${cmd.command}' failed to start: ${error.message}`
				)
			)
		);
		// EPIPE when the child exits before reading its input.
		proc.stdin.on("error", () => {
			conn.closed = true;
		});

		// Wire up readline using 'line' events so the iterator is never consumed
		// and closed prematurely by a `for await ... return` pattern.
		const rl = createInterface({
			input: proc.stdout,
			crlfDelay: Number.POSITIVE_INFINITY,
		});

		rl.on("line", (rawLine) => {
			const trimmed = rawLine.trim();
			if (!trimmed) {
				return;
			}
			let parsed: JsonRpcFrame;
			try {
				parsed = frameSchema.parse(JSON.parse(trimmed));
			} catch {
				return;
			}
			// Dispatch to the matching waiter (skip notifications with no id).
			if (parsed.id === undefined || parsed.id === null) {
				return;
			}
			const idx = conn.waiters.findIndex((w) => w.id === parsed.id);
			if (idx === -1) {
				return;
			}
			const [waiter] = conn.waiters.splice(idx, 1);
			if (!waiter) {
				return;
			}
			clearTimeout(waiter.timer);
			if (parsed.error) {
				waiter.reject(
					new McpRpcError(
						parsed.error.code,
						`MCP error: ${JSON.stringify(parsed.error)}`
					)
				);
			} else {
				waiter.resolve(parsed.result ?? null);
			}
		});

		// Reject any in-flight waiters — the server exited.
		rl.on("close", () =>
			failPending(new Error("MCP server closed the connection"))
		);

		// Callers only own the connection once it is returned, so a failed
		// handshake must tear the child down here or it is orphaned.
		try {
			await conn.negotiate();
			return conn;
		} catch (error) {
			await conn.shutdown();
			throw error;
		}
	}

	/** Probe modern discovery, then fall back to the legacy initialize handshake. */
	private async negotiate(): Promise<void> {
		try {
			const discovery = await this.request("server/discover", {});
			if (
				isRecord(discovery) &&
				discovery.resultType === "complete" &&
				Array.isArray(discovery.supportedVersions) &&
				discovery.supportedVersions.includes(MCP_PROTOCOL_VERSION)
			) {
				return;
			}
		} catch (error) {
			// A dead transport cannot answer a legacy handshake either; surface the
			// original failure instead of a second, less specific one.
			if (
				this.closed ||
				(error instanceof McpRpcError &&
					MODERN_PROTOCOL_ERROR_CODES.has(error.code))
			) {
				throw error;
			}
		}

		this.protocol.era = "legacy";
		await this.request("initialize", {
			protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: CLIENT_INFO,
		});
		this.notify("notifications/initialized", {});
	}

	/** Send a JSON-RPC request and return the `result` field. */
	request(
		method: string,
		params: PrimitiveJsonValue | undefined
	): Promise<PrimitiveJsonValue> {
		const id = this.nextId++;
		const frame = JSON.stringify({
			jsonrpc: "2.0",
			id,
			method,
			params:
				this.protocol.era === "modern" ? withModernMetadata(params) : params,
		});

		return new Promise<PrimitiveJsonValue>((resolve, reject) => {
			if (this.closed) {
				reject(new Error("MCP server closed the connection"));
				return;
			}
			let waiter: ResponseWaiter;
			const timer = setTimeout(() => {
				const index = this.waiters.indexOf(waiter);
				if (index !== -1) {
					this.waiters.splice(index, 1);
				}
				reject(new Error(`MCP request '${method}' timed out`));
			}, RPC_TIMEOUT_MS);
			waiter = { id, resolve, reject, timer };
			this.waiters.push(waiter);
			// Register before writing: a fast or in-process transport can deliver
			// the response during write(), before it returns to this call site.
			this.write(frame);
		});
	}

	/** Send a JSON-RPC notification (no response expected). */
	notify(method: string, params: PrimitiveJsonValue | undefined): void {
		const frame = JSON.stringify({
			jsonrpc: "2.0",
			method,
			params:
				this.protocol.era === "modern" ? withModernMetadata(params) : params,
		});
		this.write(frame);
	}

	private write(frame: string): void {
		if (this.closed) {
			return;
		}
		this.proc.stdin?.write(`${frame}\n`);
	}

	/** Graceful shutdown: close stdin, then kill. */
	async shutdown(): Promise<void> {
		this.closed = true;
		this.proc.stdin?.end();
		await new Promise<void>((resolve) => {
			this.proc.once("exit", () => resolve());
			this.proc.kill();
			// Resolve after a short grace period even if exit never fires.
			setTimeout(resolve, 500);
		});
	}
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * List the tools an MCP server advertises (`tools/list`).
 *
 * Spawns the server, negotiates the protocol era, calls `tools/list`,
 * and tears down the process — matching the stateless per-request pattern in
 * `apps/core/src/sidecar/mcp/client.rs`.
 */
export async function listTools(cmd: McpStdioCommand): Promise<McpTool[]> {
	const conn = await McpConnection.connect(cmd);
	let result: PrimitiveJsonValue;
	try {
		result = await conn.request("tools/list", {});
	} finally {
		await conn.shutdown();
	}

	const rawTools =
		isRecord(result) && Array.isArray(result.tools) ? result.tools : [];
	const tools: McpTool[] = [];
	for (const rawTool of rawTools) {
		if (!isRecord(rawTool)) {
			continue;
		}
		const name = z.string().safeParse(rawTool.name);
		if (!name.success) {
			continue;
		}
		const description = z.string().safeParse(rawTool.description);
		tools.push({
			name: name.data,
			description: description.success ? description.data : undefined,
			inputSchema: rawTool.inputSchema,
		});
	}
	return tools;
}

/**
 * Call a tool on an MCP server (`tools/call`) and return the raw result.
 *
 * The returned value is the full `tools/call` result object
 * `{ content: [{type, text}], isError? }`.  Callers that need the plain text
 * output should extract `.content[0].text`.
 */
export async function callTool(
	cmd: McpStdioCommand,
	tool: string,
	args: Parameters<typeof primitiveJsonSchema.parse>[0]
): Promise<PrimitiveJsonValue> {
	const conn = await McpConnection.connect(cmd);
	try {
		const argumentText = JSON.stringify(args);
		const parsedArgs =
			argumentText === undefined
				? undefined
				: primitiveJsonSchema.parse(JSON.parse(argumentText));
		if (parsedArgs === undefined) {
			return await conn.request("tools/call", { name: tool });
		}
		return await conn.request("tools/call", {
			name: tool,
			arguments: parsedArgs,
		});
	} finally {
		await conn.shutdown();
	}
}
