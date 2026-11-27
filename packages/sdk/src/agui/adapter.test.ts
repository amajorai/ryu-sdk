import { describe, expect, it } from "bun:test";
// biome-ignore lint/correctness/useImportExtensions: Published client exposes only the package root.
import type { HarnessRunEventEnvelope } from "@ryuhq/client";
import type { AgentEvent } from "../agent/loop.ts";
import { agentEventsToAgUi, harnessEventsToAgUi } from "./adapter.ts";
import { type AgUiEvent, encodeAgUiEvent, parseAgUiStream } from "./events.ts";

function ids() {
	let next = 0;
	return () => {
		next += 1;
		return `id-${next}`;
	};
}

async function* from<T>(items: T[]): AsyncGenerator<T> {
	for (const item of items) {
		yield item;
	}
}

async function collect(stream: AsyncIterable<AgUiEvent>): Promise<AgUiEvent[]> {
	const out: AgUiEvent[] = [];
	for await (const event of stream) {
		out.push(event);
	}
	return out;
}

describe("agentEventsToAgUi", () => {
	it("maps text, tool calls, results, and the final result into a paired AG-UI run", async () => {
		const events: AgentEvent[] = [
			{ type: "text", content: "Let me " },
			{ type: "text", content: "check." },
			{
				type: "tool_call",
				id: "call-1",
				name: "weather",
				input: { city: "Oslo" },
			},
			{
				type: "tool_result",
				id: "call-1",
				name: "weather",
				output: { temp: 4 },
			},
			{ type: "text", content: "It is 4C." },
			{ type: "result", text: "It is 4C.", steps: 2 },
		];
		const out = await collect(
			agentEventsToAgUi(from(events), {
				threadId: "t1",
				runId: "r1",
				idFactory: ids(),
				snapshotMessages: [{ id: "u1", role: "user", content: "weather?" }],
			})
		);
		expect(out.map((event) => event.type)).toEqual([
			"RUN_STARTED",
			"STEP_STARTED",
			"TEXT_MESSAGE_START",
			"TEXT_MESSAGE_CONTENT",
			"TEXT_MESSAGE_CONTENT",
			"TEXT_MESSAGE_END",
			"TOOL_CALL_START",
			"TOOL_CALL_ARGS",
			"TOOL_CALL_END",
			"TOOL_CALL_RESULT",
			"STEP_FINISHED",
			"STEP_STARTED",
			"TEXT_MESSAGE_START",
			"TEXT_MESSAGE_CONTENT",
			"TEXT_MESSAGE_END",
			"STEP_FINISHED",
			"MESSAGES_SNAPSHOT",
			"RUN_FINISHED",
		]);
		expect(out[6]).toEqual({
			type: "TOOL_CALL_START",
			toolCallId: "call-1",
			toolCallName: "weather",
			parentMessageId: "id-1",
		});
		expect(out[7]).toEqual({
			type: "TOOL_CALL_ARGS",
			toolCallId: "call-1",
			delta: '{"city":"Oslo"}',
		});
		expect(out[9]).toEqual({
			type: "TOOL_CALL_RESULT",
			messageId: "id-2",
			toolCallId: "call-1",
			content: '{"temp":4}',
			role: "tool",
		});
		const snapshot = out[16];
		expect(snapshot?.type === "MESSAGES_SNAPSHOT" && snapshot.messages).toEqual(
			[
				{ id: "u1", role: "user", content: "weather?" },
				{
					id: "id-1",
					role: "assistant",
					content: "Let me check.",
					toolCalls: [
						{
							id: "call-1",
							type: "function",
							function: { name: "weather", arguments: '{"city":"Oslo"}' },
						},
					],
				},
				{
					id: "id-2",
					role: "tool",
					toolCallId: "call-1",
					content: '{"temp":4}',
				},
				{ id: "id-3", role: "assistant", content: "It is 4C." },
			]
		);
		expect(out.at(-1)).toEqual({
			type: "RUN_FINISHED",
			threadId: "t1",
			runId: "r1",
			outcome: "success",
			result: { text: "It is 4C.", steps: 2 },
		});
	});

	it("turns an unanswered approval into an interrupt outcome", async () => {
		const out = await collect(
			agentEventsToAgUi(
				from<AgentEvent>([
					{
						type: "tool_call",
						id: "c1",
						name: "deploy",
						input: { env: "prod" },
					},
					{
						type: "approval_requested",
						approvalId: "ap-1",
						name: "deploy",
						input: { env: "prod" },
						summary: "Run deploy?",
					},
				]),
				{ threadId: "t", runId: "r", idFactory: ids() }
			)
		);
		const custom = out.find((event) => event.type === "CUSTOM");
		expect(custom).toEqual({
			type: "CUSTOM",
			name: "on_interrupt",
			value: {
				id: "ap-1",
				reason: "tool_approval",
				payload: {
					approvalId: "ap-1",
					summary: "Run deploy?",
					options: [],
					toolName: "deploy",
					input: { env: "prod" },
					toolCallId: "c1",
				},
			},
		});
		const finished = out.at(-1);
		expect(finished?.type).toBe("RUN_FINISHED");
		if (finished?.type === "RUN_FINISHED") {
			expect(finished.outcome).toBe("interrupt");
			expect(finished.interrupt?.id).toBe("ap-1");
		}
	});

	it("ends with RUN_ERROR and closes the open text message", async () => {
		const out = await collect(
			agentEventsToAgUi(
				from<AgentEvent>([
					{ type: "text", content: "partial" },
					{ type: "error", message: "gateway down" },
				]),
				{ threadId: "t", runId: "r", idFactory: ids() }
			)
		);
		expect(out.map((event) => event.type)).toEqual([
			"RUN_STARTED",
			"STEP_STARTED",
			"TEXT_MESSAGE_START",
			"TEXT_MESSAGE_CONTENT",
			"TEXT_MESSAGE_END",
			"STEP_FINISHED",
			"RUN_ERROR",
		]);
		expect(out.at(-1)).toEqual({ type: "RUN_ERROR", message: "gateway down" });
	});

	it("surfaces an account-connection pause as an auth interrupt", async () => {
		const out = await collect(
			agentEventsToAgUi(
				from<AgentEvent>([
					{
						type: "auth_required",
						tool: "gmail",
						url: "https://connect.example/gmail",
					},
				]),
				{ threadId: "t", runId: "r", idFactory: ids() }
			)
		);
		const finished = out.at(-1);
		expect(
			finished?.type === "RUN_FINISHED" ? finished.interrupt : undefined
		).toEqual({
			id: "auth_gmail",
			reason: "auth_required",
			payload: { tool: "gmail", url: "https://connect.example/gmail" },
		});
	});

	it("reports a thrown source as RUN_ERROR", async () => {
		async function* broken(): AsyncGenerator<AgentEvent> {
			yield { type: "text", content: "x" };
			throw new Error("socket closed");
		}
		const out = await collect(
			agentEventsToAgUi(broken(), {
				threadId: "t",
				runId: "r",
				idFactory: ids(),
			})
		);
		expect(out.at(-1)).toEqual({
			type: "RUN_ERROR",
			message: "socket closed",
			code: "stream_failed",
		});
	});
});

