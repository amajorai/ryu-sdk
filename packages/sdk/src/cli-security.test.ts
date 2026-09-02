import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
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
					copiedFiles: [
						"output-styles/bro.md",
						"output-styles/eli5.md",
						"output-styles/explanatory.md",
						"output-styles/gen-z.md",
						"output-styles/learning.md",
						"output-styles/no-ai-slop.md",
						"output-styles/no-hype.md",
						"output-styles/plain-technical.md",
						"output-styles/plain-text.md",
						"output-styles/proactive.md",
					],
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
				expect(workingResult.status).toBe(0);
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
