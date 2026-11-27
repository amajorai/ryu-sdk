import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
	formatSchemaIssues,
	fromJsonSchema,
	normalizeSchema,
	SchemaConversionError,
	toJsonSchema,
	validateWithSchema,
	withJsonSchema,
} from "./json-schema.ts";
import {
	hasStandardJsonSchema,
	isStandardSchema,
	type StandardSchemaV1,
} from "./standard-schema.ts";

/** A validation-only Standard Schema, like zod 3 or valibot without its plugin. */
const positive: StandardSchemaV1<number, number> = {
	"~standard": {
		version: 1,
		vendor: "plain",
		validate: (value) =>
			typeof value === "number" && value > 0
				? { value }
				: {
						issues: [{ message: "must be positive", path: [{ key: "n" }, 0] }],
					},
	},
};

describe("schema normalization", () => {
	it("detects Standard Schema implementations", () => {
		expect(isStandardSchema(z.string())).toBe(true);
		expect(hasStandardJsonSchema(z.string())).toBe(true);
		expect(isStandardSchema(positive)).toBe(true);
		expect(hasStandardJsonSchema(positive)).toBe(false);
		expect(isStandardSchema({ type: "object" })).toBe(false);
		expect(isStandardSchema(null)).toBe(false);
		// Callable schemas (arktype `Type`s are functions) are recognised too.
		const callable = Object.assign(() => true, {
			"~standard": positive["~standard"],
		});
		expect(isStandardSchema(callable)).toBe(true);
	});

	it("converts zod to draft-07 JSON Schema without the $schema marker", () => {
		const schema = z.object({
			query: z.string().describe("Search query"),
			limit: z.number().int().optional(),
			mode: z.enum(["fast", "deep"]).default("fast"),
		});
		const input = toJsonSchema(schema);
		expect(input).toEqual({
			type: "object",
			properties: {
				query: { type: "string", description: "Search query" },
				limit: {
					type: "integer",
					minimum: Number.MIN_SAFE_INTEGER,
					maximum: Number.MAX_SAFE_INTEGER,
				},
				mode: { type: "string", enum: ["fast", "deep"], default: "fast" },
			},
			required: ["query"],
		});
		// The output side marks defaulted fields as always present.
		expect(toJsonSchema(schema, "output").required).toEqual(["query", "mode"]);
	});

	it("raises SchemaConversionError for unrepresentable or converter-less schemas", () => {
		expect(() => toJsonSchema(z.object({ at: z.date() }))).toThrow(
			SchemaConversionError
		);
		let error: unknown;
		try {
			toJsonSchema(positive);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(SchemaConversionError);
		expect(error instanceof SchemaConversionError && error.vendor).toBe(
			"plain"
		);
		expect(String(error)).toContain("withJsonSchema");
		expect(() => normalizeSchema(positive)).toThrow(SchemaConversionError);
	});

	it("pairs a validation-only schema with a JSON Schema via withJsonSchema", async () => {
		const paired = withJsonSchema(positive, {
			type: "number",
			exclusiveMinimum: 0,
		});
		expect(toJsonSchema(paired)).toEqual({
			type: "number",
			exclusiveMinimum: 0,
		});
		expect(paired["~standard"].vendor).toBe("plain");
		expect(await validateWithSchema(paired, 2)).toEqual({ ok: true, value: 2 });
		expect(await validateWithSchema(paired, -1)).toEqual({
			ok: false,
			issues: [{ message: "must be positive", path: ["n", 0] }],
		});
		// Conversion hands out copies: mutating one never leaks into the next.
		const first = toJsonSchema(paired);
		first.type = "string";
		expect(toJsonSchema(paired).type).toBe("number");
	});

	it("wraps plain JSON Schema as a validating Standard Schema", async () => {
		const answer = fromJsonSchema<{ answer: string }>({
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			properties: { answer: { type: "string" } },
			required: ["answer"],
		});
		expect(toJsonSchema(answer).$schema).toBeUndefined();
		expect(await validateWithSchema(answer, { answer: "ok" })).toEqual({
			ok: true,
			value: { answer: "ok" },
		});
		const failed = await validateWithSchema(answer, {});
		expect(failed.ok).toBe(false);
		expect(normalizeSchema({ type: "string" })["~standard"].vendor).toBe(
			"ryu-json-schema"
		);
	});

	it("applies zod transforms and defaults when validating", async () => {
		const schema = z.object({
			n: z.coerce.number(),
			tag: z.string().default("x"),
		});
		expect(await validateWithSchema(schema, { n: "4" })).toEqual({
			ok: true,
			value: { n: 4, tag: "x" },
		});
	});

	it("formats issues with dotted / indexed paths", () => {
		expect(
			formatSchemaIssues([
				{ path: [], message: "bad root" },
				{ path: ["lines", 0, "qty"], message: "expected integer" },
			])
		).toBe("- at (root): bad root\n- at lines[0].qty: expected integer");
	});
});