function envelope(
	seq: number,
	event: Record<string, unknown> & { type: string }
): HarnessRunEventEnvelope {
	// SAFETY: test fixtures follow Core's harness wire contract.
	return {
		createdAt: "2026-10-21T00:00:00Z",
		id: `ev-${seq}`,
		protocolVersion: "1",
		runId: "run-9",
		seq,
		sessionId: "session-3",
		...event,
	} as HarnessRunEventEnvelope;
}

describe("harnessEventsToAgUi", () => {
	it("reports a stream that fails before its first event as a whole run", async () => {
		const failing: AsyncIterable<HarnessRunEventEnvelope> = {
			[Symbol.asyncIterator]: () => ({
				next: () => Promise.reject(new Error("events unavailable")),
			}),
		};
		const out = await collect(
			harnessEventsToAgUi(failing, { threadId: "t", runId: "r" })
		);
		expect(out).toEqual([
			{ type: "RUN_STARTED", threadId: "t", runId: "r" },
			{
				type: "RUN_ERROR",
				message: "events unavailable",
				code: "stream_failed",
			},
		]);
	});

	it("maps the durable harness stream, defaulting ids to the session and run", async () => {
		const out = await collect(
			harnessEventsToAgUi(
				from([
					envelope(1, {
						type: "run_started",
						executionProfile: {
							kind: "local",
							network: "inherit",
							sandbox: "inherit",
							approval: "inherit",
						},
					}),
					envelope(2, { type: "text_delta", delta: "Working" }),
					envelope(3, {
						type: "tool_call_started",
						toolCallId: "tc",
						name: "fs.read",
					}),
					envelope(4, {
						type: "tool_call_completed",
						toolCallId: "tc",
						name: "fs.read",
						ok: true,
						resultHash: "abc",
					}),
					envelope(5, { type: "checkpoint", messageId: "m1" }),
					envelope(6, { type: "text_delta", delta: "Done" }),
					envelope(7, { type: "run_completed", output: { ok: 1 } }),
				]),
				{ idFactory: ids() }
			)
		);
		expect(out[0]).toEqual({
			type: "RUN_STARTED",
			threadId: "session-3",
			runId: "run-9",
		});
		expect(out.map((event) => event.type)).toEqual([
			"RUN_STARTED",
			"STEP_STARTED",
			"TEXT_MESSAGE_START",
			"TEXT_MESSAGE_CONTENT",
			"TEXT_MESSAGE_END",
			"TOOL_CALL_START",
			"TOOL_CALL_END",
			"TOOL_CALL_RESULT",
			"RAW",
			"STEP_FINISHED",
			"STEP_STARTED",
			"TEXT_MESSAGE_START",
			"TEXT_MESSAGE_CONTENT",
			"TEXT_MESSAGE_END",
			"STEP_FINISHED",
			"RUN_FINISHED",
		]);
		const result = out.find((event) => event.type === "TOOL_CALL_RESULT");
		expect(result?.type === "TOOL_CALL_RESULT" && result.content).toBe(
			'{"ok":true,"resultHash":"abc"}'
		);
		expect(out.at(-1)).toEqual({
			type: "RUN_FINISHED",
			threadId: "session-3",
			runId: "run-9",
			outcome: "success",
			result: { ok: 1 },
		});
	});

	it("maps approval, failure, and cancellation", async () => {
		const approval = await collect(
			harnessEventsToAgUi(
				from([
					envelope(1, {
						type: "approval_requested",
						approvalId: "perm-1",
						summary: "Write file?",
						options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
					}),
				])
			)
		);
		const finished = approval.at(-1);
		expect(finished?.type === "RUN_FINISHED" && finished.outcome).toBe(
			"interrupt"
		);
		const failed = await collect(
			harnessEventsToAgUi(
				from([
					envelope(1, {
						type: "run_failed",
						code: "budget",
						message: "over budget",
					}),
				])
			)
		);
		expect(failed.at(-1)).toEqual({
			type: "RUN_ERROR",
			message: "over budget",
			code: "budget",
		});
		const canceled = await collect(
			harnessEventsToAgUi(from([envelope(1, { type: "run_canceled" })]))
		);
		expect(canceled.at(-1)).toEqual({
			type: "RUN_ERROR",
			message: "run canceled",
			code: "canceled",
		});
	});
});

describe("SSE codec", () => {
	it("round-trips events through data: records", () => {
		const events: AgUiEvent[] = [
			{ type: "RUN_STARTED", threadId: "t", runId: "r" },
			{ type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "a\nb" },
		];
		const body = events.map(encodeAgUiEvent).join("");
		expect(body.startsWith("data: {")).toBe(true);
		expect(parseAgUiStream(body)).toEqual(events);
	});

	it("rejects unknown event types", () => {
		expect(() => parseAgUiStream('data: {"type":"NOPE"}\n\n')).toThrow();
	});
});
