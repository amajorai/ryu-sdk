import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseDocument, stringify } from "yaml";
import { z } from "zod";

const SkillFrontmatterSchema = z.record(z.string(), z.json());
type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;
const YamlMappingSchema = z.object({}).passthrough();
const FileErrorSchema = z.object({ code: z.string() });

interface ParsedSkillMarkdown {
	frontmatter: SkillFrontmatter;
	markdown: string;
}

interface SkillsListPage {
	nextCursor?: string;
	skills: ChatGPTSkill[];
}

const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";
const MAX_SKILLS = 5;
const MAX_FILES_PER_SKILL = 100;
const MAX_SKILL_MARKDOWN_BYTES = 256 * 1024;
const MAX_SUPPORTING_FILE_BYTES = 1024 * 1024;
const MAX_SKILL_BYTES = 5 * 1024 * 1024;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

const SkillsListRequestSchema = z
	.object({
		method: z.literal("skills/list"),
		params: z
			.object({ cursor: z.string().optional() })
			.passthrough()
			.optional(),
	})
	.passthrough();

const SkillsGetRequestSchema = z
	.object({
		method: z.literal("skills/get"),
		params: z.object({ uri: z.string() }).passthrough(),
	})
	.passthrough();

export interface ChatGPTSkillResource {
	bytes: Uint8Array;
	digest: string;
	mimeType: string;
	relativePath: string;
	skillName: string;
	uri: string;
}

export interface ChatGPTSkill {
	frontmatter: SkillFrontmatter;
	name: string;
	resources: Array<{ digest: string; uri: string }>;
	uri: string;
}

export interface ChatGPTSkillBundle {
	files: ChatGPTSkillResource[];
	pluginName: string;
	skills: ChatGPTSkill[];
	totalBytes: number;
}

export interface LoadChatGPTSkillsOptions {
	directory: string;
	pluginName: string;
	/** An optional exact allowlist of skill folder names to include. */
	skillIds?: readonly string[];
}

export interface RegisterChatGPTSkillsOptions extends LoadChatGPTSkillsOptions {
	pageSize?: number;
}

export interface RegisterChatGPTSkillBundleOptions {
	pageSize?: number;
}

