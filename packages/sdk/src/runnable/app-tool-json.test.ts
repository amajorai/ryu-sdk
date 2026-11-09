import { expect, test } from "bun:test";
import { appToolJsonObjectSchema } from "./app.ts";
import { definePlugin, defineTurnHook } from "./turn-hook.ts";

test("app tool JSON documents retain additive fields and original own keys", () => {
	const schema = JSON.parse(
		'{"type":"object","properties":{},"__proto__":{"future":true},"extension":[null,3]}'
	);
	expect(appToolJsonObjectSchema.parse(schema)).toBe(schema);
	expect(
		Object.hasOwn(appToolJsonObjectSchema.parse(schema), "__proto__")
	).toBe(true);
	expect(appToolJsonObjectSchema.safeParse([]).success).toBe(false);
	expect(
		appToolJsonObjectSchema.safeParse({ invalid: undefined }).success
	).toBe(false);
	expect(
		appToolJsonObjectSchema.safeParse({ invalid: () => true }).success
	).toBe(false);
	const hiddenInvalid = Object.defineProperty({}, "__proto__", {
		value: () => true,
		enumerable: true,
	});
	expect(appToolJsonObjectSchema.safeParse(hiddenInvalid).success).toBe(false);
});

test("plugin JSON contribution boundaries preserve extensions and validate before insertion", () => {
	const control = {
		id: "custom",
		kind: "toggle",
		extension: { enabled: true },
	};
	const server = {
		command: "server",
		args: ["--stdio"],
		extension: { level: 1 },
	};
	const plugin = definePlugin({
		id: "com.example.json",
		name: "JSON",
		version: "1.0.0",
		composerControls: [control],
		lspServers: { custom: server },
	});
	expect(plugin.contributes?.composer_controls[0]).toEqual(control);
	expect(plugin.contributes?.lsp_servers.custom).toEqual(server);
	expect(Object.hasOwn(plugin, "requires")).toBe(false);
	const hook = defineTurnHook({
		id: "check",
		priority: 0,
		match: { flag: "", stateful: false },
		run: () => ({ kind: "none" }),
	});
	expect(hook.priority).toBe(0);
	expect(hook.match).toEqual({
		commands: [],
		tools: [],
		stateful: false,
		flag: "",
	});
	const defaults = defineTurnHook({
		id: "default",
		run: () => ({ kind: "none" }),
	});
	expect(Object.hasOwn(defaults, "priority")).toBe(false);
	expect(Object.hasOwn(defaults, "match")).toBe(false);
});
