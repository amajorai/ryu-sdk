/**
 * MCP client+server bridge round-trip tests.
 *
 * Criterion coverage:
 * 1. SDK MCP client can `initialize` + `tools/list` + `tools/call` against a
 *    stdio MCP server matching the wire contract in client.rs.
 * 2. SDK MCP server registers Runnables and serves them via tools/list +
 *    tools/call over stdio.
 * 3. A round-trip test starts the SDK MCP server, lists tools, calls one
 *    Runnable tool, and asserts the result matches a direct run().
 * 4. The bridge does NOT implement tool-approval or policy (left to
 *    chat/Gateway per #86) — documented in server.ts; no approval code here.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
	callTool,
	listTools,
	MCP_LEGACY_PROTOCOL_VERSION,
	MCP_PROTOCOL_VERSION,
} from "./client.ts";
import type { SdkRunnable } from "./server.ts";
import { McpServer, unwrapContent } from "./server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "fixture-server.ts");

/** Command descriptor that spawns the fixture server via `bun run`. */
const fixtureCmd = { command: "bun", args: ["run", FIXTURE] };

// ── Criterion 1 + 2: client against SDK server ────────────────────────────────

describe("MCP client", () => {
	it("lists tools from the fixture server", async () => {
		const tools = await listTools(fixtureCmd);
		expect(tools.length).toBeGreaterThan(0);
		const greet = tools.find((t) => t.name === "greet");
		expect(greet).toBeDefined();
		expect(greet?.description).toContain("greeting");
	});

	it("calls a tool on the fixture server", async () => {
		const result = await callTool(fixtureCmd, "greet", { name: "Ryu" });
		// result is the raw MCP tools/call envelope
		const value = unwrapContent(result);
		expect(value).toEqual({ message: "Hello, Ryu!" });
	});

	it("serializes optional authored arguments before validating the wire document", async () => {
		const result = await callTool(fixtureCmd, "greet", {
			name: undefined,
			future: { optional: undefined },
			values: [undefined, false, 0],
		});
		expect(unwrapContent(result)).toEqual({ message: "Hello, world!" });
	});

	it("rejects promptly when the MCP process closes before a response", async () => {
		const exitsWithoutResponding = {
			command: process.execPath,
			args: ["-e", "process.exit(0)"],
		};
		await expect(listTools(exitsWithoutResponding)).rejects.toThrow(
			"MCP server closed the connection"
		);
	});

	it("rejects promptly when the MCP command does not exist", async () => {
		const startedAt = Date.now();
		await expect(
			listTools({ command: "ryu-missing-mcp-binary-for-test" })
		).rejects.toThrow(/failed to start/);
		expect(Date.now() - startedAt).toBeLessThan(5000);
	});

	it("terminates the MCP process when the handshake fails", async () => {
		const workDir = mkdtempSync(join(tmpdir(), "ryu-sdk-mcp-"));
		const pidFile = join(workDir, "pid");
		const rejectsDiscovery = `
			require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
			const readline = require("node:readline");
			const rl = readline.createInterface({ input: process.stdin });
			rl.on("line", (line) => {
				const request = JSON.parse(line);
				process.stdout.write(JSON.stringify({
					jsonrpc: "2.0",
					id: request.id,
					error: { code: -32020, message: "Unsupported protocol version" }
				}) + "\\n");
			});
		`;
		try {
			await expect(
				listTools({ args: ["-e", rejectsDiscovery], command: process.execPath })
			).rejects.toThrow("Unsupported protocol version");
			const pid = Number(readFileSync(pidFile, "utf8"));
			expect(() => process.kill(pid, 0)).toThrow();
		} finally {
			rmSync(workDir, { force: true, recursive: true });
		}
	});

	it("falls back to a legacy initialize handshake when discovery is unsupported", async () => {
		const legacyServer = `
			const readline = require("node:readline");
			const rl = readline.createInterface({ input: process.stdin });
			rl.on("line", (line) => {
				const request = JSON.parse(line);
				let result;
				if (request.method === "initialize") {
					result = {
						protocolVersion: "2024-11-05",
						capabilities: { tools: {} },
						serverInfo: { name: "legacy-fixture", version: "1" }
					};
				} else if (request.method === "tools/list") {
					result = { tools: [{ name: "legacy_tool" }] };
				} else {
					process.stdout.write(JSON.stringify({
						jsonrpc: "2.0",
						id: request.id,
						error: { code: -32601, message: "Method not found" }
					}) + "\\n");
					return;
				}
				if (request.id !== undefined) {
					process.stdout.write(JSON.stringify({
						jsonrpc: "2.0",
						id: request.id,
						result
					}) + "\\n");
				}
			});
		`;
		const tools = await listTools({
			args: ["-e", legacyServer],
			command: process.execPath,
		});
		expect(tools.map((tool) => tool.name)).toEqual(["legacy_tool"]);
	});
});

