import { describe, expect, it } from "bun:test";
import { manifest, SUPPORT_INPUT_SCHEMA, supportRenderTool } from "./app.ts";

describe("ResolveDesk support widget", () => {
	it("assembles an executable widget tool", () => {
		const render = manifest.runnables.find(
			(runnable) => runnable.id === "resolvedesk.render"
		);

		expect(render?.config).toMatchObject({
			backend: "inline_deno",
			input_schema: SUPPORT_INPUT_SCHEMA,
			widget: true,
			widget_accessible: true,
		});
		expect(typeof render?.config?.code).toBe("string");
		expect(manifest.contributes?.widgets[0]).toMatchObject({
			tool_id: "resolvedesk.render",
			uri: "ui://widget/resolvedesk.html",
			ui_entry: "src/widget.html",
		});
		expect(manifest.permission_grants).toEqual([
			"hook:side-model",
			"widget:render",
			"tool:execute",
		]);
	});

	it("returns a grounded answer and source without a gateway model", async () => {
		const result = await supportRenderTool.run(
			{ message: "How do refunds work?" },
			{
				gateway: {
					chat: async () => {
						throw new Error("no gateway in this unit test");
					},
					async *stream() {
						yield { content: null, finishReason: null };
						throw new Error("no gateway in this unit test");
					},
				},
			}
		);

		expect(result.isError).toBe(false);
		expect(result.structuredContent.mode).toBe("grounded");
		expect(result.structuredContent.answer).toContain("30 days");
		expect(result.structuredContent.sources[0]?.label).toBe(
			"Billing & refunds"
		);
	});

	it("uses the injected Gateway when the hosted path is available", async () => {
		const calls: Array<Array<{ content: string; role: string }>> = [];
		const result = await supportRenderTool.run(
			{ message: "How do exports work?" },
			{
				gateway: {
					chat: async (messages) => {
						calls.push(messages);
						return {
							content: "Exports are ready from Reports.",
							finishReason: "stop",
						};
					},
					async *stream() {
						yield { content: "", finishReason: "stop" };
					},
				},
			}
		);

		expect(result.structuredContent.mode).toBe("ai");
		expect(result.structuredContent.answer).toBe(
			"Exports are ready from Reports."
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.[1]?.content).toContain("Reports → Export CSV");
	});
});
