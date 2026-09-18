/**
 * Smoke test for `ryu dev` — runs a full turn against a mock gateway and a
 * sample Runnable, asserting that text, tool-call, and tool-result events
 * stream to stdout correctly.
 *
 * The mock gateway is an in-process request handler so the test never needs a
 * real gateway or a listening socket.
 */

import { describe, expect, it } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import type { ChatMessage, ModelClient } from "../model/client.ts";
import type { DevEvent, GatewayFetch, Runnable } from "./dev.ts";
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
		model: ModelClient
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

describe("loadRunnable", () => {
	it("throws a descriptive error when the module has no runnable export", async () => {
		// Write a temp module that exports neither "default" nor "runnable",
		// then assert loadRunnable rejects with the expected message.
		const tmpPath = `${import.meta.dir}/_tmp_no_runnable_${Date.now()}.ts`;
		writeFileSync(tmpPath, "export const x = 1;\n", "utf8");
		try {
			await expect(loadRunnable(tmpPath)).rejects.toThrow(
				"must export a Runnable"
			);
		} finally {
			try {
				unlinkSync(tmpPath);
			} catch {
				// ignore cleanup errors
			}
		}
	});
});

describe("runTurn — full turn streams to stdout", () => {
	it("collects text + tool events from a full turn", async () => {
		const model = {
			async *stream(): AsyncGenerator<{
				content: string;
				finishReason: string | null;
			}> {
				for (const content of ["Hello", ", world", "!"]) {
					yield { content, finishReason: null };
				}
			},
		} as unknown as ModelClient;

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
		const fullText = textEvents
			.map((e) => (e as { content: string }).content)
			.join("");
		expect(fullText).toBe("Hello, world!");

		// One tool-call event.
		expect(toolCallEvents).toHaveLength(1);
		expect((toolCallEvents[0] as { id: string }).id).toBe("tc-1");

		// One tool-result event.
		expect(toolResultEvents).toHaveLength(1);
		expect((toolResultEvents[0] as { status: string }).status).toBe(
			"completed"
		);
	});
});