// ── Criterion 3: round-trip — client result matches direct run() ──────────────

describe("MCP bridge round-trip", () => {
	it("client callTool result matches direct runnable.run()", async () => {
		// Define the same Runnable that the fixture server registers.
		const runnable: SdkRunnable = {
			name: "greet",
			run: (args) => {
				const a = z.object({ name: z.string().optional() }).parse(args);
				return Promise.resolve({ message: `Hello, ${a.name ?? "world"}!` });
			},
		};

		const inputArgs = { name: "Bridge" };

		// Direct run.
		const directResult = await runnable.run(inputArgs);

		// Via MCP round-trip through the fixture server.
		const rawResult = await callTool(fixtureCmd, "greet", inputArgs);
		const roundTripResult = unwrapContent(rawResult);

		expect(roundTripResult).toEqual(directResult);
	});
});

// ── McpServer.serve() in-process ──────────────────────────────────────────────

describe("McpServer.serve()", () => {
	/**
	 * Helper: feed a sequence of JSON-RPC lines into an McpServer via piped
	 * streams and collect all output lines.
	 */
	async function runInProcess(
		server: McpServer,
		lines: string[]
	): Promise<string[]> {
		const { Readable, Writable } = await import("node:stream");

		const inputLines = [...lines].map((l) => `${l}\n`).join("");

		const input = Readable.from([inputLines]);
		const outputLines: string[] = [];
		const output = new Writable({
			write(chunk, _enc, cb) {
				const text: string = chunk.toString();
				for (const line of text.split("\n")) {
					const t = line.trim();
					if (t) {
						outputLines.push(t);
					}
				}
				cb();
			},
		});

		await server.serve(input, output);
		return outputLines;
	}

	it("rejects malformed request identities without invoking a runnable", async () => {
		let calls = 0;
		const server = new McpServer().register({
			name: "echo",
			run: async (args) => {
				calls += 1;
				return args;
			},
		});
		const outputs = await runInProcess(server, [
			JSON.stringify({
				jsonrpc: "2.0",
				id: false,
				method: "tools/call",
				params: { name: "echo" },
			}),
			JSON.stringify({
				jsonrpc: "1.0",
				id: 1,
				method: "tools/call",
				params: { name: "echo" },
			}),
		]);
		const errors = outputs.map((line) =>
			z
				.object({ id: z.null(), error: z.object({ code: z.number() }) })
				.parse(JSON.parse(line))
		);
		expect(errors).toHaveLength(2);
		expect(errors.map((reply) => reply.error.code)).toEqual([-32_600, -32_600]);
		expect(calls).toBe(0);
	});

	it("preserves the legacy initialize handshake", async () => {
		const server = new McpServer();
		const outputs = await runInProcess(server, [
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2024-11-05",
					capabilities: {},
					clientInfo: { name: "test", version: "0" },
				},
			}),
		]);

		expect(outputs.length).toBeGreaterThan(0);
		const resp = JSON.parse(z.string().parse(outputs[0]));
		expect(resp.id).toBe(1);
		expect(resp.result?.protocolVersion).toBe(MCP_LEGACY_PROTOCOL_VERSION);
		expect(resp.result?.capabilities?.tools).toBeDefined();
	});

	it("discovers modern protocol support without an initialize handshake", async () => {
		const server = new McpServer();
		const outputs = await runInProcess(server, [
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "server/discover",
				params: {
					_meta: {
						"io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
						"io.modelcontextprotocol/clientCapabilities": {},
					},
				},
			}),
		]);

		const response = JSON.parse(z.string().parse(outputs[0]));
		expect(response.result).toMatchObject({
			cacheScope: "public",
			capabilities: { tools: {} },
			resultType: "complete",
			supportedVersions: [MCP_PROTOCOL_VERSION],
			ttlMs: expect.any(Number),
			_meta: {
				"io.modelcontextprotocol/serverInfo": {
					name: "ryu-sdk-server",
				},
			},
		});
	});

	it("serves modern tools/list as a cacheable complete result before initialization", async () => {
		const server = new McpServer().register({
			name: "ping",
			run: async () => "pong",
		});
		const outputs = await runInProcess(server, [
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/list",
				params: {
					_meta: {
						"io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
						"io.modelcontextprotocol/clientCapabilities": {},
					},
				},
			}),
		]);

		const response = JSON.parse(z.string().parse(outputs[0]));
		expect(response.result).toMatchObject({
			cacheScope: "private",
			resultType: "complete",
			ttlMs: 0,
			tools: [{ name: "ping" }],
		});
		expect(
			response.result._meta["io.modelcontextprotocol/serverInfo"]
		).toMatchObject({
			name: "ryu-sdk-server",
		});
	});

	it("lists registered runnables via tools/list", async () => {
		const server = new McpServer().register({
			name: "ping",
			description: "Ping tool",
			run: async () => "pong",
		});

		const outputs = await runInProcess(server, [
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2024-11-05", capabilities: {} },
			}),
			JSON.stringify({
				jsonrpc: "2.0",
				method: "notifications/initialized",
				params: {},
			}),
			JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/list",
				params: {},
			}),
		]);

		const listResp = outputs.map((l) => JSON.parse(l)).find((r) => r.id === 2);
		expect(listResp).toBeDefined();
		const tools = z
			.array(z.object({ name: z.string() }))
			.parse(listResp.result?.tools);
		expect(tools.some((t) => t.name === "ping")).toBe(true);
	});

	it("calls a registered runnable via tools/call", async () => {
		const server = new McpServer().register({
			name: "add",
			run: (args) => {
				const a = z.object({ x: z.number(), y: z.number() }).parse(args);
				return Promise.resolve(a.x + a.y);
			},
		});

		const outputs = await runInProcess(server, [
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2024-11-05", capabilities: {} },
			}),
			JSON.stringify({
				jsonrpc: "2.0",
				method: "notifications/initialized",
				params: {},
			}),
			JSON.stringify({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "add", arguments: { x: 3, y: 4 } },
			}),
		]);

		const callResp = outputs.map((l) => JSON.parse(l)).find((r) => r.id === 3);
		expect(callResp).toBeDefined();
		const value = unwrapContent(callResp.result);
		expect(value).toBe(7);
	});
});

describe("MCP content boundary", () => {
	it("retains additive raw JSON identities and own prototype keys", () => {
		const raw = { value: false, count: 0, future: [null, ""] };
		expect(unwrapContent(raw)).toBe(raw);
		const encoded = '{"__proto__":{"retained":true},"count":0}';
		const decoded = unwrapContent({
			content: [{ type: "text", text: encoded }],
		});
		expect(JSON.stringify(decoded)).toBe(encoded);
	});
	it("reads only the first text block and retains plain text fallbacks", () => {
		expect(unwrapContent({ content: [{ text: "false" }, null] })).toBe(false);
		expect(unwrapContent({ content: [{ text: "0" }] })).toBe(0);
		expect(unwrapContent({ content: [{ text: "" }] })).toBe("");
		expect(unwrapContent({ content: [{ text: "plain text" }] })).toBe(
			"plain text"
		);
		expect(unwrapContent(undefined)).toBeUndefined();
	});
});
