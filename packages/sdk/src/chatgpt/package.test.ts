import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packChatGPTPlugin } from "./package.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
	for (const directory of temporaryRoots.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

function createPluginFixture(): string {
	const directory = join(tmpdir(), `ryu-chatgpt-plugin-${randomUUID()}`);
	mkdirSync(directory, { recursive: true });
	temporaryRoots.push(directory);
	writeFileSync(
		join(directory, "manifest.json"),
		JSON.stringify({
			id: "@ryu/research-kit",
			name: "Research Kit",
			version: "1.2.0",
			description: "Research project sources with safe, repeatable workflows.",
			tagline: "Build sourced project briefs",
			author: { name: "Ryu Labs" },
			homepage: "https://ryu.example.com/research",
			runnables: [
				{
					id: "skill-research",
					name: "Research",
					kind: "skill",
					config: { skill_id: "research" },
				},
			],
			mcp_servers: {
				docs: {
					type: "streamable-http",
					url: "https://mcp.example.com/mcp",
					headers: {
						Authorization: "Bearer never-export-this",
						"X-Trace-Mode": "short",
					},
				},
			},
		}),
		"utf8"
	);
	mkdirSync(join(directory, "skills", "research", "references"), {
		recursive: true,
	});
	writeFileSync(
		join(directory, "skills", "research", "SKILL.md"),
		"---\nname: Project Research\ndescription: Create a sourced project brief.\nallowed-tools:\n  - search\n---\nUse the search tool, then cite each source.\n",
		"utf8"
	);
	writeFileSync(
		join(directory, "skills", "research", "references", "source-guide.md"),
		"Verify every source before citing it.\n",
		"utf8"
	);
	writeFileSync(
		join(directory, ".app.json"),
		JSON.stringify({ apps: {} }),
		"utf8"
	);
	return directory;
}

describe("packChatGPTPlugin", () => {
	test("builds one portable directory with safe MCP config and bundled skill resources", async () => {
		const directory = createPluginFixture();
		const result = await packChatGPTPlugin({ directory });
		const pluginPath = join(result.outputDirectory, "plugin.json");
		const mcpPath = join(result.outputDirectory, "mcp.json");
		const skillPath = join(
			result.outputDirectory,
			"skills",
			"research",
			"SKILL.md"
		);
		const plugin = JSON.parse(readFileSync(pluginPath, "utf8"));
		const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
		const skill = readFileSync(skillPath, "utf8");

		expect(plugin.$schema).toContain("agent-plugins.org/schemas/1.0.0");
		expect(plugin.extensions["com.openai"]).toMatchObject({
			apps: "./.app.json",
			interface: {
				displayName: "Research Kit",
				shortDescription: "Build sourced project briefs",
			},
		});
		expect(mcp.mcpServers.docs).toEqual({
			type: "streamable-http",
			url: "https://mcp.example.com/mcp",
			headers: { "X-Trace-Mode": "short" },
		});
		expect(JSON.stringify(mcp)).not.toContain("never-export-this");
		expect(skill).toContain("name: research");
		expect(skill).toContain("Use the search tool, then cite each source.");
		expect(
			readFileSync(
				join(
					result.outputDirectory,
					"skills",
					"research",
					"references",
					"source-guide.md"
				),
				"utf8"
			)
		).toContain("Verify every source");
		expect(result.skills).toEqual(["research"]);
		expect(
			result.notes.some((note) => note.includes("credential-bearing headers"))
		).toBe(true);
		expect(result.outputDirectory).toBe(
			join(directory, "dist", "chatgpt-plugin")
		);
	});

	test("rebuilds its managed output and refuses to overwrite an unmanaged directory", async () => {
		const directory = createPluginFixture();
		const first = await packChatGPTPlugin({ directory });
		writeFileSync(join(first.outputDirectory, "stale.txt"), "old");
		const rebuilt = await packChatGPTPlugin({ directory });
		expect(rebuilt.outputDirectory).toBe(first.outputDirectory);
		expect(() =>
			readFileSync(join(rebuilt.outputDirectory, "stale.txt"), "utf8")
		).toThrow();

		const otherDirectory = join(directory, "other");
		mkdirSync(join(otherDirectory, "dist", "chatgpt-plugin"), {
			recursive: true,
		});
		writeFileSync(
			join(otherDirectory, "manifest.json"),
			JSON.stringify({
				id: "@ryu/other",
				name: "Other",
				version: "1.0.0",
				runnables: [],
			})
		);
		writeFileSync(
			join(otherDirectory, ".app.json"),
			JSON.stringify({ apps: {} })
		);
		writeFileSync(
			join(otherDirectory, "dist", "chatgpt-plugin", "keep.txt"),
			"user file"
		);
		await expect(
			packChatGPTPlugin({ directory: otherDirectory })
		).rejects.toThrow("unmanaged");
		await packChatGPTPlugin({ directory: otherDirectory, force: true });
		expect(
			readFileSync(
				join(otherDirectory, "dist", "chatgpt-plugin", "plugin.json"),
				"utf8"
			)
		).toContain("ryu.other");
	});

	test("allows an explicit subset when the source bundle has more than five skills", async () => {
		const directory = createPluginFixture();
		for (const name of ["calendar", "notes", "tasks", "wiki", "writing"]) {
			const skillDirectory = join(directory, "skills", name);
			mkdirSync(skillDirectory, { recursive: true });
			writeFileSync(
				join(skillDirectory, "SKILL.md"),
				`---\nname: ${name}\ndescription: ${name} workflow.\n---\nUse ${name}.\n`,
				"utf8"
			);
		}
		writeFileSync(
			join(directory, "manifest.json"),
			JSON.stringify({
				id: "@ryu/research-kit",
				name: "Research Kit",
				version: "1.2.0",
				runnables: [],
			}),
			"utf8"
		);
		await expect(packChatGPTPlugin({ directory })).rejects.toThrow(
			"up to 5 skills"
		);
		const result = await packChatGPTPlugin({
			directory,
			force: true,
			skillIds: ["research", "calendar"],
		});
		expect(result.skills).toEqual(["calendar", "research"]);
		expect(
			readFileSync(
				join(result.outputDirectory, "skills", "calendar", "SKILL.md"),
				"utf8"
			)
		).toContain("Use calendar.");
	});

	test("rejects credential-like .app.json contents before writing a package", async () => {
		const directory = createPluginFixture();
		writeFileSync(
			join(directory, ".app.json"),
			JSON.stringify({ apps: { private: { access_token: "do-not-ship" } } }),
			"utf8"
		);
		await expect(packChatGPTPlugin({ directory })).rejects.toThrow(
			"credential-like data"
		);
	});
});
