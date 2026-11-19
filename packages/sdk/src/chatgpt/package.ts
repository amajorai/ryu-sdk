import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
	type AgentPluginJson,
	type AgentPluginMcpJson,
	toChatGPTPlugin,
	toSpecName,
} from "../agent-plugin.ts";
import { PluginManifestSchema } from "../manifest.ts";
import {
	type PrimitiveJsonValue,
	primitiveJsonObjectSchema,
	primitiveJsonSchema,
} from "../runnable/primitive-contracts.ts";
import { loadChatGPTSkills } from "./skills.ts";

const CHATGPT_PACKAGE_DIR = "chatgpt-plugin";
const CHATGPT_PACKAGE_MARKER = ".chatgpt-plugin-build.json";

export interface PackChatGPTPluginOptions {
	directory: string;
	force?: boolean;
	skillIds?: readonly string[];
}

export interface PackChatGPTPluginResult {
	mcp: AgentPluginMcpJson | null;
	notes: string[];
	outputDirectory: string;
	plugin: AgentPluginJson;
	skills: string[];
}

interface ChatGPTPackageMarker {
	pluginId: string;
	version: 1;
}

function isRecord(
	value: PrimitiveJsonValue | undefined
): value is z.output<typeof primitiveJsonObjectSchema> {
	return primitiveJsonObjectSchema.safeParse(value).success;
}
const missingFileSchema = z.object({ code: z.literal("ENOENT") });

function isWithin(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

function lstatIfExists(path: string): ReturnType<typeof lstatSync> | undefined {
	try {
		return lstatSync(path);
	} catch (error) {
		if (missingFileSchema.safeParse(error).success) {
			return undefined;
		}
		throw error;
	}
}

function assertSafeSourceRoot(directory: string): string {
	const absolute = resolve(directory);
	const stat = lstatIfExists(absolute);
	if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new Error("ChatGPT plugin source must be a real directory");
	}
	return realpathSync(absolute);
}

function assertNoCredentialMaterial(
	value: PrimitiveJsonValue,
	path: string
): void {
	if (Array.isArray(value)) {
		for (const [index, entry] of value.entries()) {
			assertNoCredentialMaterial(entry, `${path}[${index}]`);
		}
		return;
	}
	if (isRecord(value)) {
		for (const [key, entry] of Object.entries(value)) {
			if (
				/(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|credential|cookie)/i.test(
					key
				)
			) {
				throw new Error(
					`.app.json contains credential-like data at ${path}.${key}`
				);
			}
			assertNoCredentialMaterial(entry, `${path}.${key}`);
		}
		return;
	}
	const text = z.string().safeParse(value);
	if (
		text.success &&
		(/^(?:bearer|basic)\s+\S+/i.test(text.data) ||
			/(?:^|[?&#\s])(?:access[-_]?token|api[-_]?key|credential|password|secret|token)\s*[:=]\s*[^&\s]+/i.test(
				text.data
			) ||
			/(?:gh[pousr]_[a-z0-9]{16,}|sk-[a-z0-9]{16,}|xox[baprs]-[a-z0-9-]{10,})/i.test(
				text.data
			))
	) {
		throw new Error(`.app.json contains credential-like data at ${path}`);
	}
}

function parseNativeManifest(path: string) {
	const stat = lstatIfExists(path);
	if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
		throw new Error(
			"manifest.json must be a regular file inside the plugin directory"
		);
	}
	let value: PrimitiveJsonValue;
	try {
		value = primitiveJsonSchema.parse(JSON.parse(readFileSync(path, "utf8")));
	} catch (error) {
		throw new Error(`could not read native manifest: ${String(error)}`);
	}
	if (!isRecord(value)) {
		throw new Error("native manifest must be a JSON object");
	}
	return value;
}

function declaredSkillIds(
	manifest: z.output<typeof primitiveJsonObjectSchema>
): string[] {
	if (!Array.isArray(manifest.runnables)) {
		return [];
	}
	const skillIds: string[] = [];
	for (const runnable of manifest.runnables) {
		if (
			!isRecord(runnable) ||
			runnable.kind !== "skill" ||
			!isRecord(runnable.config)
		) {
			continue;
		}
		const skillId = z.string().safeParse(runnable.config.skill_id);
		if (skillId.success && skillId.data.trim()) {
			skillIds.push(skillId.data.trim());
		}
	}
	return skillIds;
}

