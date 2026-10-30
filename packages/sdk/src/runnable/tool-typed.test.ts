/**
 * `defineTool` with typed (Standard Schema) input schemas: wire conversion,
 * runtime parsing, and the unchanged hand-written JSON Schema path.
 */

import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { resolveToolDefs, ryuTool } from "../agent/tools.ts";
import { withJsonSchema } from "../schema/json-schema.ts";
import type { StandardSchemaV1 } from "../schema/standard-schema.ts";
import type { RunnableContext } from "./runnable-types.ts";
import { defineTool, inlineToolRunnable } from "./tool.ts";

/** Tools under test never call a model; the gateway only satisfies the type. */
const ctx: RunnableContext = {
	gateway: {
		chat: () => Promise.reject(new Error("unused")),
		async *stream() {
			// no model traffic in these tests
		},
	},
};

const RE_INVALID_INPUT = /Tool "weather" input is invalid:\n- at city:/;
const RE_OBJECT_ROOT = /must describe an object/;
const RE_NO_CONVERTER = /does not implement Standard JSON Schema/;

const weather = defineTool({
	id: "weather",
	name: "Weather",
	description: "Current weather for a city",
	schema: z.object({
		city: z.string().min(1).describe("City name"),
		units: z.enum(["c", "f"]).default("c"),
	}),
	run: async ({ city, units }) => ({
		city,
		units,
		temp: units === "c" ? 20 : 68,
	}),
});

describe("defineTool with a zod schema", () => {
	it("exposes a Core-compatible JSON Schema", () => {
		expect(JSON.parse(JSON.stringify(weather.schema))).toEqual({
			type: "object",
			properties: {
				city: { type: "string", minLength: 1, description: "City name" },
				units: { type: "string", enum: ["c", "f"], default: "c" },
			},
			required: ["city"],
		});
		const manifest = inlineToolRunnable(weather);
		expect(manifest.config?.input_schema).toEqual(weather.schema);
	});

	it("parses input with the schema (defaults applied) before run()", async () => {
		expect(await weather.run({ city: "Oslo" }, ctx)).toEqual({
			city: "Oslo",
			units: "c",
			temp: 20,
		});
	});

	it("rejects invalid input with every issue before run()", async () => {
		// SAFETY: deliberately invalid input to exercise runtime validation.
		const invalid = { city: "", units: "k" } as unknown as { city: string };
		await expect(weather.run(invalid, ctx)).rejects.toThrow(RE_INVALID_INPUT);
	});

	it("requires an object root and a JSON Schema converter", () => {
		expect(() =>
			defineTool({
				id: "scalar",
				name: "Scalar",
				// @ts-expect-error -- tool input must be an object schema
				schema: z.string(),
				run: async () => null,
			})
		).toThrow(RE_OBJECT_ROOT);
		const opaque: StandardSchemaV1<{ id: string }> = {
			"~standard": {
				version: 1,
				vendor: "opaque",
				validate: (value) => ({ value: { id: String(value) } }),
			},
		};
		expect(() =>
			defineTool({
				id: "opaque",
				name: "Opaque",
				schema: opaque,
				run: async () => 1,
			})
		).toThrow(RE_NO_CONVERTER);
	});

	it("accepts any Standard Schema paired via withJsonSchema", async () => {
		const ids: StandardSchemaV1<{ id: string }, { id: number }> = {
			"~standard": {
				version: 1,
				vendor: "custom",
				validate: (value) => {
					const id = Number(
						typeof value === "object" && value !== null
							? Reflect.get(value, "id")
							: undefined
					);
					return Number.isInteger(id)
						? { value: { id } }
						: { issues: [{ message: "id must be numeric", path: ["id"] }] };
				},
			},
		};
		const tool = defineTool({
			id: "lookup",
			name: "Lookup",
			schema: withJsonSchema(ids, {
				type: "object",
				properties: { id: { type: "string" } },
				required: ["id"],
			}),
			run: async ({ id }) => id + 1,
		});
		expect(await tool.run({ id: "41" }, ctx)).toBe(42);
		await expect(tool.run({ id: "x" }, ctx)).rejects.toThrow(
			"id must be numeric"
		);
	});

	it("feeds the model the converted schema and the tool description", async () => {
		const defs = await resolveToolDefs(
			{
				weather,
				search: ryuTool("composio.SEARCH", {
					description: "Search",
					parameters: z.object({ q: z.string() }),
				}),
			},
			{ coreBaseUrl: "http://127.0.0.1:7980", runnableContext: ctx }
		);
		expect(defs[0]?.function.description).toBe("Current weather for a city");
		expect(defs[0]?.function.parameters).toEqual(
			JSON.parse(JSON.stringify(weather.schema))
		);
		expect(defs[1]?.function.parameters).toEqual({
			type: "object",
			properties: { q: { type: "string" } },
			required: ["q"],
		});
	});
});

describe("defineTool with a hand-written JSON Schema", () => {
	it("keeps the shallow validation path", async () => {
		const legacy = defineTool<{ query: string }, string>({
			id: "legacy",
			name: "Legacy",
			schema: {
				type: "object",
				properties: { query: { type: "string" } },
				required: ["query"],
			},
			run: async ({ query }) => query.toUpperCase(),
		});
		expect(await legacy.run({ query: "hi" }, ctx)).toBe("HI");
		// SAFETY: deliberately invalid input to exercise runtime validation.
		await expect(legacy.run({} as { query: string }, ctx)).rejects.toThrow(
			'missing required field "query"'
		);
	});
});
