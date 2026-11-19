import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { StructuredOutputError } from "../schema/structured-output.ts";
import { Agent } from "./agent.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("Agent durable session projection", () => {
	test("starts a Core harness run and maps replayable events", async () => {
		const requests: Array<{ body?: string; url: string }> = [];
		globalThis.fetch = Object.assign(
			(
				input: Parameters<typeof globalThis.fetch>[0],
				init?: Parameters<typeof globalThis.fetch>[1]
			) => {
				const url = String(input);
				requests.push({ body: init?.body?.toString(), url });
				if (url.endsWith("/api/harness/sessions/sess-1/runs")) {
					return Promise.resolve(
						Response.json({
							created: true,
							eventsUrl: "/api/harness/runs/run-1/events",
							protocolVersion: "ryu.harness.v1",
							run: {
								attempt: 1,
								createdAt: "2026-09-01T00:00:00Z",
								eventCursor: 1,
								executionProfile: {
									approval: "inherit",
									kind: "local",
									network: "inherit",
									sandbox: "inherit",
									worktreeIsolation: false,
								},
								id: "run-1",
								protocolVersion: "ryu.harness.v1",
								sessionId: "sess-1",
								status: "running",
							},
						})
					);
				}
				const frames = [
					{
						createdAt: "2026-09-01T00:00:00Z",
						id: "evt-1",
						protocolVersion: "ryu.harness.v1",
						runId: "run-1",
						seq: 1,
						sessionId: "sess-1",
						type: "run_started",
						executionProfile: {
							approval: "inherit",
							kind: "local",
							network: "inherit",
							sandbox: "inherit",
							worktreeIsolation: false,
						},
					},
					{
						createdAt: "2026-09-01T00:00:01Z",
						id: "evt-2",
						protocolVersion: "ryu.harness.v1",
						runId: "run-1",
						seq: 2,
						sessionId: "sess-1",
						type: "text_delta",
						delta: "hello",
					},
					{
						createdAt: "2026-09-01T00:00:02Z",
						id: "evt-3",
						protocolVersion: "ryu.harness.v1",
						runId: "run-1",
						seq: 3,
						sessionId: "sess-1",
						type: "run_completed",
					},
				]
					.map((frame) => `event: run\ndata: ${JSON.stringify(frame)}\n\n`)
					.join("");
				return Promise.resolve(
					new Response(frames, {
						headers: { "content-type": "text/event-stream" },
					})
				);
			},
			{ preconnect: realFetch.preconnect }
		);

		const events: string[] = [];
		const result = await new Agent({
			core: { baseUrl: "http://127.0.0.1:7980" },
			model: "unused",
			name: "durable",
			sessionId: "sess-1",
		}).generate("say hello");
		// `generate` consumes the stream, so verify the wire request and terminal
		// result instead of duplicating the stream collection here.
		events.push(...requests.map((request) => request.url));
		expect(result.text).toBe("hello");
		expect(events).toEqual([
			"http://127.0.0.1:7980/api/harness/sessions/sess-1/runs",
			"http://127.0.0.1:7980/api/harness/runs/run-1/events?after=0",
		]);
		expect(requests[0]?.body).toContain('"prompt":"say hello"');
	});

	test("forwards the double-texting strategy and waits through the queue", async () => {
		const requests: Array<{ body?: string; url: string }> = [];
		const profile = {
			approval: "inherit",
			kind: "local",
			network: "inherit",
			sandbox: "inherit",
			worktreeIsolation: false,
		};
		const envelope = (seq: number) => ({
			createdAt: "2026-09-01T00:00:00Z",
			id: `evt-${seq}`,
			protocolVersion: "ryu.harness.v1",
			runId: "run-2",
			seq,
			sessionId: "sess-1",
		});
		globalThis.fetch = Object.assign(
			(
				input: Parameters<typeof globalThis.fetch>[0],
				init?: Parameters<typeof globalThis.fetch>[1]
			) => {
				const url = String(input);
				requests.push({ body: init?.body?.toString(), url });
				if (url.endsWith("/api/harness/sessions/sess-1/runs")) {
					return Promise.resolve(
						Response.json({
							created: true,
							eventsUrl: "/api/harness/runs/run-2/events",
							protocolVersion: "ryu.harness.v1",
							queued: true,
							run: {
								attempt: 2,
								createdAt: "2026-09-01T00:00:00Z",
								eventCursor: 1,
								executionProfile: profile,
								id: "run-2",
								multitaskStrategy: "enqueue",
								protocolVersion: "ryu.harness.v1",
								sessionId: "sess-1",
								status: "pending",
							},
						})
					);
				}
				const frames = [
					{
						...envelope(1),
						type: "run_queued",
						activeRunId: "run-1",
						position: 1,
						strategy: "enqueue",
					},
					{ ...envelope(2), type: "run_started", executionProfile: profile },
					{ ...envelope(3), type: "text_delta", delta: "after you" },
					{ ...envelope(4), type: "run_completed" },
				]
					.map((frame) => `event: run\ndata: ${JSON.stringify(frame)}\n\n`)
					.join("");
				return Promise.resolve(
					new Response(frames, {
						headers: { "content-type": "text/event-stream" },
					})
				);
			},
			{ preconnect: realFetch.preconnect }
		);

		const result = await new Agent({
			core: { baseUrl: "http://127.0.0.1:7980" },
			model: "unused",
			multitaskStrategy: "enqueue",
			name: "durable",
			sessionId: "sess-1",
		}).generate("one more thing");
		expect(result.text).toBe("after you");
		expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
			input: { prompt: "one more thing" },
			multitaskStrategy: "enqueue",
		});
	});

	test("resolves a native approval through the SDK handler", async () => {
		const requests: Array<{ body?: string; url: string }> = [];
		globalThis.fetch = Object.assign(
			(
				input: Parameters<typeof globalThis.fetch>[0],
				init?: Parameters<typeof globalThis.fetch>[1]
			) => {
				const url = String(input);
				requests.push({ body: init?.body?.toString(), url });
				if (url.endsWith("/api/harness/sessions/sess-1/runs")) {
					return Promise.resolve(
						Response.json({
							created: true,
							eventsUrl: "/api/harness/runs/run-2/events",
							protocolVersion: "ryu.harness.v1",
							run: {
								attempt: 1,
								createdAt: "2026-09-01T00:00:00Z",
								eventCursor: 1,
								executionProfile: {
									approval: "inherit",
									kind: "local",
									network: "inherit",
									sandbox: "inherit",
									worktreeIsolation: false,
								},
								id: "run-2",
								protocolVersion: "ryu.harness.v1",
								sessionId: "sess-1",
								status: "running",
							},
						})
					);
				}
				if (url.endsWith("/api/chat/permission")) {
					return Promise.resolve(Response.json({ resolved: true }));
				}
				const frames = [
					{
						createdAt: "2026-09-01T00:00:00Z",
						id: "evt-1",
						protocolVersion: "ryu.harness.v1",
						runId: "run-2",
						seq: 1,
						sessionId: "sess-1",
						type: "run_started",
						executionProfile: {
							approval: "inherit",
							kind: "local",
							network: "inherit",
							sandbox: "inherit",
							worktreeIsolation: false,
						},
					},
					{
						approvalId: "perm-2",
						createdAt: "2026-09-01T00:00:01Z",
						id: "evt-2",
						options: [
							{
								kind: "allow_once",
								name: "Allow once",
								optionId: "allow-once",
							},
						],
						protocolVersion: "ryu.harness.v1",
						runId: "run-2",
						seq: 2,
						sessionId: "sess-1",
						summary: "Permission is required",
						type: "approval_requested",
					},
					{
						createdAt: "2026-09-01T00:00:02Z",
						id: "evt-3",
						protocolVersion: "ryu.harness.v1",
						runId: "run-2",
						seq: 3,
						sessionId: "sess-1",
						type: "text_delta",
						delta: "approved",
					},
					{
						createdAt: "2026-09-01T00:00:03Z",
						id: "evt-4",
						protocolVersion: "ryu.harness.v1",
						runId: "run-2",
						seq: 4,
						sessionId: "sess-1",
						type: "run_completed",
					},
				]
					.map((frame) => `event: run\ndata: ${JSON.stringify(frame)}\n\n`)
					.join("");
				return Promise.resolve(
					new Response(frames, {
						headers: { "content-type": "text/event-stream" },
					})
				);
			},
			{ preconnect: realFetch.preconnect }
		);

		const result = await new Agent({
			approvalHandler: async (request) => {
				expect(request.options?.[0]?.optionId).toBe("allow-once");
				return "allow-once";
			},
			core: { baseUrl: "http://127.0.0.1:7980" },
			model: "unused",
			name: "durable",
			sessionId: "sess-1",
		}).generate("continue");

		expect(result.text).toBe("approved");
		expect(result.approvalRequired?.approvalId).toBe("perm-2");
		expect(
			requests.some((request) => request.url.endsWith("/api/chat/permission"))
		).toBe(true);
		expect(requests.at(-1)?.body).toContain('"option_id":"allow-once"');
	});
});

