import { z } from "zod";
import {
	primitiveJsonObjectSchema,
	primitiveJsonSchema,
} from "../runnable/primitive-contracts.ts";
import type { ModelRequestBody } from "./model-call.ts";
import type { RemoteToolCallBody } from "./tools.ts";

const callSchema = z.object({
	id: z.string(),
	type: z.literal("function"),
	function: z.object({ name: z.string(), arguments: z.string() }),
});
const messageSchema = z.discriminatedUnion("role", [
	z.object({ role: z.literal("system"), content: z.string() }),
	z.object({ role: z.literal("user"), content: z.string() }),
	z.object({
		role: z.literal("assistant"),
		content: z.string().nullable(),
		tool_calls: z.array(callSchema).optional(),
	}),
	z.object({
		role: z.literal("tool"),
		content: z.string(),
		tool_call_id: z.string(),
	}),
]);
const modelBodyContract = z.object({
	model: z.string(),
	messages: z.array(messageSchema),
	stream: z.boolean(),
	response_format: primitiveJsonObjectSchema.optional(),
	tool_choice: z.enum(["auto", "none", "required"]).optional(),
	tools: z
		.array(
			z.object({
				type: z.literal("function"),
				function: z.object({
					name: z.string(),
					description: z.string().optional(),
					parameters: primitiveJsonObjectSchema,
				}),
			})
		)
		.optional(),
}) satisfies z.ZodType<ModelRequestBody>;
const toolBodyContract = z.object({
	agent_id: z.string(),
	tool: z.string(),
	arguments: primitiveJsonSchema,
	user_id: z.string().optional(),
}) satisfies z.ZodType<RemoteToolCallBody>;
/** HTTP fixture capture validates producer-owned fields without replacing metadata. */
export const modelBodyFixtureSchema = z.custom<ModelRequestBody>(
	(value) =>
		primitiveJsonObjectSchema.safeParse(value).success &&
		modelBodyContract.safeParse(value).success
);
export const toolBodyFixtureSchema = z.custom<RemoteToolCallBody>(
	(value) =>
		primitiveJsonObjectSchema.safeParse(value).success &&
		toolBodyContract.safeParse(value).success
);
