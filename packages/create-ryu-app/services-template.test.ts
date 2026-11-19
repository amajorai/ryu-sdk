/**
 * The `services` template is a standalone Hono server on `@ryuhq/services`,
 * not an extension. Scaffold it into a temp directory under this package,
 * point `@ryuhq/services`, `@ryuhq/client` and `hono` at the workspace with
 * tsconfig `paths` (the published package is not on npm yet), then:
 * type-check it, run the project's own `bun test`, and import its app here.
 * The static checks keep `.env.example` and the README in step with the SDK's
 * `ENV_VARS`, `AVAILABILITY` and `NPM_PUBLISHED_VERSION`.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	AVAILABILITY,
	ENV_VARS,
	NPM_PUBLISHED_VERSION,
	SDK_VERSION,
} from "../services/src/index.ts";
import { nextSteps, parseArgs, scaffold } from "./index.ts";

const PACKAGES = join(import.meta.dir, "..");
const REPO_ROOT = join(PACKAGES, "..");
const TSC = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const ROOT = join(import.meta.dir, `__services-${process.pid}`);
const ENV_LINE = /^#?\s*([A-Z][A-Z0-9_]*)=/;
const APP_ENV_READ = /\benv\.([A-Z][A-Z0-9_]*)\b/g;
const PLACEHOLDER = /__[A-Z_]+__/;

/** The template's tsconfig plus `paths` into the workspace sources. */
function workspaceTsconfig(projectDir: string): string {
	const shipped = z
		.object({ compilerOptions: z.record(z.string(), z.unknown()) })
		.passthrough()
		.parse(JSON.parse(readFileSync(join(projectDir, "tsconfig.json"), "utf8")));
	return JSON.stringify(
		{
			...shipped,
			compilerOptions: {
				...shipped.compilerOptions,
				typeRoots: [join(import.meta.dir, "node_modules/@types")],
				paths: {
					"@ryuhq/services": [join(PACKAGES, "services/src/index.ts")],
					"@ryuhq/services/webhooks": [
						join(PACKAGES, "services/src/webhooks/index.ts"),
					],
					"@ryuhq/client": [join(PACKAGES, "client/src/index.ts")],
					hono: [join(PACKAGES, "services/node_modules/hono")],
					"hono/*": [join(PACKAGES, "services/node_modules/hono/dist/types/*")],
				},
			},
		},
		null,
		2
	);
}

function envNames(file: string): string[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.map((line) => ENV_LINE.exec(line)?.[1])
		.filter((name): name is string => name !== undefined);
}

function filesUnder(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		return entry.isDirectory() ? filesUnder(full) : [full];
	});
}

let projectDir = "";

beforeAll(() => {
	mkdirSync(ROOT, { recursive: true });
	projectDir = scaffold("notify-mail-demo", ROOT, "services");
});

afterAll(() => {
	if (existsSync(ROOT)) {
		rmSync(ROOT, { recursive: true, force: true });
	}
});

