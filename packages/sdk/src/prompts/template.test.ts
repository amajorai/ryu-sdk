import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
	compileTemplate,
	MissingTemplateVariablesError,
	TemplateSyntaxError,
	templateVariables,
} from "./template.ts";

/** Pinned to the registry's golden cases so every implementation agrees. */
const FIXTURE_PATH = join(
	import.meta.dir,
	"../../../protocol/src/fixtures/prompt-templates.json"
);
const fixture = z
	.object({
		cases: z.array(
			z.object({
				name: z.string(),
				template: z.string(),
				variables: z.array(z.string()).optional(),
				values: z.record(z.string(), z.unknown()).optional(),
				output: z.string().optional(),
				error: z.boolean().optional(),
			})
		),
	})
	.parse(JSON.parse(readFileSync(FIXTURE_PATH, "utf8")));

describe("golden prompt templates", () => {
	for (const golden of fixture.cases) {
		test(golden.name, () => {
			if (golden.error) {
				expect(() => compileTemplate(golden.template)).toThrow(
					TemplateSyntaxError
				);
				return;
			}
			expect(templateVariables(golden.template)).toEqual(
				golden.variables ?? []
			);
			expect(compileTemplate(golden.template, golden.values)).toBe(
				golden.output ?? ""
			);
		});
	}
});

describe("compile", () => {
	test("strict mode names every missing root variable", () => {
		try {
			compileTemplate("{{a}} {{b.c}} {{d}}", { d: 1 }, { strict: true });
			throw new Error("expected a throw");
		} catch (error) {
			expect(error).toBeInstanceOf(MissingTemplateVariablesError);
			expect((error as MissingTemplateVariablesError).missing).toEqual([
				"a",
				"b",
			]);
		}
	});

	test("objects render as JSON", () => {
		expect(compileTemplate("{{cfg}}", { cfg: { a: 1 } })).toBe('{"a":1}');
	});

	test("object sections push a context", () => {
		expect(
			compileTemplate("{{#user}}{{name}}{{/user}}", { user: { name: "Ada" } })
		).toBe("Ada");
	});

	test("inline section tags keep their line", () => {
		expect(compileTemplate("a {{#x}}b{{/x}} c\nd", { x: true })).toBe(
			"a b c\nd"
		);
	});

	test("inherited keys are not variables", () => {
		expect(compileTemplate("[{{toString}}]", {})).toBe("[]");
		expect(
			compileTemplate("[{{user.constructor}}|{{user.__proto__}}]", {
				user: { name: "Ada" },
			})
		).toBe("[|]");
	});
});
