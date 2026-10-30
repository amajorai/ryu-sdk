/**
 * The `workflow` and `multi-agent` templates are `createRyuServer` projects:
 * scaffold each one, load its `src/ryu.ts` into the real server, and drive it
 * over HTTP the way `ryu dev --studio` and a `ryu build` deployment do. The
 * gateway is a stubbed `fetch` that answers chat completions, so no node or
 * model is needed.
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveRyuServer } from "@ryuhq/sdk/server";
import { z } from "zod";
import { scaffold } from "./index.ts";

const ROOT = join(import.meta.dir, `__studio-${process.pid}`);
const replySchema = z.record(z.string(), z.unknown());

let originalFetch: typeof globalThis.fetch;
interface ScriptedToolCall {
	args: unknown;
	name: string;
}
/** A gateway reply: plain text, or one tool call. */
let replies: (string | ScriptedToolCall)[] = [];
let callCount = 0;

beforeEach(() => {
	originalFetch = globalThis.fetch;
	replies = [];
	globalThis.fetch = Object.assign(
		(
			input: Parameters<typeof globalThis.fetch>[0],
			init?: Parameters<typeof globalThis.fetch>[1]
		) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.includes("/v1/chat/completions")) {
				const next = replies.shift() ?? "ok";
				if (typeof next === "string") {
					return Promise.resolve(
						Response.json({
							choices: [{ finish_reason: "stop", message: { content: next } }],
						})
					);
				}
				callCount += 1;
				return Promise.resolve(
					Response.json({
						choices: [
							{
								finish_reason: "tool_calls",
								message: {
									content: null,
									tool_calls: [
										{
											id: `call_${callCount}`,
											type: "function",
											function: {
												name: next.name,
												arguments: JSON.stringify(next.args),
											},
										},
									],
								},
							},
						],
					})
				);
			}
			return originalFetch(input, init);
		},
		{ preconnect: originalFetch.preconnect }
	);
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

beforeAll(() => {
	process.env.RYU_GATEWAY_URL = "http://127.0.0.1:7981";
});

afterAll(() => {
	if (existsSync(ROOT)) {
		rmSync(ROOT, { recursive: true, force: true });
	}
});

function post(path: string, body: unknown) {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("workflow template", () => {
	it("scripts the studio and build, and its workflow suspends for review and resumes", async () => {
		const projectDir = scaffold("triage-demo", ROOT, "workflow");
		const pkg = z
			.object({
				scripts: z.record(z.string(), z.string()),
				dependencies: z.record(z.string(), z.string()),
			})
			.parse(
				JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8"))
			);
		expect(pkg.scripts.dev).toBe("bunx ryu dev --studio src/ryu.ts");
		expect(pkg.scripts.build).toBe("bunx ryu build src/ryu.ts --target node");
		expect(pkg.dependencies.zod).toBeDefined();

		const server = resolveRyuServer(
			await import(join(projectDir, "src/ryu.ts")),
			{
				studio: true,
			}
		);
		const listed = replySchema.parse(
			await (
				await server.fetch(new Request("http://localhost/api/workflows/triage"))
			).json()
		);
		expect(listed.graph).toMatchObject({
			nodes: [
				{ id: "classify" },
				{ id: "draft" },
				{ id: "review" },
				{ id: "send" },
			],
		});

		replies = ["Sorry about the double charge — your refund is on its way."];
		const started = replySchema.parse(
			await (
				await server.fetch(
					post("/api/workflows/triage/start", {
						inputData: {
							customer: "ana@example.com",
							ticket: "I was charged twice",
						},
					})
				)
			).json()
		);
		expect(started).toMatchObject({
			status: "suspended",
			suspended: [
				{
					stepId: "review",
					payload: {
						draft: "Sorry about the double charge — your refund is on its way.",
					},
				},
			],
		});

		const resumed = replySchema.parse(
			await (
				await server.fetch(
					post(`/api/workflows/triage/runs/${String(started.runId)}/resume`, {
						resumeData: { approved: true, edits: "Refund issued." },
					})
				)
			).json()
		);
		expect(resumed).toMatchObject({
			status: "success",
			result: { to: "ana@example.com", sent: true, reply: "Refund issued." },
		});

		const policy = replySchema.parse(
			await (
				await server.fetch(
					post("/api/tools/lookupPolicy/execute", {
						input: { category: "bug" },
					})
				)
			).json()
		);
		expect(policy.output).toMatchObject({ category: "bug" });
	});
});

describe("multi-agent template", () => {
	it("serves the supervisor team and its members", async () => {
		const projectDir = scaffold("team-demo", ROOT, "multi-agent");
		const server = resolveRyuServer(
			await import(join(projectDir, "src/ryu.ts"))
		);
		const { agents } = z
			.object({ agents: z.array(z.record(z.string(), z.unknown())) })
			.parse(
				await (
					await server.fetch(new Request("http://localhost/api/agents"))
				).json()
			);
		expect(agents.map((agent) => agent.id)).toEqual([
			"team",
			"researcher",
			"writer",
		]);
		expect(agents[0]).toMatchObject({
			kind: "network",
			entry: "team",
			members: ["team", "researcher", "writer"],
		});
		expect(agents[2]).toMatchObject({
			tools: [{ name: "publish", needsApproval: true }],
		});

		replies = ["Here is the plan."];
		const answer = replySchema.parse(
			await (
				await server.fetch(
					post("/api/agents/team/generate", { prompt: "Brief me" })
				)
			).json()
		);
		expect(answer).toMatchObject({
			status: "success",
			text: "Here is the plan.",
			agent: "team",
		});
	});

	it("pauses the team's publish call until the studio approves it", async () => {
		const projectDir = scaffold("team-approve", ROOT, "multi-agent");
		const server = resolveRyuServer(
			await import(join(projectDir, "src/ryu.ts"))
		);
		replies = [
			{ name: "transfer_to_writer", args: { reason: "write it" } },
			{ name: "publish", args: { title: "Brief", body: "Solid state wins." } },
			"Published the brief.",
			"The writer published it.",
		];
		const response = await server.fetch(
			post("/api/agents/team/stream", { prompt: "Write and publish a brief" })
		);
		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error("no stream");
		}
		const decoder = new TextDecoder();
		const events: { data: Record<string, unknown>; event: string }[] = [];
		let buffer = "";
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			let index = buffer.indexOf("\n\n");
			while (index >= 0) {
				const frame = buffer.slice(0, index);
				buffer = buffer.slice(index + 2);
				const event = /^event: (.*)$/m.exec(frame)?.[1];
				const data = /^data: (.*)$/m.exec(frame)?.[1];
				if (event && data) {
					const parsed = replySchema.parse(JSON.parse(data));
					events.push({ event, data: parsed });
					if (event === "approval_requested") {
						const decided = await server.fetch(
							post(`/api/approvals/${String(parsed.approvalId)}`, {
								approved: true,
							})
						);
						expect(decided.status).toBe(200);
					}
				}
				index = buffer.indexOf("\n\n");
			}
		}
		expect(
			events.find((e) => e.event === "approval_requested")?.data
		).toMatchObject({ agent: "writer", name: "publish" });
		expect(
			events.find((e) => e.event === "tool_result" && e.data.name === "publish")
				?.data
		).toMatchObject({ output: { published: true, title: "Brief", words: 3 } });
		expect(events.at(-1)).toMatchObject({
			event: "done",
			data: { status: "success" },
		});
	});
});
