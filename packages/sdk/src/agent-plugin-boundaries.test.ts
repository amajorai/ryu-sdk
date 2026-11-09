import { expect, test } from "bun:test";
import { ZodError } from "zod";
import {
	AGENT_PLUGIN_SCHEMA_URL,
	isAgentPluginManifest,
	toAgentPlugin,
	toChatGPTPlugin,
} from "./agent-plugin.ts";

test("optional authored metadata preserves both portable projections", () => {
	const manifest = {
		id: "@example/metadata",
		name: "Metadata",
		version: "1.0.0",
		author: { name: "Example", email: undefined },
		future: { optional: undefined, array: [undefined, "retained"] },
	};
	const serialized = JSON.parse(JSON.stringify(manifest));
	expect(toAgentPlugin(manifest)).toEqual(toAgentPlugin(serialized));
	expect(toChatGPTPlugin(manifest)).toEqual(toChatGPTPlugin(serialized));
	expect(manifest.future.array).toEqual([undefined, "retained"]);
});

test("invalid nested authored values fail at the manifest boundary", () => {
	const manifest = { id: "@example/invalid", future: { run: () => 1 } };
	expect(() => toAgentPlugin(manifest)).toThrow(ZodError);
	expect(() => toChatGPTPlugin(manifest)).toThrow(ZodError);
});

test("cyclic authored metadata produces a validation error", () => {
	const future = new Map();
	const manifest = { id: "@example/cyclic", future: {} };
	Object.assign(manifest.future, { parent: manifest });
	expect(() => toAgentPlugin(manifest)).toThrow(ZodError);
	expect(() => toChatGPTPlugin(manifest)).toThrow(ZodError);
	expect(() => toAgentPlugin({ id: "@example/map", future })).toThrow(ZodError);
});

test("own prototype metadata is validated without rewriting the caller", () => {
	const valid = JSON.parse(
		'{"id":"@example/prototype","future":{"__proto__":{"retained":true}}}'
	);
	const before = JSON.stringify(valid);
	expect(toAgentPlugin(valid).plugin.name).toBe("example.prototype");
	expect(JSON.stringify(valid)).toBe(before);
	const invalid = { id: "@example/invalid", future: {} };
	Object.defineProperty(invalid.future, "__proto__", {
		enumerable: true,
		value: () => 1,
	});
	expect(() => toAgentPlugin(invalid)).toThrow(ZodError);
});

test("portable manifest detection requires the schema namespace", () => {
	expect(isAgentPluginManifest({ $schema: AGENT_PLUGIN_SCHEMA_URL })).toBe(
		true
	);
	expect(
		isAgentPluginManifest({ $schema: "https://example.test/schema" })
	).toBe(false);
	expect(isAgentPluginManifest({ $schema: 1 })).toBe(false);
	expect(isAgentPluginManifest(null)).toBe(false);
});
