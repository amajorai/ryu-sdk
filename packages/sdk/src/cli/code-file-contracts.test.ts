import { expect, test } from "bun:test";
import {
	codeFileProvidersSchema,
	isValidCodeFilePath,
} from "./code-file-contracts.ts";

test("hydration validates generated adapter fields without replacing the manifest owners", () => {
	const adapter = {
		code_file: "adapters/search.js",
		future: { enabled: true },
	};
	const binding = {
		tool: "search",
		adapter,
		arg_template: { query: "$query" },
	};
	const provider = {
		capability: "search",
		version: "1.0.0",
		tools: { search: binding },
		future: [1],
	};
	const hydrated = codeFileProvidersSchema.parse([provider]);
	expect(hydrated[0]).toBe(provider);
	expect(hydrated[0]?.tools?.search).toBe(binding);
	expect(hydrated[0]?.tools?.search?.adapter).toBe(adapter);
	const originalAdapter = hydrated[0]?.tools?.search?.adapter;
	if (!originalAdapter) {
		throw new Error("expected adapter");
	}
	originalAdapter.code = "return input;";
	expect(provider.tools.search.adapter).toHaveProperty("code", "return input;");
	expect(
		codeFileProvidersSchema.safeParse([
			{ tools: { search: { tool: "search", adapter: { code_file: 3 } } } },
		]).success
	).toBe(false);
	expect(
		codeFileProvidersSchema.safeParse([
			{ tools: { search: { tool: "search", adapter: null } } },
		]).success
	).toBe(true);
	expect(codeFileProvidersSchema.safeParse([{}]).success).toBe(true);
});

// Lockstep with `code_file_path_allowlist_rejects_traversal_and_stray_dirs` in
// crates/core/kernel-contracts/src/manifest.rs: `pack` must accept exactly the
// paths Core's `validate_code_file_path` accepts, or it signs uninstallable bundles.
test("code_file path allowlist matches Core's validate_code_file_path", () => {
	for (const good of [
		"hooks/one.js",
		"adapters/web.search.mjs",
		"adapters/-leading-dash.js",
		"hooks/a.b.c.js",
	]) {
		expect(isValidCodeFilePath(good)).toBe(true);
	}
	for (const bad of [
		"",
		"one.js",
		"hooks/nested/one.js",
		"src/one.js",
		"hooks/../../../etc/passwd",
		"../hooks/one.js",
		"/etc/passwd",
		"hooks\\one.js",
		"C:/hooks/one.js",
		"hooks/one.txt",
		"hooks/.hidden.js",
		"hooks/.js",
		"hooks/one.js.js/../x.js",
		"adapters/a..js",
		"adapters/a...mjs",
		"hooks/x..y.js",
	]) {
		expect(isValidCodeFilePath(bad)).toBe(false);
	}
});
