/**
 * Golden cases for the `search` capability adapter.
 *
 * Every case in `cases.json` runs the real `adapters/search.js` fragment through
 * the same four-binding signature Core uses, in a context with only the globals
 * Core's sandbox provides. Add behaviour by adding a case to `cases.json`, not by
 * editing this file.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	loadBody,
	loadCases,
	PACKAGE_DIR,
	runAdapter,
} from "../src/harness.ts";

const spec = loadCases();
const body = loadBody(spec.code_file);

describe("adapters/search.js", () => {
	test("is the code_file the manifest binds, with tool:execute granted", () => {
		const manifest = JSON.parse(
			readFileSync(join(PACKAGE_DIR, "manifest.json"), "utf8")
		);
		const binding = manifest.provides[0].tools[spec.tool];
		expect(binding.adapter.code_file).toBe(spec.code_file);
		expect(manifest.permission_grants).toContain("tool:execute");
		const slugs = manifest.runnables.map(
			(runnable: { config: { slug: string } }) => runnable.config.slug
		);
		expect(slugs).toContain(binding.tool);
	});

	test("grants egress to the host its http provider tool calls", () => {
		const manifest = JSON.parse(
			readFileSync(join(PACKAGE_DIR, "manifest.json"), "utf8")
		);
		const binding = manifest.provides[0].tools[spec.tool];
		const provider = manifest.runnables.find(
			(runnable: { config: { slug: string } }) =>
				runnable.config.slug === binding.tool
		);
		if (provider.config.backend !== "http") {
			return;
		}
		// The body reads the provider's JSON body, which only `unwrap_body` returns.
		expect(provider.config.unwrap_body).toBe(true);
		const host = new URL(provider.config.url).hostname;
		expect(manifest.permission_grants).toContain(`tool:http-egress:${host}`);
	});

	test("is a flat fragment, not an ES module", () => {
		expect(body.startsWith("//")).toBe(true);
		expect(body).not.toMatch(/^\s*(export|import)\s/m);
	});

	for (const testCase of spec.cases) {
		test(testCase.name, async () => {
			if (testCase.expectError !== undefined) {
				await expect(
					runAdapter(body, testCase, spec.adapter_tools)
				).rejects.toThrow(testCase.expectError);
				return;
			}
			const first = await runAdapter(body, testCase, spec.adapter_tools);
			const second = await runAdapter(body, testCase, spec.adapter_tools);
			expect(second.value).toEqual(first.value);
			expect(first.value).toEqual(testCase.expect);
			if (testCase.expectCalls) {
				expect(first.calls).toEqual(testCase.expectCalls);
			}
		});
	}
});

describe("the local harness", () => {
	const probe = { name: "sandbox globals probe" };

	test("offers only the globals Core's sandbox provides", async () => {
		const { value } = await runAdapter(
			"return [typeof fetch, typeof require, typeof process, typeof Buffer, typeof Bun, typeof WebAssembly, typeof URL, typeof setTimeout, typeof console.log];",
			probe
		);
		expect(value).toEqual([
			"undefined",
			"undefined",
			"undefined",
			"undefined",
			"undefined",
			"undefined",
			"function",
			"function",
			"function",
		]);
	});

	test("a body that reaches for fetch fails here as it would in Core", async () => {
		await expect(
			runAdapter('return await fetch("https://api.example.com/search");', probe)
		).rejects.toThrow(/fetch/);
	});
});