describe("create-ryu-app scaffold (services)", () => {
	it("is accepted by --template", () => {
		expect(parseArgs(["demo", "--template", "services"])).toEqual({
			name: "demo",
			template: "services",
		});
	});

	it("emits a plain server: no manifest, no unstamped placeholder", () => {
		expect(existsSync(join(projectDir, "manifest.json"))).toBe(false);
		for (const file of [
			".env.example",
			"README.md",
			"tsconfig.json",
			"src/app.ts",
			"src/app.test.ts",
			"src/index.ts",
			"src/settings.ts",
		]) {
			expect(existsSync(join(projectDir, file))).toBe(true);
		}
		for (const file of filesUnder(projectDir)) {
			expect({
				file,
				unstamped: PLACEHOLDER.test(readFileSync(file, "utf8")),
			}).toEqual({ file, unstamped: false });
		}
		expect(readFileSync(join(projectDir, "README.md"), "utf8")).toStartWith(
			"# Notify Mail Demo\n"
		);
	});

	it("package.json depends on @ryuhq/services and Hono, not the extension SDK", () => {
		const pkg = z
			.object({
				name: z.string(),
				scripts: z.record(z.string(), z.string()),
				dependencies: z.record(z.string(), z.string()),
				devDependencies: z.record(z.string(), z.string()),
			})
			.parse(
				JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8"))
			);
		expect(pkg.name).toBe("notify-mail-demo");
		expect(pkg.dependencies).toEqual({
			"@ryuhq/services": `^${SDK_VERSION}`,
			hono: "^4.8.2",
		});
		const root = z
			.object({
				devDependencies: z.record(z.string(), z.string()),
				workspaces: z.object({ catalog: z.record(z.string(), z.string()) }),
			})
			.parse(JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")));
		const services = z
			.object({ devDependencies: z.record(z.string(), z.string()) })
			.parse(
				JSON.parse(
					readFileSync(join(PACKAGES, "services/package.json"), "utf8")
				)
			);
		// Same versions as the repo: the catalog's @types/bun, the root typescript.
		// The SDK hub pins its catalog exactly ("1.4.4") where the monorepo uses a
		// range ("^1.4.4"), so compare the version the range starts from.
		const floor = (range = "") => range.replace(/^[\^~]/, "");
		expect(Object.keys(pkg.devDependencies).sort()).toEqual([
			"@types/bun",
			"typescript",
		]);
		expect(floor(pkg.devDependencies["@types/bun"])).toBe(
			floor(root.workspaces.catalog["@types/bun"])
		);
		expect(pkg.devDependencies.typescript).toBe(
			root.devDependencies.typescript
		);
		// The Hono range the SDK itself is built and tested against.
		expect(pkg.dependencies.hono).toBe(services.devDependencies.hono);
		expect(pkg.scripts).toEqual({
			dev: "bun --hot src/index.ts",
			start: "bun src/index.ts",
			test: "bun test",
			"check-types": "tsc --noEmit",
		});
	});

	it("ships a .gitignore that keeps .env (and node_modules) out of git", () => {
		expect(existsSync(join(projectDir, "gitignore"))).toBe(false);
		const ignored = readFileSync(join(projectDir, ".gitignore"), "utf8")
			.split("\n")
			.map((line) => line.trim());
		expect(ignored).toContain(".env");
		expect(ignored).toContain("node_modules/");
		expect(ignored).toContain("!.env.example");
		// In a fresh repository outside this checkout, so only the scaffolded
		// .gitignore decides.
		const repo = mkdtempSync(join(tmpdir(), "services-gitignore-"));
		try {
			copyFileSync(join(projectDir, ".gitignore"), join(repo, ".gitignore"));
			spawnSync("git", ["init", "-q"], { cwd: repo });
			const check = spawnSync(
				"git",
				[
					"check-ignore",
					"--no-index",
					".env",
					".env.local",
					".env.example",
					"src/app.ts",
				],
				{ cwd: repo, encoding: "utf8" }
			);
			expect(check.stdout.trim().split("\n")).toEqual([".env", ".env.local"]);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("prints configure (cp .env.example .env) before run (bun dev)", () => {
		expect(nextSteps("demo", "services")).toEqual([
			"  next steps:",
			"    cd demo",
			"    bun install",
			"    cp .env.example .env   # then add your keys",
			"    bun dev         # runs the template entry",
		]);
		expect(nextSteps("demo", "agent").at(-1)).toBe(
			"    bun run pack    # validate and bundle manifest.json"
		);
		expect(nextSteps("demo", "app").at(-1)).toBe(
			"    bun run build   # compile the sidecar binary the manifest names"
		);
	});

	it(".env.example leaves PORT commented out so an empty value cannot pick a random port", () => {
		const lines = readFileSync(join(projectDir, ".env.example"), "utf8").split(
			"\n"
		);
		expect(lines).toContain("# PORT=3000");
		expect(lines.filter((line) => line.startsWith("PORT="))).toEqual([]);
	});

	it(".env.example lists exactly the SDK env vars the routes use, plus the app's own", () => {
		const names = envNames(join(projectDir, ".env.example"));
		const sdkNames = new Set(ENV_VARS.map((row) => row.name));
		const sdkListed = names.filter((name) => sdkNames.has(name));
		// Mail on a ryu_ key (+ organization) and Notify on its tenant key.
		expect(sdkListed).toEqual([
			"RYU_API_KEY",
			"RYU_ORGANIZATION_ID",
			"RYU_NOTIFY_API_KEY",
		]);
		// Every other RYU_ name would be an invented SDK variable.
		expect(
			names.filter((name) => name.startsWith("RYU_") && !sdkNames.has(name))
		).toEqual([]);

		const sources = ["src/settings.ts", "src/index.ts"]
			.map((file) => readFileSync(join(projectDir, file), "utf8"))
			.join("\n");
		const appRead = [...sources.matchAll(APP_ENV_READ)].map((m) => m[1]);
		expect(names.filter((name) => !sdkNames.has(name)).sort()).toEqual(
			[...new Set(appRead)].sort()
		);
	});

	it("README has the three-step quickstart, the npm status and the SDK's availability labels", () => {
		const readme = readFileSync(join(projectDir, "README.md"), "utf8");
		expect(readme).toContain("1. **Install:** `bun install`");
		expect(readme).toContain("2. **Configure:** `cp .env.example .env`");
		expect(readme).toContain("3. **Run:** `bun dev`");
		expect(
			readme.includes("`@ryuhq/services` is not yet published to npm")
		).toBe(NPM_PUBLISHED_VERSION === null);
		expect(readme).toContain(`Mail: ${AVAILABILITY.mail}`);
		expect(readme).toContain(`Notify: ${AVAILABILITY.notify}`);
	});

	it(
		"type-checks against the workspace @ryuhq/services and Hono",
		() => {
			writeFileSync(
				join(projectDir, "tsconfig.json"),
				workspaceTsconfig(projectDir)
			);
			const result = spawnSync(process.execPath, [TSC, "-p", "."], {
				cwd: projectDir,
				encoding: "utf8",
			});
			expect(`${result.stdout}${result.stderr}`).toBe("");
			expect(result.status).toBe(0);
		},
		{ timeout: 120_000 }
	);

	it(
		"passes its own bun test suite",
		() => {
			writeFileSync(
				join(projectDir, "tsconfig.json"),
				workspaceTsconfig(projectDir)
			);
			const result = spawnSync(process.execPath, ["test"], {
				cwd: projectDir,
				encoding: "utf8",
			});
			const output = `${result.stdout}${result.stderr}`;
			expect(output).toContain(" 0 fail");
			expect(result.status).toBe(0);
		},
		{ timeout: 120_000 }
	);

	it("its app module imports and serves the route index", async () => {
		writeFileSync(
			join(projectDir, "tsconfig.json"),
			workspaceTsconfig(projectDir)
		);
		const loaded: unknown = await import(join(projectDir, "src/app.ts"));
		const { createApp } = loaded as {
			createApp: (options: { settings: object }) => {
				request: (url: string) => Promise<Response>;
			};
		};
		expect(typeof createApp).toBe("function");
		const response = await createApp({ settings: {} }).request(
			"http://localhost/"
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			data: {
				name: "notify-mail-demo",
				routes: [
					"POST /notify",
					"POST /mail",
					"POST /webhooks/mail",
					"POST /webhooks/notify",
				],
			},
		});
	});
});
