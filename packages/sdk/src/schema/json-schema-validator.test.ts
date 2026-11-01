import { describe, expect, it } from "bun:test";
import { validateJsonSchema } from "./json-schema-validator.ts";

function paths(schema: unknown, value: unknown) {
	return validateJsonSchema(schema, value).map((issue) => issue.path.join("."));
}

describe("validateJsonSchema", () => {
	it("accepts conforming values and reports type mismatches with paths", () => {
		const schema = {
			type: "object",
			properties: {
				name: { type: "string" },
				age: { type: "integer" },
				tags: { type: "array", items: { type: "string" } },
			},
			required: ["name"],
		};
		expect(validateJsonSchema(schema, { name: "a", age: 3, tags: [] })).toEqual(
			[]
		);
		expect(paths(schema, { age: 1.5, tags: ["x", 2] })).toEqual([
			"name",
			"age",
			"tags.1",
		]);
		expect(validateJsonSchema(schema, [])[0]?.message).toBe(
			"expected object, received array"
		);
	});

	it("treats integers as numbers and supports type unions and nullable", () => {
		expect(validateJsonSchema({ type: "number" }, 4)).toEqual([]);
		expect(validateJsonSchema({ type: ["string", "null"] }, null)).toEqual([]);
		expect(
			validateJsonSchema({ type: "string", nullable: true }, null)
		).toEqual([]);
		expect(paths({ type: "integer" }, 1.1)).toEqual([""]);
	});

	it("checks enum, const, string, number, and array constraints", () => {
		expect(paths({ enum: ["a", { b: 1 }] }, { b: 1 })).toEqual([]);
		expect(paths({ enum: ["a"] }, "b")).toEqual([""]);
		expect(paths({ const: 3 }, 4)).toEqual([""]);
		const text = { type: "string", minLength: 2, maxLength: 3, pattern: "^a" };
		expect(validateJsonSchema(text, "ab")).toEqual([]);
		expect(validateJsonSchema(text, "b")).toHaveLength(2);
		const num = {
			type: "number",
			minimum: 0,
			exclusiveMaximum: 10,
			multipleOf: 0.5,
		};
		expect(validateJsonSchema(num, 9.5)).toEqual([]);
		expect(validateJsonSchema(num, 10)).toHaveLength(1);
		expect(validateJsonSchema(num, -0.25)).toHaveLength(2);
		expect(
			validateJsonSchema(
				{ type: "number", minimum: 1, exclusiveMinimum: true },
				1
			)
		).toHaveLength(1);
		const list = { type: "array", minItems: 1, maxItems: 2, uniqueItems: true };
		expect(validateJsonSchema(list, [])).toHaveLength(1);
		expect(paths(list, [1, 1])).toEqual(["1"]);
		expect(validateJsonSchema(list, [1, 2, 3])).toHaveLength(1);
	});

	it("handles tuples, additionalProperties, and property counts", () => {
		const tuple = {
			type: "array",
			prefixItems: [{ type: "string" }],
			items: { type: "number" },
		};
		expect(validateJsonSchema(tuple, ["a", 1, 2])).toEqual([]);
		expect(paths(tuple, [1, "b"])).toEqual(["0", "1"]);
		const closed = {
			type: "object",
			properties: { a: {} },
			additionalProperties: false,
		};
		expect(paths(closed, { a: 1, b: 2 })).toEqual(["b"]);
		const typedExtra = {
			type: "object",
			additionalProperties: { type: "number" },
			maxProperties: 1,
		};
		expect(paths(typedExtra, { x: "s", y: 1 })).toEqual(["", "x"]);
	});

	it("evaluates combinators and boolean schemas", () => {
		const anyOf = { anyOf: [{ type: "string" }, { type: "number" }] };
		expect(validateJsonSchema(anyOf, 1)).toEqual([]);
		expect(validateJsonSchema(anyOf, true)).toHaveLength(1);
		const oneOf = { oneOf: [{ type: "number" }, { type: "integer" }] };
		expect(validateJsonSchema(oneOf, 1)).toHaveLength(1);
		expect(validateJsonSchema(oneOf, 1.5)).toEqual([]);
		expect(
			validateJsonSchema({ allOf: [{ minimum: 1 }, { maximum: 3 }] }, 4)
		).toHaveLength(1);
		expect(validateJsonSchema({ not: { type: "null" } }, null)).toHaveLength(1);
		expect(validateJsonSchema(true, 1)).toEqual([]);
		expect(validateJsonSchema(false, 1)).toHaveLength(1);
		expect(
			validateJsonSchema({ properties: { a: false } }, { a: 1 })
		).toHaveLength(1);
	});

	it("resolves local $ref pointers, including recursion", () => {
		const tree = {
			$ref: "#/definitions/node",
			definitions: {
				node: {
					type: "object",
					properties: {
						value: { type: "number" },
						children: { type: "array", items: { $ref: "#/definitions/node" } },
					},
					required: ["value"],
				},
			},
		};
		expect(
			validateJsonSchema(tree, {
				value: 1,
				children: [{ value: 2, children: [] }],
			})
		).toEqual([]);
		expect(paths(tree, { value: 1, children: [{ children: [] }] })).toEqual([
			"children.0.value",
		]);
		const defs = {
			$defs: { id: { type: "string" } },
			properties: { id: { $ref: "#/$defs/id" } },
		};
		expect(paths(defs, { id: 3 })).toEqual(["id"]);
	});

	it("ignores annotations and unsupported keywords instead of failing", () => {
		const schema = {
			type: "string",
			format: "email",
			description: "x",
			if: { const: "a" },
		};
		expect(validateJsonSchema(schema, "not-an-email")).toEqual([]);
		expect(
			validateJsonSchema({ $ref: "https://example.com/remote" }, 1)
		).toEqual([]);
	});

	it("does not throw on a malformed percent-escape in a $ref pointer", () => {
		expect(() =>
			validateJsonSchema({ $ref: "#/definitions/%E0%A4%A" }, 1)
		).not.toThrow();
		expect(
			validateJsonSchema(
				{
					definitions: { "%zz": { type: "string" } },
					$ref: "#/definitions/%zz",
				},
				1
			)
		).toEqual([{ path: [], message: "expected string, received integer" }]);
	});
});
