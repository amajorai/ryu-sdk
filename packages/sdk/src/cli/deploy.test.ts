/**
 * `ryu deploy` tests. The vendor CLIs are replaced by a recording runner, so
 * these cover the command each target runs, the never-store-credentials
 * contract (only the inherited environment reaches the vendor), and the
 * failure paths. Live vendor deploys are not exercised here.
 */

import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildResult } from "./build.ts";
import {
	commandDeploy,
	DEPLOY_TARGETS,
	deployCommand,
	findExecutable,
	parseDeployArgs,
	spawnPlan,
} from "./deploy.ts";

describe("deployCommand", () => {
	it("runs each vendor's own CLI in the build directory", () => {
		const commands = Object.fromEntries(
			DEPLOY_TARGETS.map((target) => {
				const plan = deployCommand(target, `/out/${target}`, {
					name: "demo",
					prod: true,
				});
				return [target, `${plan.command} ${plan.args.join(" ")} @ ${plan.cwd}`];
			})
		);
		expect(commands).toEqual({
			vercel: "vercel deploy --prebuilt --prod @ /out/vercel",
			cloudflare: "wrangler deploy @ /out/cloudflare",
			netlify: "netlify deploy --prod @ /out/netlify",
			docker: "docker build -t demo . @ /out/docker",
		});
		expect(
			deployCommand("vercel", "/o", { name: "d", prod: false }).args
		).toEqual(["deploy", "--prebuilt"]);
	});
});

describe("parseDeployArgs", () => {
	it("parses the target, entry, and flags", () => {
		expect(
			parseDeployArgs([
				"vercel",
				"app.ts",
				"--prod",
				"--out",
				"dist",
				"--name=x",
			])
		).toEqual({
			target: "vercel",
			entry: "app.ts",
			outDir: "dist",
			name: "x",
			prod: true,
			skipBuild: false,
		});
		expect(parseDeployArgs(["netlify", "--no-build"]).skipBuild).toBe(true);
	});

	it("refuses node, unknown targets, and unknown flags", () => {
		expect(() => parseDeployArgs([])).toThrow(/needs a target/);
		expect(() => parseDeployArgs(["node"])).toThrow(/no vendor/);
		expect(() => parseDeployArgs(["heroku"])).toThrow(/unknown deploy target/);
		expect(() => parseDeployArgs(["vercel", "--token", "x"])).toThrow(
			/unknown option --token/
		);
	});
});

describe("findExecutable", () => {
	it("finds an executable on PATH and ignores non-executables", () => {
		const dir = mkdtempSync(join(tmpdir(), "ryu-path-"));
		try {
			writeFileSync(join(dir, "wrangler"), "#!/bin/sh\n");
			chmodSync(join(dir, "wrangler"), 0o755);
			writeFileSync(join(dir, "vercel"), "not executable");
			chmodSync(join(dir, "vercel"), 0o644);
			const env = { PATH: `/nonexistent:${dir}` };
			expect(findExecutable("wrangler", env, "linux")).toBe(
				join(dir, "wrangler")
			);
			expect(findExecutable("vercel", env, "linux")).toBeUndefined();
			expect(findExecutable("netlify", env, "linux")).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("findExecutable on Windows", () => {
	it("skips the extensionless npm shim and returns the .cmd launcher", () => {
		const dir = mkdtempSync(join(tmpdir(), "ryu-win-path-"));
		try {
			writeFileSync(join(dir, "vercel"), "#!/bin/sh\n");
			writeFileSync(join(dir, "vercel.cmd"), "@echo off\n");
			chmodSync(join(dir, "vercel"), 0o755);
			chmodSync(join(dir, "vercel.cmd"), 0o755);
			const env = { PATH: dir, PATHEXT: ".exe;.cmd" };
			expect(findExecutable("vercel", env, "win32")).toBe(
				join(dir, "vercel.cmd")
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("spawnPlan", () => {
	it("spawns directly except for Windows scripts, which go through a quoted shell", () => {
		expect(spawnPlan("/usr/bin/vercel", ["deploy"], "linux")).toEqual({
			command: "/usr/bin/vercel",
			args: ["deploy"],
			shell: false,
		});
		expect(spawnPlan("C:\\x\\docker.exe", ["build"], "win32").shell).toBe(
			false
		);
		expect(
			spawnPlan(
				"C:\\Program Files\\n\\vercel.CMD",
				["deploy", "--prod"],
				"win32"
			)
		).toEqual({
			command: '"C:\\Program Files\\n\\vercel.CMD"',
			args: ["deploy", "--prod"],
			shell: true,
		});
		expect(() =>
			spawnPlan("C:\\n\\vercel.cmd", ["deploy", "&calc"], "win32")
		).toThrow(/refusing/);
	});
});

describe("commandDeploy", () => {
	const fakeBuild =
		(calls: string[]) => (options: { target: string; outDir: string }) => {
			calls.push(`build ${options.target}`);
			return Promise.resolve<BuildResult>({
				target: "vercel",
				dir: join(options.outDir, options.target),
				files: [],
				hint: "",
			});
		};

	it("builds, then runs the vendor CLI and returns its exit code", async () => {
		const calls: string[] = [];
		const code = await commandDeploy(
			["vercel", "--prod", "--name", "demo"],
			"/proj",
			{
				find: (command) => `/usr/bin/${command}`,
				build: fakeBuild(calls),
				run: (executable, args, cwd) => {
					calls.push(`${executable} ${args.join(" ")} @ ${cwd}`);
					return Promise.resolve(7);
				},
				write: () => undefined,
			}
		);
		expect(code).toBe(7);
		expect(calls).toEqual([
			"build vercel",
			"/usr/bin/vercel deploy --prebuilt --prod @ /proj/.ryu/build/vercel",
		]);
	});

	it("skips the build with --no-build", async () => {
		const calls: string[] = [];
		await commandDeploy(["cloudflare", "--no-build"], "/proj", {
			find: () => "/bin/wrangler",
			build: fakeBuild(calls),
			run: () => Promise.resolve(0),
			write: () => undefined,
		});
		expect(calls).toEqual([]);
	});

	it("fails before building when the vendor CLI is missing", async () => {
		const calls: string[] = [];
		await expect(
			commandDeploy(["netlify"], "/proj", {
				find: () => undefined,
				build: fakeBuild(calls),
				write: () => undefined,
			})
		).rejects.toThrow(
			/netlify is not installed \(install it with: npm i -g netlify-cli\)/
		);
		expect(calls).toEqual([]);
	});
});