function isSafeSlug(value: string): boolean {
	return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function isSafePluginName(value: string): boolean {
	return (
		/^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.test(value) &&
		!value.includes("..") &&
		!value.includes("--")
	);
}

function isWithin(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

function encodeUriPath(relativePath: string): string {
	return relativePath
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
}

function mimeTypeFor(path: string): string {
	switch (extname(path).toLowerCase()) {
		case ".css":
			return "text/css";
		case ".html":
			return "text/html";
		case ".js":
		case ".mjs":
			return "text/javascript";
		case ".json":
			return "application/json";
		case ".md":
			return "text/markdown";
		case ".svg":
			return "image/svg+xml";
		case ".txt":
			return "text/plain";
		default:
			return "application/octet-stream";
	}
}

function parseFrontmatter(
	markdown: string,
	skillName: string
): ParsedSkillMarkdown {
	const block = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(
		markdown
	);
	if (!block) {
		throw new Error(
			`skill '${skillName}' SKILL.md must start with YAML frontmatter`
		);
	}

	const document = parseDocument(block[1] ?? "", {
		schema: "core",
		uniqueKeys: true,
	});
	if (document.errors.length > 0) {
		throw new Error(`skill '${skillName}' has invalid YAML frontmatter`);
	}

	let source: z.infer<typeof YamlMappingSchema>;
	try {
		const decoded = YamlMappingSchema.safeParse(document.toJS());
		if (!decoded.success) {
			throw new Error(
				`skill '${skillName}' frontmatter must be a YAML mapping`
			);
		}
		source = decoded.data;
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.includes("must be a YAML mapping")
		) {
			throw error;
		}
		throw new Error(
			`skill '${skillName}' frontmatter must contain JSON-compatible values`
		);
	}

	let frontmatter: SkillFrontmatter;
	try {
		frontmatter = SkillFrontmatterSchema.parse(
			JSON.parse(JSON.stringify(source))
		);
	} catch {
		throw new Error(
			`skill '${skillName}' frontmatter must contain JSON-compatible values`
		);
	}

	const description = z.string().safeParse(frontmatter.description);
	if (!(description.success && description.data.trim())) {
		throw new Error(`skill '${skillName}' frontmatter needs a description`);
	}
	const name = z.string().safeParse(frontmatter.name);
	if (!(name.success && name.data.trim())) {
		throw new Error(`skill '${skillName}' frontmatter needs a name`);
	}

	// OpenAI's MCP Skills importer requires the folder name and frontmatter name to
	// match. Ryu skill names are display labels, so the portable projection uses the
	// stable folder slug and preserves every other frontmatter entry.
	frontmatter.name = skillName;
	const serialized = stringify(frontmatter).trimEnd();
	const body = markdown.slice(block[0].length);
	return {
		frontmatter,
		markdown: `---\n${serialized}\n---\n${body}`,
	};
}

async function readSkillFiles(
	skillDirectory: string,
	root: string,
	pluginName: string,
	skillName: string
): Promise<{
	files: ChatGPTSkillResource[];
	skill: ChatGPTSkill;
	totalBytes: number;
}> {
	const files: ChatGPTSkillResource[] = [];
	const relativePaths = new Set<string>();
	const foldedPaths = new Set<string>();
	let totalBytes = 0;
	let frontmatter: SkillFrontmatter | undefined;

	async function walk(directory: string): Promise<void> {
		const entries = await readdir(directory, { withFileTypes: true });
		entries.sort((left, right) => left.name.localeCompare(right.name));

		for (const entry of entries) {
			if (entry.isSymbolicLink()) {
				throw new Error(
					`skill '${skillName}' contains a symlink: ${entry.name}`
				);
			}
			if (
				entry.name === "." ||
				entry.name === ".." ||
				entry.name.includes("\\")
			) {
				throw new Error(`skill '${skillName}' contains an unsafe path segment`);
			}

			const entryPath = join(directory, entry.name);
			const realEntryPath = await realpath(entryPath);
			if (!isWithin(root, realEntryPath)) {
				throw new Error(
					`skill '${skillName}' contains a path outside the skills directory`
				);
			}

			if (entry.isDirectory()) {
				await walk(entryPath);
				continue;
			}
			if (!entry.isFile()) {
				throw new Error(
					`skill '${skillName}' contains a non-file resource: ${entry.name}`
				);
			}

			const relativePath = relative(skillDirectory, entryPath)
				.split(sep)
				.join("/");
			if (
				relativePath.startsWith("/") ||
				relativePath
					.split("/")
					.some((part) => part === "" || part === "." || part === "..")
			) {
				throw new Error(
					`skill '${skillName}' contains an unsafe resource path`
				);
			}
			if (relativePaths.has(relativePath)) {
				throw new Error(
					`skill '${skillName}' contains duplicate resource paths`
				);
			}
			const foldedPath = relativePath.toLocaleLowerCase("en-US");
			if (foldedPaths.has(foldedPath)) {
				throw new Error(
					`skill '${skillName}' contains resource paths that differ only by case`
				);
			}
			relativePaths.add(relativePath);
			foldedPaths.add(foldedPath);

			if (files.length >= MAX_FILES_PER_SKILL) {
				throw new Error(
					`skill '${skillName}' has more than ${MAX_FILES_PER_SKILL} files`
				);
			}

			const stat = await lstat(entryPath);
			const isSkillMarkdown = relativePath === "SKILL.md";
			const fileLimit = isSkillMarkdown
				? MAX_SKILL_MARKDOWN_BYTES
				: MAX_SUPPORTING_FILE_BYTES;
			if (stat.size > fileLimit) {
				const limit = isSkillMarkdown ? "256 KiB" : "1 MiB";
				throw new Error(
					`skill '${skillName}' resource '${relativePath}' exceeds ${limit}`
				);
			}

			let bytes = await readFile(entryPath);
			if (isSkillMarkdown) {
				const parsed = parseFrontmatter(bytes.toString("utf8"), skillName);
				frontmatter = parsed.frontmatter;
				bytes = Buffer.from(parsed.markdown, "utf8");
			}
			totalBytes += bytes.byteLength;
			if (totalBytes > MAX_SKILL_BYTES) {
				throw new Error(
					`skill '${skillName}' exceeds the 5 MiB total resource limit`
				);
			}

			const uri = `skill://${pluginName}/${skillName}/${encodeUriPath(relativePath)}`;
			const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
			files.push({
				bytes,
				digest,
				mimeType: mimeTypeFor(relativePath),
				relativePath,
				skillName,
				uri,
			});
		}
	}

	await walk(skillDirectory);
	if (!frontmatter) {
		throw new Error(`skill '${skillName}' is missing its root SKILL.md file`);
	}

	const markdown = files.find((file) => file.relativePath === "SKILL.md");
	if (!markdown) {
		throw new Error(`skill '${skillName}' is missing its root SKILL.md file`);
	}

	return {
		files,
		skill: {
			frontmatter,
			name: skillName,
			resources: files.map(({ digest, uri }) => ({ digest, uri })),
			uri: markdown.uri,
		},
		totalBytes,
	};
}

export async function loadChatGPTSkills(
	options: LoadChatGPTSkillsOptions
): Promise<ChatGPTSkillBundle> {
	if (!isSafePluginName(options.pluginName)) {
		throw new Error("pluginName must be a lowercase portable plugin name");
	}
	const requested = options.skillIds ? new Set(options.skillIds) : undefined;
	if (requested && requested.size !== options.skillIds?.length) {
		throw new Error("skillIds must not contain duplicates");
	}
	if (requested) {
		for (const skillId of requested) {
			if (!isSafeSlug(skillId)) {
				throw new Error(
					`skill id '${skillId}' must be a lowercase hyphenated slug`
				);
			}
		}
	}

	const sourceDirectory = resolve(options.directory);
	const sourceStat = await lstat(sourceDirectory).catch((error) => {
		if (FileErrorSchema.safeParse(error).data?.code === "ENOENT") {
			return undefined;
		}
		throw error;
	});
	if (!sourceStat) {
		if (requested?.size) {
			throw new Error("the selected skills directory does not exist");
		}
		return {
			files: [],
			pluginName: options.pluginName,
			skills: [],
			totalBytes: 0,
		};
	}
	if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
		throw new Error("skills directory must be a real directory, not a symlink");
	}

	const skillsRoot = await realpath(sourceDirectory);
	const entries = await readdir(skillsRoot, { withFileTypes: true });
	const skillDirectories = entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort((left, right) => left.localeCompare(right));
	for (const entry of entries) {
		if (entry.isSymbolicLink()) {
			throw new Error(`skills directory contains a symlink: ${entry.name}`);
		}
	}

	const selected = requested
		? skillDirectories.filter((name) => requested.has(name))
		: skillDirectories;
	if (requested && selected.length !== requested.size) {
		const missing = [...requested].filter(
			(id) => !skillDirectories.includes(id)
		);
		throw new Error(
			`unknown skill id${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`
		);
	}
	if (selected.length > MAX_SKILLS) {
		throw new Error(
			`ChatGPT skill import supports up to ${MAX_SKILLS} skills; select a subset with --skills ${skillDirectories.slice(0, MAX_SKILLS).join(",")}`
		);
	}
	for (const skillName of selected) {
		if (!isSafeSlug(skillName)) {
			throw new Error(
				`skill folder '${skillName}' must be a lowercase hyphenated slug`
			);
		}
	}

	const skills: ChatGPTSkill[] = [];
	const files: ChatGPTSkillResource[] = [];
	let totalBytes = 0;
	for (const skillName of selected) {
		const skillDirectory = join(skillsRoot, skillName);
		const skillStat = await lstat(skillDirectory);
		if (skillStat.isSymbolicLink() || !skillStat.isDirectory()) {
			throw new Error(`skill '${skillName}' must be a real directory`);
		}
		const loaded = await readSkillFiles(
			skillDirectory,
			skillsRoot,
			options.pluginName,
			skillName
		);
		totalBytes += loaded.totalBytes;
		if (totalBytes > MAX_SCAN_BYTES) {
			throw new Error(
				"ChatGPT skill import resources exceed the 8 MiB total limit"
			);
		}
		skills.push(loaded.skill);
		files.push(...loaded.files);
	}

	if (requested?.size && selected.length === 0) {
		throw new Error("no selected skills were found");
	}

	return { files, pluginName: options.pluginName, skills, totalBytes };
}

