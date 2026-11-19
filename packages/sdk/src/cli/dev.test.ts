/**
 * Smoke test for `ryu dev` — runs a full turn against a mock gateway and a
 * sample Runnable, asserting that text, tool-call, and tool-result events
 * stream to stdout correctly.
 *
 * The mock gateway is an in-process request handler so the test never needs a
 * real gateway or a listening socket.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage } from "../model/client.ts";
import type {
	DevEvent,
	DevModelClient,
	GatewayFetch,
	Runnable,
} from "./dev.ts";
import { loadRunnable, probeGateway, runTurn } from "./dev.ts";

// ── Mock gateway ──────────────────────────────────────────────────────────────

/** Stable gateway URL used by the injected health request handler. */
const MOCK_GATEWAY_URL = "http://mock-gateway.test";
const mockFetch: GatewayFetch = async (input) => {
	const url = new URL(String(input));
	if (url.pathname === "/health") {
		return new Response("ok", { status: 200 });
	}
	return new Response("not found", { status: 404 });
};

// ── Sample Runnable ───────────────────────────────────────────────────────────

/**
 * A minimal Runnable that streams assistant text by calling model.stream(),
 * then emits a synthetic tool-call + tool-result pair so the test covers all
 * event types.
 */
const sampleRunnable: Runnable = {
	name: "smoke-test-agent",
	async *run(
		messages: ChatMessage[],
		model: DevModelClient
	): AsyncGenerator<DevEvent> {
		// Stream text from the gateway.
		for await (const delta of model.stream(messages)) {
			if (delta.content) {
				yield { type: "text", content: delta.content };
			}
		}

		// Emit a synthetic tool call.
		yield {
			type: "tool_call",
			id: "tc-1",
			title: "web_search",
			kind: "execute",
			input: { query: "ryu sdk" },
		};

		// Emit a tool result.
		yield {
			type: "tool_result",
			id: "tc-1",
			status: "completed",
			output: { results: ["https://ryu.dev"] },
		};
	},
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("probeGateway", () => {
	it("returns true when the gateway /health responds", async () => {
		const reachable = await probeGateway(MOCK_GATEWAY_URL, mockFetch);
		expect(reachable).toBe(true);
	});

	it("returns false when the URL is unreachable", async () => {
		const reachable = await probeGateway("http://127.0.0.1:1");
		expect(reachable).toBe(false);
	});
});

// Temp developer modules live in a per-test directory outside the shared
// source tree, so concurrent runs never collide and a crash leaves no stray
// `.ts` files under `src/cli` for tsc or Biome to pick up.
let moduleDir = "";
beforeEach(() => {
	moduleDir = mkdtempSync(join(tmpdir(), "ryu-sdk-dev-"));
});
afterEach(() => {
	rmSync(moduleDir, { recursive: true, force: true });
});

describe("loadRunnable", () => {
	it("throws a descriptive error when the module has no runnable export", async () => {
		// Write a temp module that exports neither "default" nor "runnable",
		// then assert loadRunnable rejects with the expected message.
		const tmpPath = join(moduleDir, "no_runnable.ts");
		writeFileSync(tmpPath, "export const x = 1;\n", "utf8");
		await expect(loadRunnable(tmpPath)).rejects.toThrow(
			"must export a Runnable"
		);
	});
});

describe("runTurn — full turn streams to stdout", () => {
	it("collects text + tool events from a full turn", async () => {
		const model: DevModelClient = {
			model: "mock",
			baseUrl: MOCK_GATEWAY_URL,
			chat() {
				return Promise.reject(new Error("this scenario only streams"));
			},
			async *stream(): AsyncGenerator<{
				content: string;
				finishReason: string | null;
			}> {
				for (const content of ["Hello", ", world", "!"]) {
					yield { content, finishReason: null };
				}
			},
		};

		const events: DevEvent[] = [];

		// Wrap the sample runnable so we can capture events without relying on
		// process.stdout parsing.
		const capturingRunnable: Runnable = {
			name: "capturing",
			async *run(messages, mdl): AsyncGenerator<DevEvent> {
				for await (const ev of sampleRunnable.run(messages, mdl)) {
					events.push(ev);
					yield ev;
				}
			},
		};

		const ok = await runTurn(
			capturingRunnable,
			[{ role: "user", content: "hello" }],
			model
		);

		expect(ok).toBe(true);

		const textEvents = events.filter((e) => e.type === "text");
		const toolCallEvents = events.filter((e) => e.type === "tool_call");
		const toolResultEvents = events.filter((e) => e.type === "tool_result");

		// Three text chunks from the mock model stream.
		expect(textEvents).toHaveLength(3);
		const fullText = textEvents.map((e) => e.content).join("");
		expect(fullText).toBe("Hello, world!");

		// One tool-call event.
		expect(toolCallEvents).toHaveLength(1);
		expect(toolCallEvents[0]?.id).toBe("tc-1");

		// One tool-result event.
		expect(toolResultEvents).toHaveLength(1);
		expect(toolResultEvents[0]?.status).toBe("completed");
	});
});

describe("developer module contracts", () => {
	it("preserves named-export methods and their original receiver", async () => {
		const path = join(moduleDir, "named_runnable.ts");
		writeFileSync(
			path,
			'export const runnable = {name:"owned",prefix:"receiver",*run(){yield {type:"text",content:this.prefix};}};'
		);
		const loaded = await loadRunnable(path);
		const model: DevModelClient = {
			model: "mock",
			baseUrl: MOCK_GATEWAY_URL,
			chat: () => Promise.reject(new Error("unused")),
			async *stream() {
				yield { content: "unused", finishReason: null };
			},
		};
		const events = [];
		for await (const event of loaded.run([], model)) {
			events.push(event);
		}
		expect(events).toEqual([{ type: "text", content: "receiver" }]);
	});
	it("rejects a module with a missing name or a non-callable run method", async () => {
		for (const [index, source] of [
			"export default {run(){}};",
			'export default {name:"invalid",run:3};',
		].entries()) {
			const path = join(moduleDir, `invalid_runnable_${index}.ts`);
			writeFileSync(path, source);
			await expect(loadRunnable(path)).rejects.toThrow(
				"must export a Runnable"
			);
		}
	});
});
