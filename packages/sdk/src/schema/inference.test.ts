/**
 * Type-level tests for schema inference. These assertions are checked by
 * `tsc --noEmit` (`bun run check-types`); the runtime test only keeps the file
 * part of `bun test` so a broken import still fails loudly.
 */

import { expect, test } from "bun:test";
import { z } from "zod";
import { Agent, createAgent, type GenerateResult } from "../agent/agent.ts";
import { defineTool, type ToolRunnable } from "../runnable/tool.ts";
import { fromJsonSchema, withJsonSchema } from "./json-schema.ts";
import type {
	InferSchemaInput,
	InferSchemaOutput,
	StandardSchemaV1,
} from "./standard-schema.ts";

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;
function assertType<T extends true>(_proof?: T): void {
	// Compile-time only.
}

const Params = z.object({
	city: z.string(),
	days: z.number().int().default(1),
	units: z.enum(["c", "f"]).optional(),
});

// ── Tools ────────────────────────────────────────────────────────────────────

const forecast = defineTool({
	id: "forecast",
	name: "Forecast",
	schema: Params,
	run: async (input) => {
		assertType<
			Equal<typeof input, { city: string; days: number; units?: "c" | "f" }>
		>();
		return { highs: [input.days] };
	},
});

// run() accepts the schema's *input* side (defaulted fields optional) and
// resolves to the body's return type.
assertType<
	Equal<
		typeof forecast,
		ToolRunnable<
			{ city: string; days?: number; units?: "c" | "f" },
			{ highs: number[] }
		>
	>
>();

defineTool({
	id: "typo",
	name: "Typo",
	schema: Params,
	// @ts-expect-error -- `town` is not a field of the inferred input
	run: async ({ town }) => town,
});

// Transforming schemas: run() receives the parsed output type.
defineTool({
	id: "coerce",
	name: "Coerce",
	schema: z.object({ n: z.string().transform(Number) }),
	run: async ({ n }) => {
		assertType<Equal<typeof n, number>>();
		return n;
	},
});

// Hand-written JSON Schema keeps its explicit generic.
const legacy = defineTool<{ q: string }>({
	id: "legacy",
	name: "Legacy",
	schema: { type: "object", properties: { q: { type: "string" } } },
	run: async ({ q }) => q,
});
assertType<Equal<Parameters<typeof legacy.run>[0], { q: string }>>();

// withJsonSchema preserves the wrapped validator's types.
const plain: StandardSchemaV1<{ raw: string }, { id: number }> = {
	"~standard": {
		version: 1,
		vendor: "plain",
		validate: () => ({ issues: [{ message: "type-level fixture only" }] }),
	},
};
const paired = withJsonSchema(plain, { type: "object" });
assertType<Equal<InferSchemaInput<typeof paired>, { raw: string }>>();
assertType<Equal<InferSchemaOutput<typeof paired>, { id: number }>>();

// ── Structured output ────────────────────────────────────────────────────────

const typedAgent = new Agent({
	name: "typed",
	model: "gpt-4o",
	outputSchema: z.object({ title: z.string(), score: z.number() }),
});
type TypedResult = Awaited<ReturnType<typeof typedAgent.generate>>;
assertType<
	Equal<TypedResult["output"], { title: string; score: number } | undefined>
>();

const factoryAgent = createAgent({
	name: "factory",
	model: "gpt-4o",
	outputSchema: z.array(z.string()),
});
assertType<
	Equal<
		Awaited<ReturnType<typeof factoryAgent.generate>>,
		GenerateResult<string[]>
	>
>();

const jsonSchemaAgent = new Agent({
	name: "json",
	model: "gpt-4o",
	outputSchema: { type: "object" },
});
assertType<
	Equal<Awaited<ReturnType<typeof jsonSchemaAgent.generate>>["output"], unknown>
>();

const declaredJsonAgent = new Agent({
	name: "declared",
	model: "gpt-4o",
	outputSchema: fromJsonSchema<{ answer: string }>({ type: "object" }),
});
assertType<
	Equal<
		Awaited<ReturnType<typeof declaredJsonAgent.generate>>["output"],
		{ answer: string } | undefined
	>
>();

// Guard the harness itself: a false assertion must not compile.
// @ts-expect-error -- inferred output is not `string`
assertType<Equal<TypedResult["output"], string | undefined>>();

const plainAgent = new Agent({ name: "plain", model: "gpt-4o" });
assertType<
	Equal<Awaited<ReturnType<typeof plainAgent.generate>>["output"], unknown>
>();

test("schema inference assertions compile", () => {
	expect(forecast.kind).toBe("tool");
});
