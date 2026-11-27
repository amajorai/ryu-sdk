/**
 * Scaffold smoke test — the path a third-party author actually walks.
 *
 * For EVERY template: scaffold a project, type-check its authoring source against
 * the real `@ryuhq/sdk` types, run `ryu validate` (SDK schema + public JSON
 * Schema), and — for the plugin templates — `ryu pack` it into
 * `dist/plugin.bundle.json`. The unit suite (index.test.ts) proves each manifest
 * parses; this proves the generated project compiles and packs, which is what
 * broke silently when a template drifted from the SDK it depends on.
 *
 * Projects are scaffolded under this package (not the OS temp dir) so
 * `@ryuhq/sdk`, `react` and their types resolve from the workspace exactly as
 * they would from a fresh `bun install`.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { scaffold } from "./index.ts";

const SDK_CLI = join(import.meta.dir, "../sdk/src/cli.ts");
const TSC = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const ROOT = join(import.meta.dir, `__smoke-${process.pid}`);

const PLUGIN_TEMPLATES = [
	"agent",
	"expense-agent",
	"workflow",
	"multi-agent",
	"action",
	"hook-plugin",
	"ryu-app",
	"companion-plugin",
] as const;

/** The compiler options a scaffolded TypeScript project is expected to satisfy. */
const SMOKE_TSCONFIG = {
	compilerOptions: {
		target: "ESNext",
		module: "ESNext",
		moduleResolution: "bundler",
		lib: ["ESNext", "DOM"],
		jsx: "react-jsx",
		strict: true,
		noEmit: true,
		skipLibCheck: true,
		allowImportingTsExtensions: true,
		types: ["bun", "node"],
	},
	include: ["src"],
};

function run(command: string, args: string[], cwd: string) {
	const result = spawnSync(command, args, { cwd, encoding: "utf8" });
	return {
		status: result.status,
		output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
	};
}

beforeAll(() => {
	mkdirSync(ROOT, { recursive: true });
});

afterAll(() => {
	if (existsSync(ROOT)) {
		rmSync(ROOT, { recursive: true, force: true });
	}
});

describe("scaffold → type-check → validate → pack", () => {
	for (const template of PLUGIN_TEMPLATES) {
		it(
			`${template} compiles, validates and packs`,
			() => {
				const projectDir = scaffold(`smoke-${template}`, ROOT, template);
				writeFileSync(
					join(projectDir, "tsconfig.json"),
					JSON.stringify(SMOKE_TSCONFIG, null, 2)
				);

				const typecheck = run(process.execPath, [TSC, "-p", "."], projectDir);
				expect(typecheck.output).toBe("");
				expect(typecheck.status).toBe(0);

				const validate = run(
					process.execPath,
					[SDK_CLI, "validate", "."],
					projectDir
				);
				expect(validate.output).toContain("valid:");
				expect(validate.status).toBe(0);

				const pack = run(process.execPath, [SDK_CLI, "pack", "."], projectDir);
				expect(pack.output).toContain("packed ");
				expect(pack.status).toBe(0);
				expect(existsSync(join(projectDir, "dist/plugin.bundle.json"))).toBe(
					true
				);
			},
			{ timeout: 120_000 }
		);
	}

	it(
		"app compiles its sidecar and validates",
		() => {
			const projectDir = scaffold("smoke-app", ROOT, "app");
			const typecheck = run(
				process.execPath,
				[TSC, "-p", "sidecar"],
				projectDir
			);
			expect(typecheck.output).toBe("");
			expect(typecheck.status).toBe(0);

			const validate = run(
				process.execPath,
				[SDK_CLI, "validate", "."],
				projectDir
			);
			expect(validate.output).toContain("valid:");
			expect(validate.status).toBe(0);
		},
		{ timeout: 120_000 }
	);
});
