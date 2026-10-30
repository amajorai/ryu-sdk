import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadChatGPTSkills } from "./skills.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
	for (const directory of temporaryRoots.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

function createSkillsRoot(): string {
	const directory = join(tmpdir(), `ryu-chatgpt-skills-${randomUUID()}`);
	mkdirSync(directory, { recursive: true });
	temporaryRoots.push(directory);
	return directory;
}

function writeSkill(
	root: string,
	slug: string,
	name = `Display ${slug}`
): void {
	const directory = join(root, slug);
	mkdirSync(join(directory, "references"), { recursive: true });
	writeFileSync(
		join(directory, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${slug} workflow.\nallowed-tools:\n  - search\n---\nUse search and cite sources.\n`,
		"utf8"
	);
	writeFileSync(
		join(directory, "references", "guide.md"),
		`Supporting guidance for ${slug}.\n`,
		"utf8"
	);
}

describe("loadChatGPTSkills", () => {
	test("normalizes Ryu display names and returns digests for every resource", async () => {
		const directory = createSkillsRoot();
		writeSkill(directory, "research");
		const bundle = await loadChatGPTSkills({
			directory,
			pluginName: "ryu.research-kit",
		});
		const skill = bundle.skills[0];
		const markdown = bundle.files.find(
			(file) => file.relativePath === "SKILL.md"
		);
		if (!(skill && markdown)) {
			throw new Error("fixture skill was not loaded");
		}

		expect(skill.uri).toBe("skill://ryu.research-kit/research/SKILL.md");
		expect(skill.frontmatter).toMatchObject({
			name: "research",
			description: "research workflow.",
			"allowed-tools": ["search"],
		});
		expect(markdown.digest).toBe(
			`sha256:${createHash("sha256").update(markdown.bytes).digest("hex")}`
		);
		expect(Buffer.from(markdown.bytes).toString("utf8")).toContain(
			"name: research"
		);
		expect(skill.resources).toHaveLength(2);
		expect(bundle.totalBytes).toBeGreaterThan(0);
	});

	test("exports only the requested skill folders", async () => {
		const directory = createSkillsRoot();
		writeSkill(directory, "research");
		writeSkill(directory, "calendar");
		const bundle = await loadChatGPTSkills({
			directory,
			pluginName: "ryu.assistant",
			skillIds: ["calendar"],
		});
		expect(bundle.skills.map((skill) => skill.name)).toEqual(["calendar"]);
		expect(bundle.files.every((file) => file.uri.includes("/calendar/"))).toBe(
			true
		);
	});

	test("rejects ambiguous selections and unsafe package names", async () => {
		const directory = createSkillsRoot();
		writeSkill(directory, "research");
		await expect(
			loadChatGPTSkills({
				directory,
				pluginName: "ryu.assistant",
				skillIds: ["research", "research"],
			})
		).rejects.toThrow("duplicates");
		await expect(
			loadChatGPTSkills({ directory, pluginName: "../outside" })
		).rejects.toThrow("lowercase portable plugin name");
	});

	test("rejects non-mapping and cyclic YAML frontmatter", async () => {
		for (const [yaml, expected] of [
			["- research", "must be a YAML mapping"],
			[
				"name: research\ndescription: workflow\nmetadata: &self { child: *self }",
				"JSON-compatible values",
			],
		]) {
			const directory = createSkillsRoot();
			writeSkill(directory, "research");
			writeFileSync(
				join(directory, "research", "SKILL.md"),
				`---\n${yaml}\n---\nBody\n`
			);
			await expect(
				loadChatGPTSkills({ directory, pluginName: "ryu.assistant" })
			).rejects.toThrow(expected);
		}
	});

	test("rejects malformed skills and respects OpenAI's per-scan skill limit", async () => {
		const missingDescription = createSkillsRoot();
		mkdirSync(join(missingDescription, "research"), { recursive: true });
		writeFileSync(
			join(missingDescription, "research", "SKILL.md"),
			"---\nname: research\n---\nBody\n",
			"utf8"
		);
		await expect(
			loadChatGPTSkills({
				directory: missingDescription,
				pluginName: "ryu.assistant",
			})
		).rejects.toThrow("needs a description");

		const tooMany = createSkillsRoot();
		for (const slug of ["one", "two", "three", "four", "five", "six"]) {
			writeSkill(tooMany, slug);
		}
		await expect(
			loadChatGPTSkills({ directory: tooMany, pluginName: "ryu.assistant" })
		).rejects.toThrow("up to 5 skills");
	});
});