export function registerChatGPTSkillBundle(
	server: McpServer,
	bundle: ChatGPTSkillBundle,
	options: RegisterChatGPTSkillBundleOptions = {}
): ChatGPTSkillBundle {
	if (bundle.skills.length === 0) {
		throw new Error("no skills found to register");
	}
	const pageSize = options.pageSize ?? MAX_SKILLS;
	if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_SKILLS) {
		throw new Error(`pageSize must be an integer from 1 to ${MAX_SKILLS}`);
	}

	server.server.registerCapabilities({
		extensions: { [SKILLS_EXTENSION_ID]: {} },
		resources: { listChanged: false },
	});
	for (const file of bundle.files) {
		server.registerResource(
			`${file.skillName}/${file.relativePath}`,
			file.uri,
			{ mimeType: file.mimeType },
			async (uri) => {
				const content = new TextDecoder("utf-8", { fatal: true });
				let text: string | undefined;
				try {
					text = content.decode(file.bytes);
				} catch {
					text = undefined;
				}
				return {
					contents: [
						{
							uri: uri.href,
							mimeType: file.mimeType,
							...(text === undefined
								? { blob: Buffer.from(file.bytes).toString("base64") }
								: { text }),
						},
					],
				};
			}
		);
	}

	server.server.setRequestHandler(SkillsListRequestSchema, (request) => {
		const cursor = request.params?.cursor;
		const offset = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
		if (
			!Number.isSafeInteger(offset) ||
			offset < 0 ||
			String(offset) !== (cursor ?? "0")
		) {
			throw new Error("skills/list cursor is invalid");
		}
		if (offset > bundle.skills.length) {
			throw new Error("skills/list cursor is outside the catalog");
		}
		const skills = bundle.skills.slice(offset, offset + pageSize);
		const nextOffset = offset + skills.length;
		const page: SkillsListPage = { skills };
		if (nextOffset < bundle.skills.length) {
			page.nextCursor = String(nextOffset);
		}
		return { ...page };
	});

	server.server.setRequestHandler(SkillsGetRequestSchema, (request) => {
		const skill = bundle.skills.find(
			(entry) => entry.uri === request.params.uri
		);
		if (!skill) {
			throw new Error("skills/get requested an unknown skill URI");
		}
		return { skill };
	});

	return bundle;
}

export async function registerChatGPTSkills(
	server: McpServer,
	options: RegisterChatGPTSkillsOptions
): Promise<ChatGPTSkillBundle> {
	const bundle = await loadChatGPTSkills(options);
	return registerChatGPTSkillBundle(server, bundle, options);
}
