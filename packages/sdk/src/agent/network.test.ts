/**
 * Unit tests for the multi-agent primitives: agents as tools, handoffs, and
 * agent networks / supervisors.
 *
 * The gateway is stubbed over `fetch`. Each agent uses its own model id, so the
 * stub answers from a per-model queue and records every request body, which
 * lets the tests assert exactly which transcript each agent saw.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { z } from "zod";
import type { PrimitiveJsonValue } from "../runnable/primitive-contracts.ts";
import { Agent } from "./agent.ts";
import type { AgentEvent } from "./loop.ts";
import type { LoopMessage, ToolCall } from "./model-call.ts";
import {
	AgentNetwork,
	createSupervisor,
	handoff,
	handoffToolName,
	type NetworkEvent,
} from "./network.ts";
import { modelBodyFixtureSchema } from "./transport-fixtures.ts";

const NODE = "http://127.0.0.1:7981";

type ModelBody = z.output<typeof modelBodyFixtureSchema>;

let queues: Map<string, unknown[]>;
let requests: ModelBody[];
let originalFetch: typeof globalThis.fetch;

function reply(opts: { content?: string | null; toolCalls?: ToolCall[] }) {
	const toolCalls = opts.toolCalls ?? [];
	return {
		choices: [
			{
				finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
				message: {
					content: opts.content ?? null,
					tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
				},
			},
		],
		usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
	};
}

function call(id: string, name: string, args: PrimitiveJsonValue): ToolCall {
	return {
		id,
		type: "function",
		function: { name, arguments: JSON.stringify(args) },
	};
}

function queue(model: string, ...replies: unknown[]) {
	queues.set(model, [...(queues.get(model) ?? []), ...replies]);
}

function requestsFor(model: string): ModelBody[] {
	return requests.filter((body) => body.model === model);
}

function agent(
	name: string,
	extra: Partial<ConstructorParameters<typeof Agent>[0]> = {}
): Agent {
	return new Agent({
		name,
		model: `m-${name}`,
		instructions: `You are ${name}.`,
		node: { baseUrl: NODE },
		core: { baseUrl: NODE },
		...extra,
	});
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
	const events: T[] = [];
	for await (const event of gen) {
		events.push(event);
	}
	return events;
}

beforeEach(() => {
	originalFetch = globalThis.fetch;
	queues = new Map();
	requests = [];
	globalThis.fetch = Object.assign(
		(
			input: Parameters<typeof globalThis.fetch>[0],
			init?: Parameters<typeof globalThis.fetch>[1]
		) => {
			const url = String(input);
			if (!url.includes("/v1/chat/completions")) {
				return Promise.resolve(new Response("not found", { status: 404 }));
			}
			const body = modelBodyFixtureSchema.parse(
				JSON.parse(String(init?.body ?? "{}"))
			);
			requests.push(body);
			const next = queues.get(body.model)?.shift();
			if (next === undefined) {
				return Promise.resolve(
					new Response(`no queued reply for ${body.model}`, { status: 500 })
				);
			}
			return Promise.resolve(
				new Response(JSON.stringify(next), { status: 200 })
			);
		},
		{ preconnect: originalFetch.preconnect }
	);
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

const roles = (messages: readonly LoopMessage[]) =>
	messages.map((message) => message.role);

describe("agent.asTool", () => {
	it("runs the child agent and returns its answer as the tool result", async () => {
		const researcher = agent("researcher", {
			description: "Finds facts about a topic.",
		});
		const lead = agent("lead", {
			tools: { research: researcher.asTool() },
		});
		queue(
			"m-lead",
			reply({
				toolCalls: [call("c1", "research", { prompt: "capital of France?" })],
			}),
			reply({ content: "The capital is Paris." })
		);
		queue("m-researcher", reply({ content: "Paris" }));

		const events = await collect(lead.stream("Where is the Louvre?"));
		const toolResult = events.find((event) => event.type === "tool_result");
		expect(toolResult).toMatchObject({ name: "research", output: "Paris" });
		expect(events.at(-1)).toMatchObject({
			type: "result",
			text: "The capital is Paris.",
		});

		const [childRequest] = requestsFor("m-researcher");
		expect(childRequest?.messages).toEqual([
			{ role: "system", content: "You are researcher." },
			{ role: "user", content: "capital of France?" },
		]);
		const toolDef = requestsFor("m-lead")[0]?.tools?.[0];
		expect(toolDef?.function.name).toBe("research");
		expect(toolDef?.function.description).toBe("Finds facts about a topic.");
		expect(toolDef?.function.parameters).toMatchObject({
			required: ["prompt"],
		});
	});

	it("sends custom-schema arguments to the child as JSON", async () => {
		const pricer = agent("pricer");
		const lead = agent("lead", {
			tools: {
				price: pricer.asTool({
					description: "Price a SKU",
					inputSchema: {
						type: "object",
						properties: { sku: { type: "string" } },
						required: ["sku"],
					},
				}),
			},
		});
		queue(
			"m-lead",
			reply({ toolCalls: [call("c1", "price", { sku: "A-1" })] }),
			reply({ content: "done" })
		);
		queue("m-pricer", reply({ content: "$4" }));

		await lead.generate("price A-1");
		expect(requestsFor("m-pricer")[0]?.messages.at(-1)).toEqual({
			role: "user",
			content: '{"sku":"A-1"}',
		});
	});

	it("reports a child failure to the calling model as a tool error", async () => {
		const flaky = agent("flaky");
		const lead = agent("lead", { tools: { ask: flaky.asTool() } });
		queue(
			"m-lead",
			reply({ toolCalls: [call("c1", "ask", { prompt: "hi" })] }),
			reply({ content: "recovered" })
		);
		// No queued reply for m-flaky → the gateway stub answers 500.

		const events = await collect(lead.stream("go"));
		const toolResult = events.find((event) => event.type === "tool_result");
		expect(JSON.stringify(toolResult)).toContain("flaky");
		expect(events.at(-1)).toMatchObject({ type: "result", text: "recovered" });
	});
});

describe("handoff", () => {
	it("transfers the conversation, transcript included, inside one run", async () => {
		const billing = agent("billing", { description: "Invoices and refunds" });
		const triage = agent("triage", {
			tools: { transfer_to_billing: handoff(billing) },
		});
		queue(
			"m-triage",
			reply({
				content: "Let me get billing.",
				toolCalls: [
					call("h1", "transfer_to_billing", { reason: "refund request" }),
				],
			})
		);
		queue("m-billing", reply({ content: "Refund issued." }));

		const result = await triage.generate("I was charged twice");
		expect(result.text).toBe("Refund issued.");
		// The handoff never costs a second triage model call.
		expect(requestsFor("m-triage")).toHaveLength(1);
		const handoffDef = requestsFor("m-triage")[0]?.tools?.[0];
		expect(handoffDef?.function.description).toBe(
			"Hand the conversation to the billing agent: Invoices and refunds"
		);

		const billingMessages = requestsFor("m-billing")[0]?.messages ?? [];
		expect(roles(billingMessages)).toEqual([
			"system",
			"user",
			"assistant",
			"tool",
		]);
		expect(billingMessages[0]).toEqual({
			role: "system",
			content: "You are billing.",
		});
		expect(billingMessages[3]).toEqual({
			role: "tool",
			tool_call_id: "h1",
			content: '{"transferred_to":"billing"}',
		});
	});

	it("does not fail a structured-output agent that hands off", async () => {
		const specialist = agent("specialist");
		const router = agent("router", {
			outputSchema: { type: "object", properties: {} },
			tools: { go: handoff(specialist) },
		});
		queue("m-router", reply({ toolCalls: [call("h1", "go", {})] }));
		queue("m-specialist", reply({ content: "handled" }));

		const events = await collect(router.stream("help"));
		expect(events.some((event) => event.type === "error")).toBe(false);
		expect(events.at(-1)).toMatchObject({ type: "result", text: "handled" });
	});

	it("carries the handoff tool result even when the step cap ends the turn", async () => {
		const target = agent("target");
		const source = agent("source", {
			maxSteps: 1,
			tools: { go: handoff(target) },
		});
		queue("m-source", reply({ toolCalls: [call("h1", "go", {})] }));
		queue("m-target", reply({ content: "ok" }));

		const result = await source.generate("start");
		expect(result.text).toBe("ok");
		expect(roles(requestsFor("m-target")[0]?.messages ?? [])).toEqual([
			"system",
			"user",
			"assistant",
			"tool",
		]);
	});

	it("does not carry the transferring agent's afterTurn follow-up", async () => {
		const target = agent("target");
		const source = agent("source", {
			tools: { go: handoff(target) },
			middleware: [{ afterTurn: () => ({ continue: "one more thing" }) }],
		});
		queue("m-source", reply({ toolCalls: [call("h1", "go", {})] }));
		queue("m-target", reply({ content: "ok" }));

		const result = await source.generate("start");
		expect(result.text).toBe("ok");
		expect(requestsFor("m-source")).toHaveLength(1);
		expect(roles(requestsFor("m-target")[0]?.messages ?? [])).toEqual([
			"system",
			"user",
			"assistant",
			"tool",
		]);
	});

	it("throws when executed outside an agent run", async () => {
		const tool = handoff(agent("x"));
		await expect(
			tool.run({}, { gateway: { chat: never, stream: neverStream } })
		).rejects.toThrow(/only runs inside an SDK agent run/);
	});
});

function never(): never {
	throw new Error("unused");
}

function neverStream(): never {
	throw new Error("unused");
}

describe("AgentNetwork", () => {
	it("tags every event with the active agent and reports handoffs", async () => {
		const second = agent("second");
		const first = agent("first", { tools: { next: handoff(second) } });
		const network = new AgentNetwork({ agents: [first, second] });
		queue(
			"m-first",
			reply({ content: "passing", toolCalls: [call("h1", "next", {})] })
		);
		queue("m-second", reply({ content: "final" }));

		const events = await collect(network.stream("hello"));
		expect(events.map((event) => [event.type, event.agent])).toEqual([
			["text", "first"],
			["tool_call", "first"],
			["tool_result", "first"],
			["handoff", "first"],
			["text", "second"],
			["result", "second"],
		]);
		const final = events.at(-1);
		expect(final).toMatchObject({
			type: "result",
			text: "final",
			activations: 2,
			maxStepsReached: false,
			steps: 2,
		});
		const handoffEvent = events.find((event) => event.type === "handoff");
		expect(handoffEvent).toMatchObject({ from: "first", to: "second" });
	});

	it("rejects a handoff to an agent outside the network", async () => {
		const outsider = agent("outsider");
		const member = agent("member", { tools: { out: handoff(outsider) } });
		const network = new AgentNetwork({ agents: [member] });
		queue("m-member", reply({ toolCalls: [call("h1", "out", {})] }));

		await expect(network.generate("go")).rejects.toThrow(
			/not a member of this network/
		);
	});

	it("requires unique member names", () => {
		expect(
			() => new AgentNetwork({ agents: [agent("dup"), agent("dup")] })
		).toThrow(/unique names/);
	});
});

describe("createSupervisor", () => {
	it("routes to a member and returns control to the supervisor", async () => {
		const researcher = agent("researcher", {
			description: "Looks things up.",
		});
		const team = createSupervisor({
			model: "m-supervisor",
			node: { baseUrl: NODE },
			core: { baseUrl: NODE },
			agents: [researcher],
		});
		const transfer = handoffToolName(researcher);
		queue(
			"m-supervisor",
			reply({ toolCalls: [call("s1", transfer, { reason: "needs facts" })] }),
			reply({ content: "Final: water boils at 100C." })
		);
		queue("m-researcher", reply({ content: "100C at sea level" }));

		const events: NetworkEvent[] = await collect(
			team.stream("At what temperature does water boil?")
		);
		const handoffs = events.filter((event) => event.type === "handoff");
		expect(handoffs).toEqual([
			{
				type: "handoff",
				agent: "supervisor",
				from: "supervisor",
				to: "researcher",
				reason: "needs facts",
			},
			{
				type: "handoff",
				agent: "researcher",
				from: "researcher",
				to: "supervisor",
				reason: "completed",
			},
		]);
		expect(events.at(-1)).toMatchObject({
			type: "result",
			agent: "supervisor",
			text: "Final: water boils at 100C.",
			activations: 3,
		});

		const [first, second] = requestsFor("m-supervisor");
		const system = first?.messages[0];
		expect(system?.role).toBe("system");
		expect(JSON.stringify(system)).toContain(
			`researcher (call ${transfer}): Looks things up.`
		);
		expect(first?.tools?.map((tool) => tool.function.name)).toEqual([transfer]);
		// The member's reply is followed by a user-role note, so the supervisor's
		// request never ends on an assistant message (a prefill on some providers).
		expect(second?.messages.at(-2)).toEqual({
			role: "assistant",
			content: "100C at sea level",
		});
		const note = second?.messages.at(-1);
		expect(note?.role).toBe("user");
		expect(JSON.stringify(note)).toContain("researcher finished its turn");
		expect(team.supervisor.config.name).toBe("supervisor");
	});

	it("stops at the activation cap", async () => {
		const worker = agent("worker");
		const team = createSupervisor({
			model: "m-supervisor",
			node: { baseUrl: NODE },
			agents: [worker],
			maxSteps: 3,
		});
		const transfer = handoffToolName(worker);
		queue(
			"m-supervisor",
			reply({ toolCalls: [call("s1", transfer, {})] }),
			reply({ toolCalls: [call("s2", transfer, {})] })
		);
		queue("m-worker", reply({ content: "partial" }));

		const result = await team.generate("loop forever");
		expect(result.maxStepsReached).toBe(true);
		expect(result.activations).toBe(3);
		expect(result.text).toBe("partial");
	});

	it("can be used as a tool of another agent", async () => {
		const worker = agent("worker");
		const team = createSupervisor({
			model: "m-supervisor",
			node: { baseUrl: NODE },
			agents: [worker],
			description: "A research team.",
		});
		const outer = agent("outer", { tools: { team: team.asTool() } });
		queue(
			"m-outer",
			reply({ toolCalls: [call("o1", "team", { prompt: "q" })] }),
			reply({ content: "outer done" })
		);
		queue("m-supervisor", reply({ content: "team answer" }));

		const events: AgentEvent[] = await collect(outer.stream("ask the team"));
		expect(events.find((event) => event.type === "tool_result")).toMatchObject({
			output: "team answer",
		});
		expect(requestsFor("m-outer")[0]?.tools?.[0]?.function.description).toBe(
			"A research team."
		);
	});
});