function validateMarker(path: string, pluginId: string): void {
	const markerStat = lstatIfExists(path);
	if (!markerStat) {
		return;
	}
	if (markerStat.isSymbolicLink() || !markerStat.isFile()) {
		throw new Error("ChatGPT package marker must be a regular file");
	}
	let value: PrimitiveJsonValue;
	try {
		value = primitiveJsonSchema.parse(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		throw new Error(
			"ChatGPT package marker is invalid; use --force to replace the generated output"
		);
	}
	if (!isRecord(value) || value.version !== 1 || value.pluginId !== pluginId) {
		throw new Error(
			"ChatGPT package marker belongs to another plugin; use --force to replace the generated output"
		);
	}
}

function writeBundleFiles(
	stageDirectory: string,
	plugin: AgentPluginJson,
	mcp: AgentPluginMcpJson | null,
	appConfig: Uint8Array | undefined,
	skills: Awaited<ReturnType<typeof loadChatGPTSkills>>
): void {
	writeFileSync(
		join(stageDirectory, "plugin.json"),
		`${JSON.stringify(plugin, null, 2)}\n`,
		"utf8"
	);
	if (mcp) {
		writeFileSync(
			join(stageDirectory, "mcp.json"),
			`${JSON.stringify(mcp, null, 2)}\n`,
			"utf8"
		);
	}
	if (appConfig) {
		writeFileSync(join(stageDirectory, ".app.json"), appConfig);
	}
	for (const file of skills.files) {
		const outputPath = join(
			stageDirectory,
			"skills",
			file.skillName,
			file.relativePath
		);
		const relativeOutput = relative(stageDirectory, outputPath);
		if (
			!isWithin(stageDirectory, resolve(outputPath)) ||
			relativeOutput.startsWith("..")
		) {
			throw new Error(
				`skill resource path escaped the output directory: ${file.relativePath}`
			);
		}
		mkdirSync(dirname(outputPath), { recursive: true });
		writeFileSync(outputPath, file.bytes);
	}
}

/**
 * Create a ChatGPT-compatible Agent Plugin directory at
 * `<plugin>/dist/chatgpt-plugin`. Only plugin-declared MCP servers and the
 * package's `skills/` tree are included; node-level settings and user MCP
 * configuration are never read.
 */
export async function packChatGPTPlugin(
	options: PackChatGPTPluginOptions
): Promise<PackChatGPTPluginResult> {
	const sourceRoot = assertSafeSourceRoot(options.directory);
	const manifest = parseNativeManifest(join(sourceRoot, "manifest.json"));
	const parsedId = z.string().safeParse(manifest.id);
	const pluginId = parsedId.success ? parsedId.data : "";
	if (!pluginId) {
		throw new Error("native manifest has no plugin id");
	}
	const validation = PluginManifestSchema.safeParse(manifest);
	if (!validation.success) {
		const issue = validation.error.issues[0];
		const field = issue?.path.join(".") ?? "unknown";
		throw new Error(`native manifest validation failed at '${field}'`);
	}
	const projectedName = toSpecName(pluginId);

	const declared = declaredSkillIds(manifest);
	const requestedSkillIds = options.skillIds ?? declared;
	const skillBundle = await loadChatGPTSkills({
		directory: join(sourceRoot, "skills"),
		pluginName: projectedName,
		skillIds: requestedSkillIds.length > 0 ? requestedSkillIds : undefined,
	});
	if (!options.skillIds) {
		for (const skillId of declared) {
			if (!skillBundle.skills.some((skill) => skill.name === skillId)) {
				throw new Error(
					`manifest skill '${skillId}' is missing from the ChatGPT package`
				);
			}
		}
	}

	const appConfigPath = join(sourceRoot, ".app.json");
	let appConfig: Uint8Array | undefined;
	if (existsSync(appConfigPath)) {
		const stat = lstatSync(appConfigPath);
		if (stat.isSymbolicLink() || !stat.isFile()) {
			throw new Error(
				".app.json must be a regular file inside the plugin directory"
			);
		}
		const realPath = realpathSync(appConfigPath);
		if (!isWithin(sourceRoot, realPath)) {
			throw new Error(".app.json resolves outside the plugin directory");
		}
		let appValue: PrimitiveJsonValue;
		try {
			appValue = primitiveJsonSchema.parse(
				JSON.parse(readFileSync(realPath, "utf8"))
			);
		} catch {
			throw new Error(".app.json must contain valid JSON");
		}
		assertNoCredentialMaterial(appValue, ".app.json");
		appConfig = readFileSync(realPath);
	}

	const projected = toChatGPTPlugin(
		manifest,
		appConfig ? { appsConfigPath: "./.app.json" } : {}
	);
	if (!projected.mcp && skillBundle.skills.length === 0 && !appConfig) {
		throw new Error(
			"ChatGPT package has no declared MCP servers, skills, or app mappings"
		);
	}

	const outputParent = join(sourceRoot, "dist");
	const outputParentStat = lstatIfExists(outputParent);
	if (
		outputParentStat?.isSymbolicLink() ||
		(outputParentStat && !outputParentStat.isDirectory())
	) {
		throw new Error("dist must be a real directory inside the plugin source");
	}
	mkdirSync(outputParent, { recursive: true });
	const realOutputParent = realpathSync(outputParent);
	if (!isWithin(sourceRoot, realOutputParent)) {
		throw new Error("dist resolves outside the plugin directory");
	}

	const outputDirectory = join(realOutputParent, CHATGPT_PACKAGE_DIR);
	const outputStat = lstatIfExists(outputDirectory);
	if (
		outputStat?.isSymbolicLink() ||
		(outputStat && !outputStat.isDirectory())
	) {
		throw new Error(
			"ChatGPT package output must be a regular directory, not a symlink"
		);
	}
	const markerPath = join(realOutputParent, CHATGPT_PACKAGE_MARKER);
	const markerStat = lstatIfExists(markerPath);
	if (markerStat?.isSymbolicLink() || (markerStat && !markerStat.isFile())) {
		throw new Error("ChatGPT package marker must be a regular file");
	}
	if (outputStat && !options.force) {
		validateMarker(markerPath, pluginId);
		if (!markerStat) {
			throw new Error(
				"ChatGPT output already exists and is unmanaged; use --force to replace it"
			);
		}
	}

	const stageDirectory = mkdtempSync(
		join(realOutputParent, ".chatgpt-plugin-stage-")
	);
	if (!isWithin(realOutputParent, realpathSync(stageDirectory))) {
		throw new Error("temporary ChatGPT output escaped dist");
	}
	let backupDirectory: string | undefined;
	let installedOutput = false;
	const previousMarker = markerStat
		? readFileSync(markerPath, "utf8")
		: undefined;
	try {
		writeBundleFiles(
			stageDirectory,
			projected.plugin,
			projected.mcp,
			appConfig,
			skillBundle
		);
		if (outputStat) {
			backupDirectory = join(
				realOutputParent,
				`.chatgpt-plugin-backup-${randomUUID()}`
			);
			renameSync(outputDirectory, backupDirectory);
		}
		renameSync(stageDirectory, outputDirectory);
		installedOutput = true;
		const marker: ChatGPTPackageMarker = { pluginId, version: 1 };
		writeFileSync(markerPath, `${JSON.stringify(marker)}\n`, "utf8");
		if (backupDirectory) {
			const backupStat = lstatIfExists(backupDirectory);
			if (
				backupStat?.isSymbolicLink() ||
				!isWithin(realOutputParent, resolve(backupDirectory))
			) {
				throw new Error("ChatGPT package backup escaped dist");
			}
			rmSync(backupDirectory, { recursive: true });
		}
	} catch (error) {
		if (installedOutput && existsSync(outputDirectory)) {
			const currentOutputStat = lstatIfExists(outputDirectory);
			if (currentOutputStat?.isSymbolicLink()) {
				throw new Error(
					"ChatGPT output changed to a symlink during package replacement"
				);
			}
			rmSync(outputDirectory, { recursive: true });
		}
		if (backupDirectory && existsSync(backupDirectory)) {
			renameSync(backupDirectory, outputDirectory);
		}
		if (previousMarker !== undefined) {
			writeFileSync(markerPath, previousMarker, "utf8");
		} else if (installedOutput && existsSync(markerPath)) {
			rmSync(markerPath);
		}
		if (existsSync(stageDirectory)) {
			rmSync(stageDirectory, { recursive: true });
		}
		throw error;
	}

	return {
		mcp: projected.mcp,
		notes: projected.notes,
		outputDirectory,
		plugin: projected.plugin,
		skills: skillBundle.skills.map((skill) => skill.name),
	};
}
