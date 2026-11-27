/**
 * `@ryuhq/sdk/schema` — typed schemas for tools and structured output.
 *
 * Accepts any Standard Schema validator (zod 4, valibot, arktype, …) or a
 * plain JSON Schema, infers TypeScript types from the former, and converts
 * both to JSON Schema for the wire.
 */

export type {
	JsonSchemaObject,
	SchemaDirection,
	SchemaLike,
	SchemaValidationResult,
} from "./json-schema.ts";
export {
	formatSchemaIssues,
	fromJsonSchema,
	JSON_SCHEMA_TARGET,
	normalizeSchema,
	SchemaConversionError,
	toJsonSchema,
	validateWithSchema,
	withJsonSchema,
} from "./json-schema.ts";
export type { SchemaIssue } from "./json-schema-validator.ts";
export { validateJsonSchema } from "./json-schema-validator.ts";
export type {
	InferSchemaInput,
	InferSchemaOutput,
	StandardJsonSchemaConverter,
	StandardJsonSchemaOptions,
	StandardJsonSchemaTarget,
	StandardSchemaV1,
	StandardSchemaWithJsonSchema,
} from "./standard-schema.ts";
export {
	hasStandardJsonSchema,
	isStandardSchema,
} from "./standard-schema.ts";
export type {
	StructuredOutputErrorDetails,
	StructuredReplyResult,
} from "./structured-output.ts";
export {
	buildRepairPrompt,
	DEFAULT_MAX_REPAIR_ATTEMPTS,
	isStrictCompatibleJsonSchema,
	parseJsonReply,
	readStructuredReply,
	STRUCTURED_OUTPUT_ERROR_CODE,
	StructuredOutputError,
} from "./structured-output.ts";
