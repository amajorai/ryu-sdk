import { z } from "zod";
import type { ToolCall } from "./model-call.ts";

const toolCallContract = z
	.object({
		type: z.literal("function"),
		id: z.string(),
		function: z
			.object({ arguments: z.string(), name: z.string() })
			.passthrough(),
	})
	.passthrough() satisfies z.ZodType<ToolCall>;
const toolCallSchema = z.custom<ToolCall>(
	(value) => toolCallContract.safeParse(value).success
);
const usageSchema = z.object({
	completion_tokens: z.number().nullish(),
	prompt_tokens: z.number().nullish(),
	total_tokens: z.number().nullish(),
});
export const chatCompletionResponseSchema = z.object({
	choices: z
		.array(
			z.object({
				finish_reason: z.string().nullish(),
				message: z
					.object({
						content: z.string().nullish(),
						tool_calls: z.array(toolCallSchema).nullish(),
					})
					.nullish(),
			})
		)
		.nullish(),
	usage: usageSchema.nullish(),
});
export const chatCompletionStreamChunkSchema = z.object({
	choices: z
		.array(
			z.object({
				finish_reason: z.string().nullish(),
				delta: z
					.object({
						content: z.string().nullish(),
						tool_calls: z
							.array(
								z.object({
									index: z.number().optional(),
									id: z.string().optional(),
									function: z
										.object({
											arguments: z.string().optional(),
											name: z.string().optional(),
										})
										.optional(),
								})
							)
							.optional(),
					})
					.nullish(),
			})
		)
		.nullish(),
	usage: usageSchema.nullish(),
});
