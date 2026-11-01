/**
 * create-ryu-app `adapter` template test.
 *
 * Asserts the capability-adapter starter:
 *   1. scaffolds the expected file set and passes the scaffolder's manifest gate;
 *   2. declares an owned provider tool, a `provides` binding whose adapter names a
 *      flat `adapters/<verb>.js` fragment, and the `tool:execute` grant;
 *   3. agrees with `node tools/toolsmith/index.mjs scaffold --kind adapter`
 *      (same body, same cases, same manifest seat);
 *   4. passes its own generated `bun test` suite and packs with `ryu pack`, which
 *      inlines the adapter and runs Core's manifest validation.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseArgs, scaffold } from "./index.ts";

const REPO_ROOT = join(import.meta.dir, "../..");
const SDK_CLI = join(REPO_ROOT, "packages/sdk/src/cli.ts");
const TOOLSMITH = join(REPO_ROOT, "tools/toolsmith/index.mjs");

const AdapterManifestSchema = z.object({
	id: z.string(),
	permission_grants: z.array(z.string()),
	runnables: z.array(
		z.object({
			id: z.string(),
			kind: z.string(),
			config: z.object({ slug: z.string(), backend: z.string() }).passthrough(),
		})
	),
	provides: z.array(
		z.object({
			capability: z.string(),
			version: z.string(),
			selectable: z.boolean(),
			tools: z.record(
				z.string(),
				z.object({
					tool: z.string(),
					adapter: z.object({ code_file: z.string() }).passthrough(),
				})
			),
		})
	),
});
type AdapterManifest = z.infer<typeof AdapterManifestSchema>;

function readAdapterManifest(dir: string): AdapterManifest {
	return AdapterManifestSchema.parse(
		JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
	);
}

/** The parts of a manifest that define the adapter seat, without per-project names. */
function seatShape(manifest: AdapterManifest) {
	return {
		permission_grants: manifest.permission_grants,
		provides: manifest.provides,
		runnables: manifest.runnables.map((runnable) => ({
			id: runnable.id,
			kind: runnable.kind,
			slug: runnable.config.slug,
			backend: runnable.config.backend,
		})),
	};
}

describe("create-ryu-app scaffold (adapter)", () => {
	let tmpDir: string;
	let projectDir: string;
	let toolsmithDir: string;

	beforeAll(() => {
		tmpDir = join(import.meta.dir, `__test-adapter-${Date.now()}`);
		projectDir = scaffold("my-adapter", tmpDir, "adapter");
		toolsmithDir = join(tmpDir, "toolsmith-out");
		const result = spawnSync(
			"node",
			[
				TOOLSMITH,
				"scaffold",
				"--id",
				"@example/my-adapter",
				"--tool",
				"search",
				"--kind",
				"adapter",
				"--out",
				toolsmithDir,
			],
			{ encoding: "utf8" }
		);
		if (result.status !== 0) {
			throw new Error(`toolsmith scaffold failed: ${result.stderr}`);
		}
	});

	afterAll(() => {
		if (existsSync(tmpDir)) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("is accepted by --template", () => {
		expect(parseArgs(["my-adapter", "--template", "adapter"])).toEqual({
			name: "my-adapter",
			template: "adapter",
		});
	});

	it("produces the expected file set", () => {
		for (const file of [
			"manifest.json",
			"adapters/search.js",
			"cases.json",
			"src/harness.ts",
			"test/adapter.test.ts",
			"README.md",
			"package.json",
		]) {
			expect(existsSync(join(projectDir, file))).toBe(true);
		}
	});

	it("binds an owned provider tool through a flat adapter code_file", () => {
		const manifest = readAdapterManifest(projectDir);
		expect(manifest.id).toBe("com.example.my-adapter");
		expect(manifest.permission_grants).toContain("tool:execute");
		const binding = manifest.provides[0]?.tools.search;
		expect(binding?.adapter.code_file).toBe("adapters/search.js");
		expect(binding?.adapter).not.toHaveProperty("code");
		const toolSlugs = manifest.runnables
			.filter((runnable) => runnable.kind === "tool")
			.map((runnable) => runnable.config.slug);
		expect(toolSlugs).toContain(binding?.tool ?? "");
	});

	it("ships the adapter as a sandbox fragment, not a module", () => {
		const body = readFileSync(join(projectDir, "adapters/search.js"), "utf8");
		expect(body.startsWith("// Capability adapter for `search`")).toBe(true);
		expect(body).toMatch(/^return /m);
		expect(body).not.toMatch(/^\s*(export|import)\s/m);
	});

	it("agrees with toolsmith scaffold --kind adapter", () => {
		for (const file of ["adapters/search.js", "cases.json"]) {
			expect(readFileSync(join(projectDir, file), "utf8")).toBe(
				readFileSync(join(toolsmithDir, file), "utf8")
			);
		}
		expect(seatShape(readAdapterManifest(projectDir))).toEqual(
			seatShape(readAdapterManifest(toolsmithDir))
		);
	});

	it("wires dev and test scripts", () => {
		const pkg = z
			.object({ scripts: z.record(z.string(), z.string()) })
			.parse(
				JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8"))
			);
		expect(pkg.scripts.dev).toBe("bun run src/harness.ts");
		expect(pkg.scripts.test).toBe("bun test");
		expect(pkg.scripts.pack).toBe("bunx ryu pack .");
	});

	it("passes its own generated test suite", () => {
		const result = spawnSync(process.execPath, ["test"], {
			cwd: projectDir,
			encoding: "utf8",
		});
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
	});

	it("packs with the SDK CLI, inlining the adapter body", () => {
		const result = spawnSync(process.execPath, [SDK_CLI, "pack", projectDir], {
			encoding: "utf8",
		});
		expect(result.status, result.stderr).toBe(0);
		const bundle = z
			.object({
				provides: z.array(
					z.object({
						tools: z.record(
							z.string(),
							z.object({
								adapter: z
									.object({
										code: z.string().optional(),
										code_file: z.string().optional(),
									})
									.passthrough(),
							})
						),
					})
				),
			})
			.parse(
				JSON.parse(
					readFileSync(join(projectDir, "dist/plugin.bundle.json"), "utf8")
				)
			);
		const adapter = bundle.provides[0]?.tools.search?.adapter;
		expect(adapter?.code).toContain("callTool");
		expect(adapter?.code_file).toBeUndefined();
	});
});
