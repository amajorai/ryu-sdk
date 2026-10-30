import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../../..");
const CLI = join(import.meta.dir, "cli.ts");
const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

function temporaryPackage(): string {
	const directory = mkdtempSync(join(tmpdir(), "ryu-sdk-pack-"));
	temporaryDirectories.push(directory);
	return directory;
}

function runPack(directory: string) {
	return spawnSync(process.execPath, [CLI, "pack", directory], {
		encoding: "utf8",
	});
}

it("packs the authored conversation menu and hook priority without dropping fields", () => {
	const directory = temporaryPackage();
	cpSync(join(REPO_ROOT, "plugins-store/plugins/chat-title"), directory, {
		recursive: true,
	});
	const manifestPath = join(directory, "manifest.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	manifest.contributes.turn_hooks[0].priority = 17;
	writeFileSync(manifestPath, JSON.stringify(manifest));
	const result = runPack(directory);
	expect(result.status).toBe(0);
	const bundle = JSON.parse(
		readFileSync(join(directory, "dist/plugin.bundle.json"), "utf8")
	);
	expect(bundle.contributes.context_menu_items).toEqual(
		manifest.contributes.context_menu_items
	);
	expect(bundle.contributes.turn_hooks[0].priority).toBe(17);
	expect(bundle.contributes.turn_hooks[0].code).toBeString();
	expect(bundle.contributes.turn_hooks[0].code_file).toBeUndefined();
});

function writeCustomAdapterPackage(adapterTools: string[]): string {
	const directory = temporaryPackage();
	mkdirSync(join(directory, "adapters"));
	writeFileSync(
		join(directory, "adapters/web.search.js"),
		"// Capability adapter for `web.search / web.search`.\nreturn { raw: await callTool({ q: input.query }) };\n"
	);
	writeFileSync(
		join(directory, "manifest.json"),
		JSON.stringify({
			id: "com.example.search",
			name: "Example Search",
			version: "0.1.0",
			permission_grants: ["tool:execute"],
			runnables: [
				{
					id: "tool-example-search",
					name: "Example Search",
					kind: "tool",
					config: {
						slug: "example.search",
						backend: "http",
						method: "POST",
						url: "https://api.example.com/search",
					},
				},
			],
			provides: [
				{
					capability: "web.search",
					version: "1.0.0",
					selectable: true,
					tools: {
						"web.search": {
							tool: "example.search",
							adapter: {
								code_file: "adapters/web.search.js",
								tools: adapterTools,
							},
						},
					},
				},
			],
		})
	);
	return directory;
}

it("inlines a custom capability adapter's code_file into the packed bundle", () => {
	const directory = writeCustomAdapterPackage([]);
	const result = runPack(directory);
	expect(result.status, result.stderr).toBe(0);
	const bundle = JSON.parse(
		readFileSync(join(directory, "dist/plugin.bundle.json"), "utf8")
	);
	const adapter = bundle.provides[0].tools["web.search"].adapter;
	expect(adapter.code).toContain("callTool");
	expect(adapter.code_file).toBeUndefined();
});

it("refuses to pack an adapter that reaches a tool its plugin does not own", () => {
	const directory = writeCustomAdapterPackage(["honcho.messages"]);
	const result = runPack(directory);
	expect(result.status).toBe(1);
	expect(result.stderr).toContain("failed Core validation");
	expect(result.stderr).toContain("not owned by this provider");
});

describe.skipIf(process.platform === "win32")(
	"ryu pack package containment",
	() => {
		it("rejects external symlinks for hooks, adapters, and output styles", () => {
			const scenarios = [
				{
					manifest: "plugins-store/plugins/tool-firewall/manifest.json",
					linkedFile: "hooks/pre.js",
					copiedFiles: ["hooks/post.js"],
				},
				{
					manifest:
						"plugins-store/external_plugins/cloudflare-browser-run/manifest.json",
					linkedFile: "adapters/browser.navigate.js",
					copiedFiles: [
						"adapters/browser.screenshot.js",
						"adapters/browser.snapshot.js",
					],
				},
				{
					manifest: "plugins-store/plugins/output-styles/manifest.json",
					linkedFile: "output-styles/i-have-adhd.md",
					copiedFiles: JSON.parse(
						readFileSync(
							join(
								REPO_ROOT,
								"plugins-store/plugins/output-styles/manifest.json"
							),
							"utf8"
						)
					)
						.contributes.output_styles.map(
							(style: { file: string }) => style.file
						)
						.filter((file: string) => file !== "output-styles/i-have-adhd.md"),
				},
			];

			for (const scenario of scenarios) {
				const directory = temporaryPackage();
				const sourceRoot = dirname(join(REPO_ROOT, scenario.manifest));
				writeFileSync(
					join(directory, "manifest.json"),
					readFileSync(join(REPO_ROOT, scenario.manifest))
				);
				for (const file of scenario.copiedFiles) {
					mkdirSync(dirname(join(directory, file)), { recursive: true });
					writeFileSync(
						join(directory, file),
						readFileSync(join(sourceRoot, file))
					);
				}
				mkdirSync(dirname(join(directory, scenario.linkedFile)), {
					recursive: true,
				});
				writeFileSync(
					join(directory, scenario.linkedFile),
					readFileSync(join(sourceRoot, scenario.linkedFile))
				);
				const workingResult = runPack(directory);
				expect(workingResult.status, workingResult.stderr).toBe(0);
				unlinkSync(join(directory, scenario.linkedFile));

				const external = join(dirname(directory), `${Date.now()}-outside.txt`);
				writeFileSync(external, "private host data");
				symlinkSync(external, join(directory, scenario.linkedFile));

				const result = runPack(directory);
				expect(result.status).toBe(1);
				rmSync(external, { force: true });
			}
		});
	}
);

describe("github-publish control-plane origin", () => {
	function publishTo(env: Record<string, string>) {
		const {
			RYU_MARKETPLACE_API_URL: _marketplace,
			RYU_API_URL: _api,
			...base
		} = process.env;
		return spawnSync(
			process.execPath,
			[CLI, "github-publish", "https://github.com/acme/my-app"],
			{
				encoding: "utf8",
				env: { ...base, RYU_AUTH_TOKEN: "session-token", ...env },
				timeout: 30_000,
			}
		);
	}

	it("falls back to RYU_API_URL, the @ryuhq/services name for the same origin", () => {
		const result = publishTo({ RYU_API_URL: "http://127.0.0.1:1/" });
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(
			"could not reach http://127.0.0.1:1/api/marketplace/github/publish"
		);
	});

	it("prefers RYU_MARKETPLACE_API_URL over RYU_API_URL", () => {
		const result = publishTo({
			RYU_API_URL: "http://127.0.0.1:1",
			RYU_MARKETPLACE_API_URL: "http://127.0.0.1:2",
		});
		expect(result.stderr).toContain(
			"could not reach http://127.0.0.1:2/api/marketplace/github/publish"
		);
	});
});
