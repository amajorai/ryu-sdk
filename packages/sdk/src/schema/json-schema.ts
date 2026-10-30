/**
 * Schema normalization: Standard Schema ⇄ JSON Schema.
 *
 * Every typed schema the SDK accepts (`defineTool({ schema })`,
 * `ryuTool(id, { parameters })`, `new Agent({ outputSchema })`) is reduced to
 * one internal shape: a Standard Schema that can validate values AND describe
 * itself as JSON Schema for the wire. Three inputs are accepted:
 *
 * 1. a Standard Schema that implements Standard JSON Schema (zod ≥ 4.2,
 *    arktype, valibot via `@valibot/to-json-schema`'s `toStandardJsonSchema`);
 * 2. any other Standard Schema paired with a JSON Schema via `withJsonSchema`;
 * 3. a plain JSON Schema object, validated by the SDK's own subset validator
 *    (`fromJsonSchema`, optionally typed: `fromJsonSchema<{ answer: string }>(…)`).
 */

import type { PrimitiveJsonValue } from "../runnable/primitive-contracts.ts";
import { primitiveJsonObjectSchema } from "../runnable/primitive-contracts.ts";
import {
	type SchemaIssue,
	validateJsonSchema,
} from "./json-schema-validator.ts";
import {
	hasStandardJsonSchema,
	isStandardSchema,
	type StandardSchemaV1,
	type StandardSchemaWithJsonSchema,
} from "./standard-schema.ts";

/** A JSON Schema document as carried on the wire. */
export type JsonSchemaObject = Record<string, PrimitiveJsonValue>;

/**
 * Any schema the SDK accepts where a value's shape is declared: a Standard
 * Schema (inferring `Output`) or a plain JSON Schema object.
 */
export type SchemaLike<Output = unknown> =
	| JsonSchemaObject
	| StandardSchemaV1<unknown, Output>;

/** Which side of a transforming schema to describe. */
export type SchemaDirection = "input" | "output";

/** The JSON Schema dialect requested from Standard JSON Schema converters. */
export const JSON_SCHEMA_TARGET = "draft-07";

/** Thrown when a schema cannot be expressed as JSON Schema for the wire. */
export class SchemaConversionError extends Error {
	override readonly name = "SchemaConversionError";
	/** The schema vendor (`zod`, `valibot`, …) when known. */
	readonly vendor?: string;

	constructor(message: string, options?: { cause?: unknown; vendor?: string }) {
		super(
			`[ryu-sdk] ${message}`,
			options?.cause === undefined ? undefined : { cause: options.cause }
		);
		if (options?.vendor !== undefined) {
			this.vendor = options.vendor;
		}
	}
}

/** Outcome of validating a value against a normalized schema. */
export type SchemaValidationResult<Output> =
	| { issues: SchemaIssue[]; ok: false }
	| { ok: true; value: Output };

function cloneJsonObject(value: unknown, context: string): JsonSchemaObject {
	// A JSON round-trip drops `undefined` members some converters emit and
	// guarantees the result is detached from the caller's object.
	let cloned: unknown;
	try {
		cloned = JSON.parse(JSON.stringify(value));
	} catch (cause) {
		throw new SchemaConversionError(`${context} is not serializable JSON`, {
			cause,
		});
	}
	const parsed = primitiveJsonObjectSchema.safeParse(cloned);
	if (!parsed.success) {
		throw new SchemaConversionError(`${context} must be a JSON object`);
	}
	const { $schema: _dialect, ...rest } = parsed.data;
	return rest;
}

function convertStandard(
	schema: StandardSchemaWithJsonSchema,
	direction: SchemaDirection
): JsonSchemaObject {
	const vendor = schema["~standard"].vendor;
	let converted: Record<string, unknown>;
	try {
		converted = schema["~standard"].jsonSchema[direction]({
			target: JSON_SCHEMA_TARGET,
		});
	} catch (cause) {
		const reason = cause instanceof Error ? `: ${cause.message}` : "";
		throw new SchemaConversionError(
			`${vendor} schema cannot be represented as JSON Schema${reason}`,
			{ cause, vendor }
		);
	}
	return cloneJsonObject(converted, `${vendor} JSON Schema`);
}

/**
 * Convert any accepted schema into a JSON Schema object for the wire. The
 * `$schema` dialect marker is removed (several providers reject it inside tool
 * parameters). Defaults to the `input` side: what a model must produce.
 */
