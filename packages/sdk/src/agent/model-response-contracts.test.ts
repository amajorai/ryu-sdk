import { expect, test } from "bun:test";
import {
	chatCompletionResponseSchema,
	chatCompletionStreamChunkSchema,
} from "./model-response-contracts.ts";

test("gateway completion ownership retains tool-call identity and tolerant empty replies", () => {
	const tool = {
		id: "call",
		type: "function" as const,
		function: { name: "search", arguments: "{}", future: true },
		future: [1],
	};
	const response = chatCompletionResponseSchema.parse({
		choices: [{ message: { content: null, tool_calls: [tool] } }],
	});
	expect(response.choices?.[0]?.message?.tool_calls?.[0]).toBe(tool);
	expect(chatCompletionResponseSchema.safeParse({}).success).toBe(true);
	expect(
		chatCompletionResponseSchema.safeParse({ choices: null, usage: null })
			.success
	).toBe(true);
	expect(
		chatCompletionResponseSchema.safeParse({ choices: [{ message: null }] })
			.success
	).toBe(true);
	expect(
		chatCompletionResponseSchema.safeParse({
			choices: [{ message: { content: 3 } }],
		}).success
	).toBe(false);
	expect(
		chatCompletionResponseSchema.safeParse({
			choices: [
				{
					message: {
						tool_calls: [{ ...tool, function: { name: 3, arguments: "{}" } }],
					},
				},
			],
		}).success
	).toBe(false);
});

test("gateway streamed deltas validate only the protocol fields the SDK consumes", () => {
	expect(
		chatCompletionStreamChunkSchema.safeParse({
			choices: [
				{
					delta: {
						tool_calls: [
							{ index: 0, function: { arguments: "{", name: "search" } },
						],
					},
				},
			],
		}).success
	).toBe(true);
	expect(
		chatCompletionStreamChunkSchema.safeParse({
			choices: [{ delta: { tool_calls: [{ index: "0" }] } }],
		}).success
	).toBe(false);
	expect(
		chatCompletionStreamChunkSchema.safeParse({
			usage: { completion_tokens: null, prompt_tokens: 3 },
		}).success
	).toBe(true);
	expect(
		chatCompletionStreamChunkSchema.safeParse({
			choices: [{ delta: null }],
			usage: null,
		}).success
	).toBe(true);
});
