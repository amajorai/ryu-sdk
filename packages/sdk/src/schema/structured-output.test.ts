import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { fromJsonSchema } from "./json-schema.ts";
import {
	buildRepairPrompt,
	isStrictCompatibleJsonSchema,
	parseJsonReply,
	readStructuredReply,
} from "./structured-output.ts";

describe("parseJsonReply", () => {
	it("parses bare, fenced, and embedded JSON", () => {
		expect(parseJsonReply(' {"a":1} ')).toEqual({ ok: true, value: { a: 1 } });
		expect(parseJsonReply("null")).toEqual({ ok: true, value: null });
		expect(parseJsonReply('```json\n{"a":2}\n```')).toEqual({
			ok: true,
			value: { a: 2 },
		});
		expect(parseJsonReply('Here you go: {"a":3}. Enjoy!')).toEqual({
			ok: true,
			value: { a: 3 },
		});
		expect(parseJsonReply("list: [1,2]")).toEqual({ ok: true, value: [1, 2] });
	});

	it("reports empty and non-JSON replies", () => {
		expect(parseJsonReply("  ").ok).toBe(false);
		expect(parseJsonReply("no json here")).toEqual({
			ok: false,
			error: "the reply was not valid JSON",
		});
	});

	it("keeps own __proto__ keys from JSON as data", () => {
		const parsed = parseJsonReply('{"__proto__":{"kept":true}}');
		expect(
			parsed.ok &&
				typeof parsed.value === "object" &&
				parsed.value !== null &&
				Object.hasOwn(parsed.value, "__proto__")
		).toBe(true);
	});
});

describe("readStructuredReply", () => {
	const schema = z.object({ score: z.number().min(0).max(1) });

	it("validates text and pre-decoded values", async () => {
		expect(await readStructuredReply('{"score":0.5}', schema)).toEqual({
			ok: true,
			value: { score: 0.5 },
		});
		expect(await readStructuredReply({ score: 1 }, schema)).toEqual({
			ok: true,
			value: { score: 1 },
		});
	});

	it("distinguishes parse failures from validation failures", async () => {
		const parse = await readStructuredReply("oops", schema);
		expect(parse.ok === false && parse.reason).toBe("parse");
		const invalid = await readStructuredReply('{"score":2}', schema);
		expect(invalid.ok === false && invalid.reason).toBe("validation");
		expect(invalid.ok === false && invalid.issues[0]?.path).toEqual(["score"]);
	});

	it("validates plain JSON Schema through fromJsonSchema", async () => {
		const result = await readStructuredReply(
			'{"ok":"yes"}',
			fromJsonSchema({
				type: "object",
				properties: { ok: { type: "boolean" } },
			})
		);
		expect(result.ok === false && result.issues[0]?.message).toBe(
			"expected boolean, received string"
		);
	});
});

describe("repair prompt + strict mode", () => {
	it("lists every issue and restates the schema", () => {
		const prompt = buildRepairPrompt(
			[
				{ path: ["a"], message: "required property is missing" },
				{ path: [], message: "the reply was not valid JSON" },
			],
			{ type: "object", required: ["a"] }
		);
		expect(prompt).toContain("- at a: required property is missing");
		expect(prompt).toContain("- at (root): the reply was not valid JSON");
		expect(prompt).toContain('{"type":"object","required":["a"]}');
	});

	it("only flags closed, fully-required object schemas as strict-compatible", () => {
		const closed = {
			type: "object",
			properties: {
				a: { type: "string" },
				b: {
					type: "array",
					items: {
						type: "object",
						properties: { c: { type: "number" } },
						required: ["c"],
						additionalProperties: false,
					},
				},
			},
			required: ["a", "b"],
			additionalProperties: false,
		};
		expect(isStrictCompatibleJsonSchema(closed)).toBe(true);
		expect(isStrictCompatibleJsonSchema({ ...closed, required: ["a"] })).toBe(
			false
		);
		expect(
			isStrictCompatibleJsonSchema({
				...closed,
				properties: {
					...closed.properties,
					d: { type: "object", properties: {} },
				},
				required: ["a", "b", "d"],
			})
		).toBe(false);
		expect(isStrictCompatibleJsonSchema({ type: "string" })).toBe(true);
	});
});