export function toJsonSchema(
	schema: SchemaLike,
	direction: SchemaDirection = "input"
): JsonSchemaObject {
	if (isStandardSchema(schema)) {
		if (!hasStandardJsonSchema(schema)) {
			const vendor = schema["~standard"].vendor;
			throw new SchemaConversionError(
				`${vendor} schema does not implement Standard JSON Schema; ` +
					"pair it with a JSON Schema using withJsonSchema(schema, jsonSchema)",
				{ vendor }
			);
		}
		return convertStandard(schema, direction);
	}
	return cloneJsonObject(schema, "JSON Schema");
}

/**
 * Pair a Standard Schema that cannot describe itself (zod 3, valibot without
 * its JSON Schema plugin, a hand-rolled validator) with an explicit JSON
 * Schema. Validation and type inference still come from `schema`. Pass
 * `outputJsonSchema` only when the schema transforms values and its parsed
 * side differs from what it accepts.
 */
export function withJsonSchema<Input, Output>(
	schema: StandardSchemaV1<Input, Output>,
	jsonSchema: JsonSchemaObject,
	outputJsonSchema: JsonSchemaObject = jsonSchema
): StandardSchemaWithJsonSchema<Input, Output> {
	const props = schema["~standard"];
	const input = cloneJsonObject(jsonSchema, "JSON Schema");
	const output = cloneJsonObject(outputJsonSchema, "output JSON Schema");
	return {
		"~standard": {
			version: 1,
			vendor: props.vendor,
			types: props.types,
			validate: (value: unknown) => props.validate(value),
			jsonSchema: {
				input: () => structuredClone(input),
				output: () => structuredClone(output),
			},
		},
	};
}

/**
 * Wrap a plain JSON Schema as a Standard Schema validated by the SDK's subset
 * validator. The type parameter states the shape the schema describes (the SDK
 * does not derive types from JSON Schema), defaulting to `unknown`.
 */
export function fromJsonSchema<Output = unknown>(
	jsonSchema: JsonSchemaObject
): StandardSchemaWithJsonSchema<unknown, Output> {
	const document = cloneJsonObject(jsonSchema, "JSON Schema");
	return {
		"~standard": {
			version: 1,
			vendor: "ryu-json-schema",
			validate: (value: unknown) => {
				const issues = validateJsonSchema(document, value);
				if (issues.length > 0) {
					return { issues };
				}
				// SAFETY: the caller declares `Output` as the shape `jsonSchema`
				// describes, and the value has just been validated against it.
				return { value: value as Output };
			},
			jsonSchema: {
				input: () => structuredClone(document),
				output: () => structuredClone(document),
			},
		},
	};
}

/**
 * Normalize any accepted schema into a Standard Schema that also carries
 * JSON Schema. Throws `SchemaConversionError` when no JSON Schema is available.
 */
export function normalizeSchema<Output>(
	schema: SchemaLike<Output>
): StandardSchemaWithJsonSchema<unknown, Output> {
	if (isStandardSchema(schema)) {
		// Convert once up front so an unrepresentable schema (no converter, or a
		// zod `z.date()` field) fails at construction, not mid-run.
		toJsonSchema(schema);
		// SAFETY: `toJsonSchema` succeeded, so the Standard JSON Schema converter
		// is present on this `StandardSchemaV1<unknown, Output>`.
		return schema as StandardSchemaWithJsonSchema<unknown, Output>;
	}
	return fromJsonSchema<Output>(schema);
}

function normalizePath(
	path: StandardSchemaV1.Issue["path"]
): (number | string)[] {
	return (path ?? []).map((segment) => {
		const key = typeof segment === "object" ? segment.key : segment;
		return typeof key === "number" ? key : String(key);
	});
}

/** Validate `value` with any Standard Schema, normalizing its issues. */
export async function validateWithSchema<Output>(
	schema: StandardSchemaV1<unknown, Output>,
	value: unknown
): Promise<SchemaValidationResult<Output>> {
	const result = await schema["~standard"].validate(value);
	if (result.issues) {
		return {
			ok: false,
			issues: result.issues.map((issue) => ({
				message: issue.message,
				path: normalizePath(issue.path),
			})),
		};
	}
	return { ok: true, value: result.value };
}

/** Render issues as `- at path: message` lines (root issues have no path). */
export function formatSchemaIssues(issues: readonly SchemaIssue[]): string {
	return issues
		.map((issue) => {
			const location =
				issue.path.length === 0
					? "(root)"
					: issue.path
							.map((segment, index) => {
								if (typeof segment === "number") {
									return `[${segment}]`;
								}
								return index === 0 ? segment : `.${segment}`;
							})
							.join("");
			return `- at ${location}: ${issue.message}`;
		})
		.join("\n");
}

export type { SchemaIssue } from "./json-schema-validator.ts";
