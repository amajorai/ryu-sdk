import { describe, expect, it } from "bun:test";
import { PluginManifestSchema } from "../manifest.ts";
import { defineAction } from "./action.ts";
import type { GatewayClient, RunnableContext } from "./runnable-types.ts";

const gateway: GatewayClient = {
	chat: async () => ({ content: "ok", finishReason: "stop" }),
	async *stream() {
		yield { content: "ok", finishReason: null };
	},
};

const context: RunnableContext = { gateway };

const ticketAction = defineAction({
	id: "action-create-ticket",
	name: "Create Ticket",
	description: "Create a support ticket for a customer.",
	schema: {
		type: "object",
		properties: {
			customer: { type: "string" },
			summary: { type: "string" },
		},
		required: ["customer", "summary"],
	},
	outputSchema: {
		type: "object",
		properties: {
			id: { type: "string" },
		},
		required: ["id"],
	},
	effect: "mutate",
	needsApproval: true,
	run: async ({ customer, summary }) => ({
		id: `${customer}:${summary}`,
	}),
});

describe("defineAction", () => {
	it("returns a governed action with the same Runnable execution contract", async () => {
		expect(ticketAction.kind).toBe("tool");
		expect(ticketAction.action).toBe(true);
		expect(ticketAction.description).toBe(
			"Create a support ticket for a customer."
		);
		expect(ticketAction.schema.required).toEqual(["customer", "summary"]);
		expect(ticketAction.outputSchema?.required).toEqual(["id"]);
		expect(ticketAction.annotations).toEqual({
			destructiveHint: true,
			readOnlyHint: false,
		});
		expect(ticketAction.needsApproval).toBe(true);
		expect(
			await ticketAction.run({ customer: "acme", summary: "Login" }, context)
		).toEqual({ id: "acme:Login" });
	});

	it("rejects an action whose declared effect conflicts with its annotations", () => {
		expect(() =>
			defineAction({
				id: "action-conflict",
				name: "Conflicting Action",
				description: "An invalid action.",
				schema: { type: "object", properties: {} },
				effect: "read",
				annotations: { destructiveHint: true },
				run: async () => null,
			})
		).toThrow(/destructiveHint/);
	});

	it("lowers to a Core-compatible governed inline tool manifest", () => {
		const manifest = ticketAction.toManifest({
			id: "com.example.support",
			version: "1.0.0",
			grants: ["storage:kv"],
		});

		expect(() => PluginManifestSchema.parse(manifest)).not.toThrow();
		expect(manifest.permission_grants).toEqual(["storage:kv", "tool:execute"]);
		expect(manifest.runnables).toHaveLength(1);
		expect(manifest.runnables[0]).toMatchObject({
			id: "action-create-ticket",
			name: "Create Ticket",
			kind: "tool",
		});
		expect(manifest.runnables[0]?.config).toMatchObject({
			slug: "action-create-ticket",
			backend: "inline_js",
			action: true,
			description: "Create a support ticket for a customer.",
			input_schema: ticketAction.schema,
			output_schema: ticketAction.outputSchema,
			annotations: ticketAction.annotations,
			needs_approval: true,
		});
	});

	it("adapts the same implementation to the SDK MCP server", async () => {
		const mcpTool = ticketAction.toMcpTool(context);

		expect(mcpTool.name).toBe("action-create-ticket");
		expect(mcpTool.description).toBe("Create a support ticket for a customer.");
		expect(mcpTool.inputSchema).toEqual(ticketAction.schema);
		expect(await mcpTool.run({ customer: "acme", summary: "MCP" })).toEqual({
			id: "acme:MCP",
		});
	});

	it("allows explicit read-only actions without approval", () => {
		const action = defineAction({
			id: "action-find-ticket",
			name: "Find Ticket",
			description: "Find a ticket by id.",
			schema: { type: "object", properties: { id: { type: "string" } } },
			effect: "read",
			run: async ({ id }) => ({ id }),
		});

		expect(action.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
		});
		expect(action.needsApproval).toBe(false);
	});
});

describe("Action MCP JSON boundary", () => {
	it("uses the same JSON representation as the stdio transport", async () => {
		const action = defineAction({
			id: "action-json-result",
			name: "JSON result",
			description: "Return serialized owner fields.",
			schema: { type: "object", properties: {} },
			effect: "read",
			run: async () => ({
				at: new Date("2026-10-06T00:00:00Z"),
				omitted: undefined,
				zero: 0,
				false: false,
			}),
		});
		const direct = await action.run({}, context);
		expect(await action.toMcpTool(context).run({})).toEqual(
			JSON.parse(JSON.stringify(direct))
		);
	});
	it("rejects invalid tool arguments before executing the action", async () => {
		let calls = 0;
		const action = defineAction({
			id: "action-input-contract",
			name: "Input contract",
			description: "Validate before execution.",
			schema: {
				type: "object",
				properties: { count: { type: "number" } },
				required: ["count"],
			},
			effect: "read",
			run: async () => {
				calls += 1;
				return null;
			},
		});
		await expect(
			action.toMcpTool(context).run({ count: "invalid" })
		).rejects.toThrow('expected type "number"');
		expect(calls).toBe(0);
	});
});
