/**
 * Structured output + the repair loop, against a mocked gateway.
 *
 * `globalThis.fetch` is stubbed (the same technique as loop.test.ts): each
 * chat-completions request pops the next canned model reply and is captured so
 * the test can assert what the loop sent back (repair prompts, response_format).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import { defineTool } from "../runnable/tool.ts";
import { withJsonSchema } from "../schema/json-schema.ts";
import type { StandardSchemaV1 } from "../schema/standard-schema.ts";
import { StructuredOutputError } from "../schema/structured-output.ts";
import { Agent } from "./agent.ts";
import type { AgentEvent } from "./loop.ts";
import { runAgentLoop } from "./loop.ts";
import type { ModelRequestBody, ToolCall } from "./model-call.ts";
import { modelBodyFixtureSchema } from "./transport-fixtures.ts";

const NODE = "http://127.0.0.1:7981";
const RE_REPAIR_PROMPT = /did not satisfy the required output schema/;
const RE_AFTER_THREE = /after 3 attempts/;
const RE_STEP_BUDGET = /step budget \(2\) exhausted/;

let modelQueue: unknown[] = [];
let requests: ModelRequestBody[] = [];
let originalFetch: typeof globalThis.fetch;

function reply(content: string | null, toolCalls?: ToolCall[]) {
	return {
		choices: [
			{
				finish_reason: toolCalls ? "tool_calls" : "stop",
				message: { content, tool_calls: toolCalls },
			},
		],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	};
}

beforeEach(() => {
	originalFetch = globalThis.fetch;
	modelQueue = [];
	requests = [];
	globalThis.fetch = Object.assign(
		(
			input: Parameters<typeof globalThis.fetch>[0],
			init?: Parameters<typeof globalThis.fetch>[1]
		) => {
			if (String(input).includes("/v1/chat/completions")) {
				requests.push(
					modelBodyFixtureSchema.parse(JSON.parse(String(init?.body ?? "{}")))
				);
				const next = modelQueue.shift() ?? reply("unscripted");
				return Promise.resolve(
					new Response(JSON.stringify(next), { status: 200 })
				);
			}
			return Promise.resolve(new Response("not found", { status: 404 }));
		},
		{ preconnect: originalFetch.preconnect }
	);
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

async function collect(gen: AsyncGenerator<AgentEvent>) {
	const events: AgentEvent[] = [];
	for await (const event of gen) {
		events.push(event);
	}
	return events;
}

function lastUserMessage(body: ModelRequestBody | undefined): string {
	const users = (body?.messages ?? []).filter(
		(message) => message.role === "user"
	);
	const content = users.at(-1)?.content;
	return typeof content === "string" ? content : "";
}

const Invoice = z.object({
	total: z.number().nonnegative(),
	currency: z.enum(["USD", "EUR"]),
	lines: z.array(z.object({ sku: z.string(), qty: z.number().int() })),
});

describe("Agent structured output", () => {
	it("returns the zod-parsed value and sends response_format", async () => {
		modelQueue = [
			reply('{"total":12.5,"currency":"USD","lines":[{"sku":"a","qty":2}]}'),
		];
		const agent = new Agent({
			name: "invoice",
			model: "gpt-4o",
			node: { baseUrl: NODE },
			outputSchema: Invoice,
		});
		const result = await agent.generate("extract");
		expect(result.output).toEqual({
			total: 12.5,
			currency: "USD",
			lines: [{ sku: "a", qty: 2 }],
		});
		expect(result.output?.lines[0]?.qty).toBe(2);
		expect(requests).toHaveLength(1);
		const format = requests[0]?.response_format;
		expect(format?.type).toBe("json_schema");
		expect(JSON.stringify(format)).toContain('"currency"');
		expect(JSON.stringify(format)).not.toContain("$schema");
	});

	it("re-asks the model with validation issues and succeeds on repair", async () => {
		modelQueue = [
			reply('{"total":-1,"currency":"GBP","lines":[]}'),
			reply('{"total":3,"currency":"EUR","lines":[]}'),
		];
		const events = await collect(
			new Agent({
				name: "repair",
				model: "gpt-4o",
				node: { baseUrl: NODE },
				outputSchema: Invoice,
			}).stream("extract")
		);
		const repairs = events.filter((event) => event.type === "output_repair");
		expect(repairs).toHaveLength(1);
		const repair = repairs[0];
		expect(repair?.type === "output_repair" && repair.attempt).toBe(1);
		const paths =
			repair?.type === "output_repair"
				? repair.issues.map((issue) => issue.path.join("."))
				: [];
		expect(paths).toEqual(expect.arrayContaining(["total", "currency"]));

		expect(requests).toHaveLength(2);
		const prompt = lastUserMessage(requests[1]);
		expect(prompt).toMatch(RE_REPAIR_PROMPT);
		expect(prompt).toContain("- at total:");
		expect(prompt).toContain("- at currency:");
		// The invalid reply stays in the transcript so the model can see it.
		const assistantTurns = requests[1]?.messages.filter(
			(message) => message.role === "assistant"
		);
		expect(assistantTurns).toHaveLength(1);

		const result = events.find((event) => event.type === "result");
		expect(result?.type === "result" && result.output).toEqual({
			total: 3,
			currency: "EUR",
			lines: [],
		});
		expect(result?.type === "result" && result.steps).toBe(2);
	});

	it("repairs a reply that is not JSON at all", async () => {
		modelQueue = [
			reply("Sure! The total is twelve dollars."),
			reply('```json\n{"total":12,"currency":"USD","lines":[]}\n```'),
		];
		const result = await new Agent({
			name: "parse-repair",
			model: "gpt-4o",
			node: { baseUrl: NODE },
			outputSchema: Invoice,
		}).generate("extract");
		expect(result.output?.total).toBe(12);
		expect(lastUserMessage(requests[1])).toContain("not valid JSON");
	});

	it("throws a typed StructuredOutputError after maxRepairAttempts", async () => {
		modelQueue = [reply("nope"), reply("{}"), reply('{"total":"x"}')];
		const agent = new Agent({
			name: "give-up",
			model: "gpt-4o",
			node: { baseUrl: NODE },
			outputSchema: Invoice,
		});
		let caught: unknown;
		try {
			await agent.generate("extract");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(StructuredOutputError);
		const failure = caught instanceof StructuredOutputError ? caught : null;
		expect(failure?.attempts).toBe(3);
		expect(failure?.code).toBe("structured_output_invalid");
		expect(failure?.text).toBe('{"total":"x"}');
		expect(failure?.issues.map((issue) => issue.path[0])).toEqual(
			expect.arrayContaining(["total", "currency", "lines"])
		);
		expect(failure?.message).toMatch(RE_AFTER_THREE);
		// Default budget: 1 original reply + 2 repairs.
		expect(requests).toHaveLength(3);
	});

	it("honours maxRepairAttempts: 0 (fail on the first invalid reply)", async () => {
		modelQueue = [reply("{}")];
		const events = await collect(
			new Agent({
				name: "no-repair",
				model: "gpt-4o",
				node: { baseUrl: NODE },
				outputSchema: Invoice,
				maxRepairAttempts: 0,
			}).stream("extract")
		);
		expect(requests).toHaveLength(1);
		const error = events.at(-1);
		expect(error?.type === "error" && error.code).toBe(
			"structured_output_invalid"
		);
		expect(error?.type === "error" && error.attempts).toBe(1);
	});

	it("validates a plain JSON Schema outputSchema and repairs against it", async () => {
		modelQueue = [reply('{"answer":42}'), reply('{"answer":"forty-two"}')];
		const result = await new Agent({
			name: "json-schema",
			model: "gpt-4o",
			node: { baseUrl: NODE },
			outputSchema: {
				type: "object",
				properties: { answer: { type: "string" } },
				required: ["answer"],
				additionalProperties: false,
			},
		}).generate("answer");
		expect(result.output).toEqual({ answer: "forty-two" });
		expect(lastUserMessage(requests[1])).toContain(
			"- at answer: expected string, received integer"
		);
		// A closed, fully-required schema is sent in strict mode.
		expect(JSON.stringify(requests[0]?.response_format)).toContain(
			'"strict":true'
		);
	});

	it("requests non-strict mode when the schema has optional fields", async () => {
		modelQueue = [reply('{"title":"t"}')];
		await new Agent({
			name: "optional",
			model: "gpt-4o",
			node: { baseUrl: NODE },
			outputSchema: z.object({
				title: z.string(),
				subtitle: z.string().optional(),
			}),
		}).generate("title");
		expect(JSON.stringify(requests[0]?.response_format)).toContain(
			'"strict":false'
		);
	});

	it("repair rounds do not consume the maxSteps tool budget", async () => {
		const lookup = defineTool({
			id: "lookup",
			name: "Lookup",
			schema: z.object({ sku: z.string() }),
			run: async ({ sku }) => ({ sku, price: 4 }),
		});
		modelQueue = [
			reply(null, [
				{
					id: "c1",
					type: "function",
					function: { name: "lookup", arguments: '{"sku":"a"}' },
				},
			]),
			reply("{}"),
			reply('{"total":4,"currency":"USD","lines":[{"sku":"a","qty":1}]}'),
		];
		const result = await new Agent({
			name: "budget",
			model: "gpt-4o",
			node: { baseUrl: NODE },
			maxSteps: 2,
			tools: { lookup },
			outputSchema: Invoice,
		}).generate("price it");
		expect(result.output?.total).toBe(4);
		expect(result.steps).toBe(3);
	});

	it("ends in the typed error when the step budget runs out without output", async () => {
		const lookup = defineTool({
			id: "lookup",
			name: "Lookup",
			schema: z.object({ sku: z.string() }),
			run: async ({ sku }) => ({ sku, price: 4 }),
		});
		const call = (id: string) =>
			reply("checking", [
				{
					id,
					type: "function",
					function: { name: "lookup", arguments: '{"sku":"a"}' },
				},
			]);
		modelQueue = [call("c1"), call("c2")];
		let caught: unknown;
		try {
			await new Agent({
				name: "exhausted",
				model: "gpt-4o",
				node: { baseUrl: NODE },
				maxSteps: 2,
				tools: { lookup },
				outputSchema: Invoice,
			}).generate("price it");
		} catch (error) {
			caught = error;
		}
		expect(requests).toHaveLength(2);
		expect(caught).toBeInstanceOf(StructuredOutputError);
		expect(caught instanceof Error && caught.message).toMatch(RE_STEP_BUDGET);
	});

	it("works through runAgentLoop with a validation-only Standard Schema", async () => {
		// A minimal non-zod Standard Schema (what valibot/arktype also implement),
		// paired with its JSON Schema via withJsonSchema.
		const evenNumber: StandardSchemaV1<unknown, { n: number }> = {
			"~standard": {
				version: 1,
				vendor: "hand-rolled",
				validate: (value) => {
					const n =
						typeof value === "object" && value !== null
							? Reflect.get(value, "n")
							: undefined;
					return typeof n === "number" && n % 2 === 0
						? { value: { n } }
						: { issues: [{ message: "n must be even", path: ["n"] }] };
				},
			},
		};
		modelQueue = [reply('{"n":3}'), reply('{"n":4}')];
		const events = await collect(
			runAgentLoop({
				model: "gpt-4o",
				gatewayBaseUrl: NODE,
				maxSteps: 3,
				messages: [{ role: "user", content: "even please" }],
				outputSchema: withJsonSchema(evenNumber, {
					type: "object",
					properties: { n: { type: "integer" } },
					required: ["n"],
				}),
				tools: {},
				toolCtx: {
					coreBaseUrl: "http://127.0.0.1:7980",
					runnableContext: {
						gateway: {
							chat: () => Promise.reject(new Error("unused")),
							async *stream() {
								// no local tools call the gateway here
							},
						},
					},
				},
			})
		);
		expect(lastUserMessage(requests[1])).toContain("- at n: n must be even");
		const result = events.at(-1);
		expect(result?.type === "result" && result.output).toEqual({ n: 4 });
	});

	it("rejects an outputSchema that cannot be expressed as JSON Schema", () => {
		expect(
			() =>
				new Agent({
					name: "bad",
					model: "gpt-4o",
					outputSchema: z.object({ when: z.date() }),
				})
		).toThrow("cannot be represented as JSON Schema");
	});
});
