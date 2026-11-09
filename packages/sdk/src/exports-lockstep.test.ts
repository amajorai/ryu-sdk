/**
 * Package exports ↔ tsup entries lockstep guard.
 *
 * The SDK's public surface is split across `package.json` `exports` subpaths
 * (`@ryuhq/sdk/model`, `@ryuhq/sdk/mcp/server`, …) and `tsup.config.ts`
 * entrypoints that compile each one. They must stay a bijection: a subpath
 * with no entry never builds, and an entry with no subpath is unreachable.
 * This is the cheap structural guard that keeps the two from drifting again
 * (a past drift left docs importing `@ryuhq/sdk/model` / `@ryuhq/sdk/mcp/server`
 * that resolved to nothing).
 *
 * Deterministic, filesystem-only, no network.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import tsupConfig from "../tsup.config.ts";

const PKG_PATH = join(import.meta.dir, "../package.json");
const pkg = z
	.object({
		exports: z.record(
			z.string(),
			z.object({
				types: z.string().optional(),
				import: z.string().optional(),
				require: z.string().optional(),
			})
		),
	})
	.parse(JSON.parse(readFileSync(PKG_PATH, "utf8")));
const entryKeys = Object.keys(
	z
		.object({ entry: z.record(z.string(), z.string()).optional() })
		.parse(tsupConfig).entry ?? {}
);
const exportKeys = Object.keys(pkg.exports);

describe("package exports ↔ tsup entries lockstep", () => {
	test("every tsup entry has a matching exports subpath", () => {
		// `.` in the exports map corresponds to the `index` entry.
		const expected = entryKeys.map((key) =>
			key === "index" ? "." : `./${key}`
		);
		for (const key of expected) {
			expect(exportKeys).toContain(key);
		}
	});

	test("every exports subpath has a matching tsup entry", () => {
		const subpaths = exportKeys
			.filter((key) => key !== ".")
			.map((key) => key.replace(/^\.\//, ""));
		for (const key of subpaths) {
			expect(entryKeys).toContain(key);
		}
		expect(entryKeys).toContain("index");
	});

	test("every subpath the docs/examples import resolves in the exports map", () => {
		// Each of these is referenced by real consumers (fumadocs cookbooks,
		// examples/, the desktop host, create-ryu-app) and must never 404.
		const documented = [
			"action",
			"manifest",
			"agent",
			"agui",
			"voice",
			"model",
			"mcp",
			"mcp/server",
			"mcp/client",
			"plugin",
			"runnable",
			"builder",
			"workflow",
		];
		for (const sub of documented) {
			expect(
				pkg.exports[`./${sub}`],
				`@ryuhq/sdk/${sub} must be exported`
			).toBeTruthy();
		}
	});

	test("each subpath points at its own dist files (no collisions)", () => {
		const distFiles = new Set<string>();
		for (const entry of Object.values(pkg.exports)) {
			for (const kind of ["types", "import", "require"] as const) {
				const path = entry?.[kind];
				if (path) {
					expect(distFiles.has(path), `dist file collision: ${path}`).toBe(
						false
					);
					distFiles.add(path);
				}
			}
		}
	});
});