describe("Agent durable session structured output", () => {
	const runRecord = {
		attempt: 1,
		createdAt: "2026-09-01T00:00:00Z",
		eventCursor: 1,
		executionProfile: {
			approval: "inherit",
			kind: "local",
			network: "inherit",
			sandbox: "inherit",
			worktreeIsolation: false,
		},
		id: "run-9",
		protocolVersion: "ryu.harness.v1",
		sessionId: "sess-9",
		status: "running",
	};

	function stubHarness(replyText: string) {
		globalThis.fetch = Object.assign(
			(input: Parameters<typeof globalThis.fetch>[0]) => {
				const url = String(input);
				if (url.endsWith("/api/harness/sessions/sess-9/runs")) {
					return Promise.resolve(
						Response.json({
							created: true,
							eventsUrl: "/api/harness/runs/run-9/events",
							protocolVersion: "ryu.harness.v1",
							run: runRecord,
						})
					);
				}
				const base = {
					protocolVersion: "ryu.harness.v1",
					runId: "run-9",
					sessionId: "sess-9",
				};
				const frames = [
					{
						...base,
						createdAt: "2026-09-01T00:00:01Z",
						id: "evt-1",
						seq: 1,
						type: "text_delta",
						delta: replyText,
					},
					{
						...base,
						createdAt: "2026-09-01T00:00:02Z",
						id: "evt-2",
						seq: 2,
						type: "run_completed",
					},
				]
					.map((frame) => `event: run\ndata: ${JSON.stringify(frame)}\n\n`)
					.join("");
				return Promise.resolve(
					new Response(frames, {
						headers: { "content-type": "text/event-stream" },
					})
				);
			},
			{ preconnect: realFetch.preconnect }
		);
	}

	const answerSchema = z.object({ answer: z.string() });

	test("validates the Core run's final text against outputSchema", async () => {
		stubHarness('{"answer":"yes"}');
		const result = await new Agent({
			core: { baseUrl: "http://127.0.0.1:7980" },
			model: "unused",
			name: "durable-typed",
			sessionId: "sess-9",
			outputSchema: answerSchema,
		}).generate("answer");
		expect(result.output).toEqual({ answer: "yes" });
	});

	test("throws StructuredOutputError once, without repair, for an invalid reply", async () => {
		stubHarness('{"answer":1}');
		let caught: unknown;
		try {
			await new Agent({
				core: { baseUrl: "http://127.0.0.1:7980" },
				model: "unused",
				name: "durable-invalid",
				sessionId: "sess-9",
				outputSchema: answerSchema,
			}).generate("answer");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(StructuredOutputError);
		const failure = caught instanceof StructuredOutputError ? caught : null;
		expect(failure?.attempts).toBe(1);
		expect(failure?.issues.map((issue) => issue.path)).toEqual([["answer"]]);
	});
});
