/**
 * Structured-output helpers shared by the SDK agent loop and the Core-owned
 * harness path: lenient JSON extraction from a model reply, schema validation,
 * the repair prompt fed back to the model, and the typed terminal error.
 */

import {
	formatSchemaIssues,
	type JsonSchemaObject,
	validateWithSchema,
} from "./json-schema.ts";
import type { SchemaIssue } from "./json-schema-validator.ts";
import type { StandardSchemaV1 } from "./standard-schema.ts";

/** Default number of times the model is re-asked after an invalid reply. */
export const DEFAULT_MAX_REPAIR_ATTEMPTS = 2;

/** Stable code carried by structured-output failures. */
export const STRUCTURED_OUTPUT_ERROR_CODE = "structured_output_invalid";

const FENCED_BLOCK = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/;

/** Outcome of reading a model reply against an output schema. */
export type StructuredReplyResult<Output> =
	| { issues: SchemaIssue[]; ok: false; reason: "parse" | "validation" }
	| { ok: true; value: Output };

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return { ok: false };
	}
}

function sliceBetween(text: string, open: string, close: string) {
	const start = text.indexOf(open);
	const end = text.lastIndexOf(close);
	return start !== -1 && end > start ? text.slice(start, end + 1) : undefined;
}

/**
 * Parse JSON from a model reply. Accepts a bare JSON document, a fenced
 * ```json block, or a single object/array embedded in surrounding prose —
 * models routinely wrap structured replies even when told not to.
 */
export function parseJsonReply(
	text: string
): { ok: true; value: unknown } | { error: string; ok: false } {
	const trimmed = text.trim();
	if (trimmed === "") {
		return { ok: false, error: "the reply was empty; expected a JSON value" };
	}
	const candidates = [trimmed];
	const fenced = FENCED_BLOCK.exec(trimmed)?.[1]?.trim();
	if (fenced) {
		candidates.push(fenced);
	}
	for (const [open, close] of [
		["{", "}"],
		["[", "]"],
	] as const) {
		const embedded = sliceBetween(trimmed, open, close);
		if (embedded) {
			candidates.push(embedded);
		}
	}
	for (const candidate of candidates) {
		const parsed = tryParse(candidate);
		if (parsed.ok) {
			return parsed;
		}
	}
	return { ok: false, error: "the reply was not valid JSON" };
}

/** Parse + validate a model reply (text or an already-decoded JSON value). */
export async function readStructuredReply<Output>(
	reply: unknown,
	schema: StandardSchemaV1<unknown, Output>
): Promise<StructuredReplyResult<Output>> {
	let value = reply;
	if (typeof reply === "string") {
		const parsed = parseJsonReply(reply);
		if (!parsed.ok) {
			return {
				ok: false,
				reason: "parse",
				issues: [{ path: [], message: parsed.error }],
			};
		}
		value = parsed.value;
	}
	const validated = await validateWithSchema(schema, value);
	if (!validated.ok) {
		return { ok: false, reason: "validation", issues: validated.issues };
	}
	return validated;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function childSchemas(node: Record<string, unknown>): unknown[] {
	const children: unknown[] = [];
	for (const key of ["properties", "$defs", "definitions"]) {
		const map = node[key];
		if (isJsonObject(map)) {
			children.push(...Object.values(map));
		}
	}
	for (const key of ["anyOf", "allOf", "oneOf", "prefixItems"]) {
		const list = node[key];
		if (Array.isArray(list)) {
			children.push(...list);
		}
	}
	if (node.items !== undefined) {
		children.push(...(Array.isArray(node.items) ? node.items : [node.items]));
	}
	return children;
}

/**
 * Whether a JSON Schema satisfies OpenAI-style strict structured outputs:
 * every object closes `additionalProperties` and requires all of its
 * properties. Strict mode is only requested when this holds, because a
 * provider rejects a strict request whose schema has optional fields.
 */
export function isStrictCompatibleJsonSchema(schema: unknown): boolean {
	if (!isJsonObject(schema)) {
		return typeof schema === "boolean";
	}
	const properties = isJsonObject(schema.properties) ? schema.properties : {};
	const isObjectNode =
		schema.type === "object" || isJsonObject(schema.properties);
	if (isObjectNode) {
		const required = Array.isArray(schema.required) ? schema.required : [];
		if (
			schema.additionalProperties !== false ||
			Object.keys(properties).some((key) => !required.includes(key))
		) {
			return false;
		}
	}
	return childSchemas(schema).every(isStrictCompatibleJsonSchema);
}

/** The user turn that asks the model to correct an invalid structured reply. */
export function buildRepairPrompt(
	issues: readonly SchemaIssue[],
	jsonSchema: JsonSchemaObject
): string {
	return [
		"Your previous reply did not satisfy the required output schema.",
		"Problems:",
		formatSchemaIssues(issues),
		"",
		"Reply again with ONLY a JSON value (no prose, no code fences) that satisfies this JSON Schema:",
		JSON.stringify(jsonSchema),
	].join("\n");
}

/** Details carried by a `StructuredOutputError`. */
export interface StructuredOutputErrorDetails {
	/** Model rounds that produced a structured reply (1 + repair attempts). */
	attempts: number;
	/** Problems with the last reply. */
	issues: SchemaIssue[];
	/** The last raw reply text. */
	text: string;
}

/**
 * Thrown by `Agent.generate()` when the model's final reply never satisfied
 * the configured `outputSchema`, after all repair attempts were spent.
 */
export class StructuredOutputError extends Error {
	override readonly name = "StructuredOutputError";
	readonly attempts: number;
	readonly code = STRUCTURED_OUTPUT_ERROR_CODE;
	readonly issues: SchemaIssue[];
	readonly text: string;

	constructor(message: string, details: StructuredOutputErrorDetails) {
		super(message);
		this.attempts = details.attempts;
		this.issues = details.issues;
		this.text = details.text;
	}
}

/** The human-readable summary used for structured-output failures. */
export function describeStructuredOutputFailure(
	issues: readonly SchemaIssue[],
	attempts: number
): string {
	const plural = attempts === 1 ? "" : "s";
	return `model did not return valid structured JSON output after ${attempts} attempt${plural}:\n${formatSchemaIssues(issues)}`;
}
