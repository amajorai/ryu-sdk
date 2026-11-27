#!/usr/bin/env bun

/**
 * `ryu` CLI — entry-point for the Ryu developer SDK command-line tool.
 *
 * Usage:
 *   bunx ryu pack <dir>
 *   bunx ryu validate <dir>
 *   bunx ryu install <bundle-or-dir> [--update] [--enable]
 *   bunx ryu github-publish <repository-or-package-url>
 *   bunx ryu publish <dir>  (legacy migration escape hatch)
 *   bunx ryu agent-plugin <dir>
 *   bunx ryu chatgpt-plugin <dir> [--skills <ids>] [--force]
 *   bunx ryu dev --studio [entry] [--port <n>] [--host <h>]
 *   bunx ryu build [entry] --target <node|docker|vercel|cloudflare|netlify>
 *   bunx ryu deploy <vercel|cloudflare|netlify|docker> [entry] [--prod]
 *
 * Commands:
 *   pack <dir>      Validate the manifest.json in <dir> and emit a publish-ready
 *                   Plugin bundle at <dir>/dist/plugin.bundle.json, plus the
 *                   Agent Plugins interop pair in <dir> itself.
 *                   Exits 0 on success; exits 1 with the failing field on error.
 *   validate <dir>  Check the manifest against the SDK schema AND the public
 *                   JSON Schema (https://ryuhq.com/schemas/plugin.json).
 *   install <bundle-or-dir>
 *                   Side-load a packed bundle into a Ryu node through the
 *                   authenticated POST /api/plugins/install-bundle.
 *   github-publish <url>
 *                   Submit a seller-owned GitHub repository/package URL to the
 *                   GitHub-backed marketplace bridge.
 *   publish <dir>   Deprecated server-artifact publishing; disabled by default.
 *   agent-plugin <dir>
 *                   Emit only the Agent Plugins v1 interop pair (plugin.json and,
 *                   when servers exist, mcp.json) derived from the manifest.json.
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
	AGENT_PLUGIN_MANIFEST_FILE,
	AGENT_PLUGIN_MCP_FILE,
	isAgentPluginManifest,
	toAgentPlugin,
} from "./agent-plugin.ts";
import { commandBuild } from "./cli/build.ts";
import {
	CODE_FILE_DIRS,
	codeFileProvidersSchema,
	isValidCodeFilePath,
} from "./cli/code-file-contracts.ts";
import { commandDeploy } from "./cli/deploy.ts";
import { commandDev } from "./cli/dev.ts";
import { installBundle, resolveBundlePath } from "./cli/install.ts";
import { commandStudio } from "./cli/studio.ts";
import { validateManifestValue } from "./cli/validate.ts";
import { PluginManifestSchema, validateManifestStrict } from "./manifest.ts";
import { appToolJsonObjectSchema } from "./runnable/app.ts";

// Lower-case hex `sha256(utf8_bytes(code))`. This is the EXACT encoding Core
// recomputes on install (`hex::encode(Sha256::digest(utf8))`), so the hash written
// into the signed manifest verifies byte-for-byte on the Rust side. The `code`
// passed here MUST be the same UTF-8 string stored/served/fetched, so the two ends
// hash identical bytes (never re-minify between pack/publish and install).
function uiCodeSha256(code: string): string {
	return createHash("sha256").update(code, "utf8").digest("hex");
}

// ── helpers ───────────────────────────────────────────────────────────────────

function printUsage(): void {
	process.stderr.write(
		[
			"Ryu dev SDK",
			"",
			"Usage:",
			"  bunx ryu pack <dir>      Validate and bundle a manifest.json Plugin",
			"  bunx ryu validate <dir>  Check manifest.json against the SDK and public JSON schemas",
			"  bunx ryu install <bundle-or-dir> [--update] [--enable]",
			"                           Side-load dist/plugin.bundle.json into a Ryu node",
			"  bunx ryu github-publish <url>",
			"                           Submit a GitHub repository/package URL to the Marketplace",
			"  bunx ryu publish <dir>   Deprecated server-artifact publishing (migration only)",
			"  bunx ryu dev <entry>     Chat locally with an entry that exports run(messages, model)",
			"  bunx ryu dev --studio [entry] [--port <n>]",
			"                           Serve agents/workflows/tools with the browser studio",
			"  bunx ryu build [entry] --target <node|docker|vercel|cloudflare|netlify>",
			"                           Bundle a project into deployable artifacts (.ryu/build/<target>)",
			"  bunx ryu deploy <vercel|cloudflare|netlify|docker> [entry] [--prod]",
			"                           Build, then run the vendor CLI (it owns your login)",
			"  bunx ryu agent-plugin <dir>",
			"                           Emit the Agent Plugins v1 interop pair (plugin.json + mcp.json)",
			"  bunx ryu chatgpt-plugin <dir> [--skills <ids>] [--force]",
			"                           Package plugin-declared MCP servers and skills for ChatGPT",
			"",
		].join("\n")
	);
}

function exitError(message: string): never {
	writeSync(process.stderr.fd, `error: ${message}\n`);
	process.exit(1);
}

// ── shared manifest loading ─────────────────────────────────────────────────

type LoadedManifest = ReturnType<typeof PluginManifestSchema.parse>;

// Manifest file names, in preference order — mirrors Core's resolver
// (`plugin_manifest::MANIFEST_FILE_NAMES`). `manifest.json` is canonical; the
// legacy `plugin.json` / `ryu.json` are still accepted so an author's existing
// project directory keeps packing without a rename.
const MANIFEST_FILE_NAMES = [
	"manifest.json",
	"plugin.json",
	"ryu.json",
] as const;

// Resolve the NATIVE manifest path in `dir`, skipping an exported Agent Plugins
// `plugin.json`. Since `ryu pack` now writes a spec `plugin.json` into the plugin
// root, and `plugin.json` is also a legacy alias for our own manifest, a plain
// first-match would resolve to the spec file in any directory that has no
// `manifest.json` — and then fail validation for missing `id`. The `$schema`
// discriminator separates them (see `isAgentPluginManifest`).
function resolveNativeManifestPath(dir: string): string | undefined {
	return MANIFEST_FILE_NAMES.map((name) => join(dir, name)).find(
		(candidate) => {
			if (!existsSync(candidate)) {
				return false;
			}
			try {
				return !isAgentPluginManifest(
					JSON.parse(readFileSync(candidate, "utf8"))
				);
			} catch {
				// Unparseable: let the caller surface the JSON error against this path.
				return true;
			}
		}
	);
}

// Read + parse + validate the manifest in `dir`. Exits with the failing
// field on any error. Shared by pack and publish so both validate identically.
function loadManifest(dir: string): LoadedManifest {
	const manifestPath = resolveNativeManifestPath(dir);
	if (!manifestPath) {
		exitError(`manifest.json not found in: ${dir}`);
	}

	let raw: string;
	try {
		raw = readFileSync(manifestPath, "utf8");
	} catch (err) {
		exitError(`could not read ${manifestPath}: ${String(err)}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		exitError(`manifest.json is not valid JSON: ${manifestPath}`);
	}

	const result = PluginManifestSchema.safeParse(parsed);
	if (!result.success) {
		const first = result.error.issues[0];
		const field = first?.path.join(".") ?? "unknown";
		const message = first?.message ?? "validation failed";
		exitError(`manifest.json validation failed at '${field}': ${message}`);
	}
	const manifest = inlineOutputStyleFiles(
		inlineCodeFiles(result.data, dir),
		dir
	);
	validateWithCore(manifest);
	return manifest;
}

/**
 * Run Core's own manifest validator over the WIRE form (code files inlined).
 *
 * The zod schema models only the authoring shape, so without this a manifest Core
 * refuses at install — e.g. an adapter whose `tool` or `adapter.tools` names a
 * tool this plugin does not own — would still pack and publish, and the author
 * would first learn of it from a failed install. Validating the inlined form is
 * also what proves every `code_file` became a non-empty `code` body.
 */
function validateWithCore(manifest: LoadedManifest): void {
	try {
		validateManifestStrict(JSON.stringify(manifest));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		exitError(`manifest.json failed Core validation: ${message}`);
	}
}

function containedPackageFile(dir: string, rel: string, label: string): string {
	let realRoot: string;
	let realTarget: string;
	try {
		realRoot = realpathSync(dir);
		realTarget = realpathSync(join(dir, rel));
	} catch (error) {
		exitError(`${label}: could not resolve '${rel}': ${String(error)}`);
	}
	const fromRoot = relative(realRoot, realTarget);
	if (
		fromRoot === ".." ||
		fromRoot.startsWith(`..${sep}`) ||
		isAbsolute(fromRoot)
	) {
		exitError(
			`${label}: '${rel}' resolves outside the plugin package (${realTarget})`
		);
	}
	return realTarget;
}

/**
 * Read one `code_file` and return its contents, or exit with a clear error.
 *
 * The path is joined onto the plugin directory, so it is validated against the
 * same flat allowlist Core enforces (`<hooks|adapters>/<name>.js`, no traversal)
 * rather than trusted.
 */
function readCodeFile(dir: string, rel: string, label: string): string {
	if (!isValidCodeFilePath(rel)) {
		exitError(
			`${label}: code_file '${rel}' must be exactly '<${CODE_FILE_DIRS.join("|")}>/<name>.js' with no traversal`
		);
	}
	const path = containedPackageFile(dir, rel, label);
	let body: string;
	try {
		body = readFileSync(path, "utf8");
	} catch (err) {
		exitError(`${label}: could not read code_file '${rel}': ${String(err)}`);
	}
	if (!body.trim()) {
		exitError(`${label}: code_file '${rel}' is empty`);
	}
	return body;
}

/**
 * Replace every `code_file` reference with the file's contents — the source form
 * becoming the wire form.
 *
 * `code_file` exists so a plugin's sandboxed JS lives in real, reviewable `.js`
 * files instead of a one-line escaped JSON string. But the BUNDLE must stay
 * self-contained and, for a marketplace plugin, the Gateway signs the manifest
 * verbatim — so inlining here is what keeps the entire hook/adapter body inside the
 * signed surface. A published bundle that still carried `code_file` would be a new
 * unsigned-code carriage channel, which is exactly what this must not become.
 */
function inlineCodeFiles(
	manifest: LoadedManifest,
	dir: string
): LoadedManifest {
	const out = manifest;

	for (const hook of out.contributes?.turn_hooks ?? []) {
		const rel = hook.code_file;
		if (rel !== undefined) {
			hook.code = readCodeFile(dir, rel, `turn hook '${String(hook.id)}'`);
			hook.code_file = undefined;
		}
	}

	for (const entry of codeFileProvidersSchema.parse(out.provides ?? [])) {
		for (const [verb, binding] of Object.entries(entry.tools ?? {})) {
			const rel = binding.adapter?.code_file;
			if (binding.adapter && rel !== undefined && rel !== null) {
				binding.adapter.code = readCodeFile(dir, rel, `adapter '${verb}'`);
				binding.adapter.code_file = undefined;
			}
		}
	}

	return out;
}

/**
 * Largest output-style file `pack` will inline, in bytes — mirrors Rust's
 * `MAX_OUTPUT_STYLE_BYTES`. Enforced here and not left to Core because the two
 * bound different moments: Core rejects an oversized style at install, by which
 * point the author has already signed and published a bundle nobody can install.
 */
const MAX_OUTPUT_STYLE_BYTES = 64 * 1024;

/** The one directory an `output_styles[].file` may name — mirrors Rust's `OUTPUT_STYLE_DIR`. */
const OUTPUT_STYLE_DIR = "output-styles";
/**
 * Mirrors `validate_output_style_path` CHARACTER FOR CHARACTER, like
 * `isValidCodeFilePath` in `cli/code-file-contracts.ts` does for its Rust twin. The
 * two allowlists must accept the same set or `pack` signs a bundle Core rejects at
 * install — the same after-the-fact failure the byte cap below exists to prevent.
 * Hence the leading class excludes `.` but keeps `-` (Rust rejects only a leading
 * dot), and `..` is checked separately rather than folded in, because a dot is
 * legal mid-name and only the doubled form is traversal.
 */
const OUTPUT_STYLE_PATH = /^output-styles\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.md$/;

/**
 * Replace every `output_styles[].file` with the file's contents — the same source
 * form → wire form move `inlineCodeFiles` makes, for the same signing reason.
 *
 * A separate function with a separate allowlist rather than a parameterised version
 * of `readCodeFile`, mirroring why Rust keeps `CODE_FILE_DIRS`, `PI_EXTENSION_DIR`
 * and `OUTPUT_STYLE_DIR` as three constants instead of one: the allowlists ARE the
 * gate, and a merged one is a single edit away from letting a style name a
 * `hooks/*.js`, or a turn hook name a `.md` that nothing sandboxes.
 *
 * The inlined `source` carries the file VERBATIM, frontmatter included — Core's
 * single `parse_output_style_md` reads a plugin style and a user's own
 * `output-styles/*.md` the same way, and mirroring `name`/`description` up into
 * manifest keys would create a second place a style's metadata could disagree with
 * itself.
 */
function inlineOutputStyleFiles(
	manifest: LoadedManifest,
	dir: string
): LoadedManifest {
	const out = manifest;

	for (const style of out.contributes?.output_styles ?? []) {
		const rel = style.file;
		if (rel === undefined) {
			continue;
		}
		const label = `output style '${String(style.id)}'`;
		if (!OUTPUT_STYLE_PATH.test(rel) || rel.includes("..")) {
			exitError(
				`${label}: file '${rel}' must be exactly '${OUTPUT_STYLE_DIR}/<name>.md' with no traversal`
			);
		}
		let body: string;
		try {
			body = readFileSync(containedPackageFile(dir, rel, label), "utf8");
		} catch (err) {
			exitError(`${label}: could not read file '${rel}': ${String(err)}`);
		}
		if (!body.trim()) {
			exitError(`${label}: file '${rel}' is empty`);
		}
		const bytes = Buffer.byteLength(body, "utf8");
		if (bytes > MAX_OUTPUT_STYLE_BYTES) {
			exitError(
				`${label}: file '${rel}' is ${bytes} bytes, over the ${MAX_OUTPUT_STYLE_BYTES}-byte limit`
			);
		}
		style.source = body;
		style.file = undefined;
	}

	return out;
}

// ── pack command ──────────────────────────────────────────────────────────────

// Resolve the plugin's sandboxed-UI entry module — the source `ryu pack` bundles
// into `ui_code`. Two authoring shapes carry one:
//   1. A `companion` runnable's `config.ui_entry` (companion surface plugins).
//   2. A Ryu App's `contributes.widgets[].ui_entry` (widget apps via `defineApp`).
// Companion runnables take precedence; the first non-empty entry wins. Returns
// null for a manifest-only plugin (no bundled UI) so packing stays
// backward-compatible in that case.
function resolveUiEntry(manifest: LoadedManifest): string | null {
	for (const runnable of manifest.runnables) {
		if (runnable.kind !== "companion") {
			continue;
		}
		const parsedEntry = z.string().safeParse(runnable.config?.ui_entry);
		const entry = parsedEntry.success ? parsedEntry.data : undefined;
		if (entry !== undefined && entry.trim().length > 0) {
			return entry;
		}
	}
	for (const widget of manifest.contributes?.widgets ?? []) {
		const entry = widget.ui_entry;
		if (entry !== undefined && entry.trim().length > 0) {
			return entry;
		}
	}
	return null;
}

// Resolve a UI entry's format. `"html"` means the `ui_entry` file is ALREADY a
// self-contained HTML document (a vite-plugin-singlefile build for a heavy
// companion, or a hand-authored widget) and must be shipped VERBATIM as
// `ui_code` — NOT run through `Bun.build`, which would try to bundle an HTML
// file as an ESM entry and fail. Anything else (absent / `"js"`) is the default:
// `ui_entry` is an ESM module `Bun.build` bundles into `ui_code`.
function resolveUiFormat(manifest: LoadedManifest): "html" | "js" {
	for (const runnable of manifest.runnables) {
		if (runnable.kind !== "companion") {
			continue;
		}
		const fmt = z.string().safeParse(runnable.config?.ui_format);
		if (fmt.success && fmt.data.trim().toLowerCase() === "html") {
			return "html";
		}
	}
	for (const widget of manifest.contributes?.widgets ?? []) {
		const entry = widget.ui_entry;
		if (entry?.trim().toLowerCase().endsWith(".html")) {
			return "html";
		}
	}
	return "js";
}

// Read a Path B (`ui_format:"html"`) companion's prebuilt HTML entry verbatim. The
// file is the finished, self-contained document (CSS/JS/fonts already inlined by
// the singlefile bundler); `ryu pack` ships it as `ui_code` untouched so its
// sha256 matches byte-for-byte on install.
function readUiEntryHtml(dir: string, uiEntry: string): string {
	const entryPath = resolve(dir, uiEntry);
	if (!existsSync(entryPath)) {
		exitError(`companion ui_entry (html) not found: ${entryPath}`);
	}
	return readFileSync(entryPath, "utf8");
}

// Bundle the plugin's UI entry into ONE self-contained browser ESM module string.
// No external imports are emitted: the `RyuPlugin` API is INJECTED at runtime by
// the host bootstrap (the plugin calls `activate(context)`), not imported, so the
// bundle carries only the plugin's own code. Throws on a build error so `pack`
// fails loudly rather than emitting a half-built bundle.
async function bundleUiEntry(dir: string, uiEntry: string): Promise<string> {
	const entryPath = resolve(dir, uiEntry);
	if (!existsSync(entryPath)) {
		exitError(`companion ui_entry not found: ${entryPath}`);
	}
	const result = await Bun.build({
		entrypoints: [entryPath],
		target: "browser",
		format: "esm",
		minify: false,
	});
	if (!result.success) {
		const messages = result.logs.map((l) => String(l.message)).join("; ");
		exitError(`failed to bundle ui_entry '${uiEntry}': ${messages}`);
	}
	const output = result.outputs[0];
	if (!output) {
		exitError(`bundling ui_entry '${uiEntry}' produced no output`);
	}
	return await output.text();
}

// ── Agent Plugins interop pair ───────────────────────────────────────────────
//
// Written into the plugin ROOT, not `dist/`, because the spec addresses a plugin
// as a directory: `plugin.json` at the root next to `skills/` and `mcp.json`
// (§4.2). Emitting into `dist/` would produce a manifest with no skills beside it.
//
// `manifest.json` remains the source of truth — the pair is derived on every pack,
// so it cannot drift. A stale `mcp.json` from a previous pack is removed when the
// manifest no longer declares a server, so an old file can never keep advertising
// a server we dropped.
// Reads the manifest RAW rather than taking the validated `LoadedManifest`: the
// SDK's zod schema models the narrower authoring shape and strips the fields Core
// adds — including `mcp_servers`, which is exactly what `mcp.json` is derived
// from. Projecting from the stripped object would silently emit a plugin with no
// MCP servers.
function emitAgentPlugin(dir: string): void {
	const manifestPath = resolveNativeManifestPath(dir);
	if (!manifestPath) {
		exitError(`manifest.json not found in: ${dir}`);
	}
	let manifest: z.output<typeof appToolJsonObjectSchema>;
	try {
		manifest = appToolJsonObjectSchema.parse(
			JSON.parse(readFileSync(manifestPath, "utf8"))
		);
	} catch (err) {
		exitError(`could not read ${manifestPath}: ${String(err)}`);
	}

	let plugin: ReturnType<typeof toAgentPlugin>["plugin"];
	let mcp: ReturnType<typeof toAgentPlugin>["mcp"];
	let notes: string[];
	try {
		({ plugin, mcp, notes } = toAgentPlugin(manifest));
	} catch (err) {
		exitError(`could not derive ${AGENT_PLUGIN_MANIFEST_FILE}: ${String(err)}`);
	}

	const pluginPath = join(dir, AGENT_PLUGIN_MANIFEST_FILE);
	writeFileSync(pluginPath, `${JSON.stringify(plugin, null, 2)}\n`, "utf8");

	const mcpPath = join(dir, AGENT_PLUGIN_MCP_FILE);
	if (mcp) {
		writeFileSync(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`, "utf8");
	} else if (existsSync(mcpPath)) {
		rmSync(mcpPath);
	}

	const emitted = mcp
		? `${AGENT_PLUGIN_MANIFEST_FILE} + ${AGENT_PLUGIN_MCP_FILE}`
		: AGENT_PLUGIN_MANIFEST_FILE;
	process.stdout.write(`agent-plugin: ${emitted} → ${dir}\n`);
	for (const note of notes) {
		process.stdout.write(`agent-plugin: note: ${note}\n`);
	}
}

function commandAgentPlugin(rawDir: string): void {
	const dir = resolve(rawDir);
	// Validate through the normal path first, so `agent-plugin` never emits an
	// interop pair for a manifest `pack`/`publish` would reject.
	loadManifest(dir);
	emitAgentPlugin(dir);
}

function printChatGPTPluginUsage(): void {
	process.stdout.write(
		`${[
			"Usage: bunx ryu chatgpt-plugin <dir> [--skills <ids>] [--force]",
			"",
			"Options:",
			"  --skills <ids>  Comma-separated skill folder slugs to include (maximum 5)",
			"  --force         Replace an unmanaged dist/chatgpt-plugin output directory",
			"",
			"Examples:",
			"  bunx ryu chatgpt-plugin ./my-extension",
			"  bunx ryu chatgpt-plugin ./my-extension --skills research,calendar",
			"  bunx ryu chatgpt-plugin ./my-extension --force",
		].join("\n")}\n`
	);
}

async function commandChatGPTPlugin(args: string[]): Promise<void> {
	if (args[0] === "--help" || args[0] === "-h") {
		printChatGPTPluginUsage();
		return;
	}
	const rawDir = args[0];
	if (!rawDir || rawDir.startsWith("--")) {
		exitError(
			"chatgpt-plugin requires a plugin directory; run `bunx ryu chatgpt-plugin --help`"
		);
	}
	let force = false;
	let skillIds: string[] | undefined;
	for (let index = 1; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--force") {
			force = true;
			continue;
		}
		if (argument === "--skills") {
			const rawSkills = args[index + 1];
			if (!rawSkills || rawSkills.startsWith("--")) {
				exitError(
					"--skills needs a comma-separated list of skill folder slugs"
				);
			}
			skillIds = rawSkills.split(",").map((skillId) => skillId.trim());
			if (skillIds.some((skillId) => !skillId)) {
				exitError("--skills contains an empty skill id");
			}
			index += 1;
			continue;
		}
		exitError(
			`unknown chatgpt-plugin option '${argument}'; run bunx ryu chatgpt-plugin --help`
		);
	}

	const directory = resolve(rawDir);
	loadManifest(directory);
	const { packChatGPTPlugin } = await import("./chatgpt/package.ts");
	const packOptions: Parameters<typeof packChatGPTPlugin>[0] = {
		directory,
		force,
	};
	if (skillIds) {
		packOptions.skillIds = skillIds;
	}
	const result = await packChatGPTPlugin(packOptions);
	process.stdout.write(
		`chatgpt-plugin: package written to ${result.outputDirectory}\n`
	);
	process.stdout.write(
		`chatgpt-plugin: ${result.skills.length} bundled skill(s)\n`
	);
	process.stdout.write(
		`chatgpt-plugin: ${Object.keys(result.mcp?.mcpServers ?? {}).length} MCP server(s)\n`
	);
	for (const note of result.notes) {
		process.stdout.write(`chatgpt-plugin: note: ${note}\n`);
	}
}

async function commandPack(rawDir: string): Promise<void> {
	const dir = resolve(rawDir);
	const manifest = loadManifest(dir);

	// Bundle the companion UI entry, if any. Manifest-only plugins skip this and
	// emit exactly the previous shape (no `ui_code`). A `ui_format:"html"` companion
	// (Path B) ships its prebuilt HTML verbatim; otherwise the ESM entry is bundled.
	const uiEntry = resolveUiEntry(manifest);
	const uiCode = uiEntry
		? resolveUiFormat(manifest) === "html"
			? readUiEntryHtml(dir, uiEntry)
			: await bundleUiEntry(dir, uiEntry)
		: null;

	// Bind the bundled code to the manifest by its sha256. The hash goes INTO the
	// manifest (the surface Core signs on publish, and the corruption self-check on
	// local install-bundle reads); the `ui_code` blob rides alongside as payload.
	const manifestWithHash = uiCode
		? { ...manifest, ui_code_sha256: uiCodeSha256(uiCode) }
		: manifest;

	// Emit bundle into <dir>/dist/plugin.bundle.json
	const outDir = join(dir, "dist");
	if (!existsSync(outDir)) {
		mkdirSync(outDir, { recursive: true });
	}
	const outPath = join(outDir, "plugin.bundle.json");
	const bundle = uiCode
		? { ...manifestWithHash, ui_code: uiCode }
		: manifestWithHash;
	writeFileSync(outPath, JSON.stringify(bundle, null, 2), "utf8");

	// Re-derive the Agent Plugins interop pair on every pack so a published plugin
	// directory is also a conformant Agent Plugin and the two can never drift.
	emitAgentPlugin(dir);

	const codeNote = uiCode ? ` (+${uiCode.length}B ui_code)` : "";
	process.stdout.write(
		`packed ${manifest.id}@${manifest.version}${codeNote} → ${outPath}\n`
	);
}

// ── publish command ─────────────────────────────────────────────────────────

const TRAILING_SLASHES = /\/+$/;

// The hosted Ryu Marketplace API — the same default Core's catalog client uses.
// A self-hosted or local control plane overrides it with RYU_MARKETPLACE_API_URL,
// or with RYU_API_URL, the name @ryuhq/services and ryu-services use for the same
// control-plane origin.
const DEFAULT_MARKETPLACE_API_URL = "https://api.ryuhq.com";

// Resolve the publish base URL: RYU_MARKETPLACE_API_URL, then RYU_API_URL, else
// the hosted Marketplace API. Blank values count as unset.
function publishBaseUrl(): string {
	const raw =
		(process.env.RYU_MARKETPLACE_API_URL ?? "").trim() ||
		(process.env.RYU_API_URL ?? "").trim();
	return (raw || DEFAULT_MARKETPLACE_API_URL).replace(TRAILING_SLASHES, "");
}

// Resolve the author's auth token: env (RYU_AUTH_TOKEN), sent as a Bearer token.
// The Marketplace write routes accept only a signed-in Ryu account session (the
// bearer the desktop/web app holds after sign-in); API keys and third-party OAuth
// tokens are refused there by design. Never read from a committed file.
function authToken(): string {
	const token = (process.env.RYU_AUTH_TOKEN ?? "").trim();
	if (!token) {
		exitError(
			"publishing needs your signed-in Ryu account session: set RYU_AUTH_TOKEN to its bearer token, or submit the URL from Marketplace → Publish in the Ryu app instead"
		);
	}
	return token;
}

// An SDK-authored Plugin always publishes as a `plugin` (a manifest.json bundle of
// runnables). It is deliberately NOT published as `skill`: Core's skill install
// path needs a `descriptor.raw.install_source` (a from-source owner/repo), which
// a manifest.json manifest does not carry, so a skill-kind publish would be
// uninstallable. Model / mcp items are published through their own tools.
const SDK_PUBLISH_KIND = "plugin" as const;

/** Leading `x.y.z`, then the prerelease identifiers, then build metadata. */
const VERSION_PATTERN =
	/^v?\d+(?:\.\d+){0,2}(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * The release channel a version publishes to: its first prerelease identifier
 * lowercased, else `stable`.
 *
 * Mirrors the control plane's `deriveChannel` and Core's `channel_of` — the rule
 * is that a version is self-describing, so this can only ever REPORT what the
 * server will decide, never influence it. Anything unparseable reads as `stable`
 * here; the server is the one that refuses it.
 */
function channelOfVersion(version: string): string {
	const first = VERSION_PATTERN.exec(version.trim())?.[1]?.split(".")[0];
	return first ? first.toLowerCase() : "stable";
}

async function commandPublish(rawDir: string): Promise<void> {
	const dir = resolve(rawDir);
	const manifest = loadManifest(dir);
	const token = authToken();
	const kind = SDK_PUBLISH_KIND;

	// Compute the carriage payload the SAME way `pack` does — bundle the companion
	// UI entry and hash it INLINE (never depend on a possibly-stale dist/). The
	// hash is injected into the manifest object BEFORE it is sent for signing, so
	// the Gateway signs a manifest that already binds the code; the `ui_code` blob
	// is sent as a sibling (unsigned payload, integrity via the signed hash).
	const uiEntry = resolveUiEntry(manifest);
	const uiCode = uiEntry
		? resolveUiFormat(manifest) === "html"
			? readUiEntryHtml(dir, uiEntry)
			: await bundleUiEntry(dir, uiEntry)
		: null;
	const manifestWithHash = uiCode
		? { ...manifest, ui_code_sha256: uiCodeSha256(uiCode) }
		: manifest;

	// Phase 1.5 rich listing metadata forwarded FLAT into the publish body (not
	// inside the signed manifest blob) so the control plane stores + serves it on
	// detail. Each field is only sent when the author declared it. `developer`
	// resolves the Claude-style `author` (string or `{name}`); `website` maps from
	// the Claude `homepage`; the DISPLAY `runnables` array is derived from the
	// manifest's authored runnables (id/name/kind) with a default enabled state.
	const stringAuthor = z.string().safeParse(manifest.author);
	const developer = stringAuthor.success
		? stringAuthor.data
		: z.object({ name: z.string().optional() }).safeParse(manifest.author).data
				?.name;
	const runnablesForDisplay = manifest.runnables.map((r) => ({
		id: r.id,
		kind: r.kind,
		name: r.name,
		enabled: true,
	}));
	const listingMetadata: Partial<
		Pick<
			LoadedManifest,
			| "description"
			| "tagline"
			| "author"
			| "repository"
			| "category"
			| "license"
			| "keywords"
			| "iconUrl"
			| "icon"
			| "iconDither"
			| "banner"
			| "screenshots"
			| "privacyPolicyUrl"
			| "termsOfServiceUrl"
			| "capabilities"
			| "examplePrompts"
			| "setup"
			| "external"
		>
	> & {
		developer?: string;
		website?: string;
		runnables?: typeof runnablesForDisplay;
	} = {};
	if (manifest.description) {
		listingMetadata.description = manifest.description;
	}
	if (manifest.tagline) {
		listingMetadata.tagline = manifest.tagline;
	}
	if (manifest.author) {
		listingMetadata.author = manifest.author;
	}
	if (manifest.repository) {
		listingMetadata.repository = manifest.repository;
	}
	if (manifest.category) {
		listingMetadata.category = manifest.category;
	}
	if (manifest.license) {
		listingMetadata.license = manifest.license;
	}
	if (manifest.iconUrl) {
		listingMetadata.iconUrl = manifest.iconUrl;
	}
	if (manifest.icon) {
		listingMetadata.icon = manifest.icon;
	}
	if (manifest.iconDither) {
		listingMetadata.iconDither = manifest.iconDither;
	}
	if (manifest.banner) {
		listingMetadata.banner = manifest.banner;
	}
	if (manifest.privacyPolicyUrl) {
		listingMetadata.privacyPolicyUrl = manifest.privacyPolicyUrl;
	}
	if (manifest.termsOfServiceUrl) {
		listingMetadata.termsOfServiceUrl = manifest.termsOfServiceUrl;
	}
	if (manifest.setup) {
		listingMetadata.setup = manifest.setup;
	}
	if (manifest.keywords?.length) {
		listingMetadata.keywords = manifest.keywords;
	}
	if (manifest.screenshots?.length) {
		listingMetadata.screenshots = manifest.screenshots;
	}
	if (manifest.capabilities?.length) {
		listingMetadata.capabilities = manifest.capabilities;
	}
	if (manifest.examplePrompts?.length) {
		listingMetadata.examplePrompts = manifest.examplePrompts;
	}
	if (manifest.external) {
		listingMetadata.external = true;
	}
	if (developer) {
		listingMetadata.developer = developer;
	}
	if (manifest.homepage) {
		listingMetadata.website = manifest.homepage;
	}
	if (runnablesForDisplay.length) {
		listingMetadata.runnables = runnablesForDisplay;
	}

	const url = `${publishBaseUrl()}/api/marketplace/publish`;
	const body: {
		affiliate?: LoadedManifest["affiliate"];
		ui_code?: string;
	} & typeof listingMetadata & {
			id: string;
			kind: typeof kind;
			name: string;
			version: string;
			manifest: typeof manifestWithHash;
			descriptor: typeof manifestWithHash;
			grants: string[];
		} = {
		id: manifest.id,
		kind,
		name: manifest.name,
		version: manifest.version,
		manifest: manifestWithHash,
		// The descriptor is the manifest itself for a plugin/skill Plugin; Core maps
		// it on install. Grants are read from the manifest server-side too.
		descriptor: manifestWithHash,
		grants: manifest.permission_grants ?? [],
		// Rich listing metadata (Phase 1.5) forwarded flat; see above.
		...listingMetadata,
		// Per-item affiliate terms (optional): the commission a referrer earns when
		// a referred user buys this paid item. The server re-validates the rule and
		// stores it as the item's override (else the seller default applies).
		// The bundled UI code rides OUTSIDE the signed manifest as payload; the
		// server stores it and serves it on detail. Omitted for manifest-only.
	};

	if (manifest.affiliate?.enabled) {
		body.affiliate = manifest.affiliate;
	}
	if (uiCode) {
		body.ui_code = uiCode;
	}

	let resp: Response;
	try {
		resp = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(body),
		});
	} catch (err) {
		exitError(`could not reach ${url}: ${String(err)}`);
	}

	const text = await resp.text();
	if (!resp.ok) {
		exitError(`publish failed (${resp.status}): ${text}`);
	}
	// Name the release channel the version landed on. It is DERIVED from the
	// version (`1.5.0-beta.1` publishes to `beta`) and there is no flag to set it,
	// so an author who did not mean to cut a prerelease finds out here rather than
	// from a stable listing that never moved.
	const channel = channelOfVersion(manifest.version);
	const trainNote =
		channel === "stable"
			? ""
			: ` on the \`${channel}\` channel (a prerelease train — users must select it)`;
	process.stdout.write(
		`published ${manifest.id}@${manifest.version} (${kind})${trainNote} → pending moderation\n${text}\n`
	);
}

interface GithubPublishBody {
	installationProof?: string;
	url: string;
}

async function commandGithubPublish(repositoryUrl: string): Promise<void> {
	const input = repositoryUrl.trim();
	if (!input) {
		exitError(
			"github-publish requires a GitHub repository or package URL, for example https://github.com/acme/my-app"
		);
	}
	const token = authToken();
	const url = `${publishBaseUrl()}/api/marketplace/github/publish`;
	const proof = process.env.RYU_GITHUB_INSTALLATION_PROOF?.trim();
	const body: GithubPublishBody = { url: input };
	if (proof) {
		body.installationProof = proof;
	}
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		});
	} catch (error) {
		exitError(`could not reach ${url}: ${String(error)}`);
	}
	const text = await response.text();
	if (response.status === 401) {
		exitError(
			"github-publish was not authorized (401): RYU_AUTH_TOKEN must be a current Ryu account session token, not an API key"
		);
	}
	if (!response.ok) {
		try {
			const error = z
				.object({
					code: z.string().optional(),
					installationUrl: z.string().optional(),
					error: z.string().optional(),
					preflight: z
						.object({
							checks: z
								.array(
									z.object({
										detail: z.string().optional(),
										label: z.string().optional(),
										status: z.string().optional(),
									})
								)
								.optional(),
							grade: z.string().nullish(),
							score: z.number().nullish(),
						})
						.optional(),
				})
				.parse(JSON.parse(text));

			if (error.installationUrl) {
				exitError(
					`${error.error ?? "GitHub App installation required"}. Open ${error.installationUrl}, then set RYU_GITHUB_INSTALLATION_PROOF to the callback proof and retry.`
				);
			}
			const preflight = error.preflight;
			if (preflight) {
				const findings = (preflight.checks ?? [])
					.filter((check) => check.status !== "pass")
					.map(
						(check) =>
							`  - ${check.label ?? "Check"}: ${check.detail ?? check.status ?? "failed"}`
					)
					.join("\n");
				exitError(
					[
						`github-publish failed (${response.status}): ${error.error ?? text}`,
						`Preflight: Grade ${preflight.grade ?? "unavailable"} (${preflight.score ?? "—"}/100). Only Grade A packages enter Ryu's admin review queue.`,
						findings,
					]
						.filter(Boolean)
						.join("\n")
				);
			}
			exitError(
				`github-publish failed (${response.status}): ${error.error ?? text}`
			);
		} catch {
			exitError(`github-publish failed (${response.status}): ${text}`);
		}
	}
	process.stdout.write(
		`GitHub-backed listing submitted for moderation:\n${text}\n`
	);
}

// ── validate / install commands ─────────────────────────────────────────────

function commandValidate(rawDir: string): void {
	const dir = resolve(rawDir);
	const manifestPath = resolveNativeManifestPath(dir);
	if (!manifestPath) {
		exitError(`manifest.json not found in: ${dir}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch (err) {
		exitError(`${manifestPath} is not valid JSON: ${String(err)}`);
	}
	const findings = validateManifestValue(parsed);
	if (findings.length > 0) {
		for (const finding of findings) {
			writeSync(
				process.stderr.fd,
				`  [${finding.source}] ${finding.message}\n`
			);
		}
		exitError(
			`${manifestPath} failed validation (${findings.length} issue(s))`
		);
	}
	process.stdout.write(`valid: ${manifestPath}\n`);
}

async function commandInstall(installArgs: string[]): Promise<void> {
	let input: string | undefined;
	let update = false;
	let enable = false;
	for (const argument of installArgs) {
		if (argument === "--update") {
			update = true;
		} else if (argument === "--enable") {
			enable = true;
		} else if (argument.startsWith("-")) {
			exitError(`unknown install option '${argument}'`);
		} else if (input === undefined) {
			input = argument;
		} else {
			exitError("install takes exactly one bundle file or project directory");
		}
	}
	if (!input) {
		exitError(
			"install requires a bundle or project directory: bunx ryu install <bundle-or-dir> [--update] [--enable]"
		);
	}
	const outcome = await installBundle({
		bundlePath: resolveBundlePath(input),
		enable,
		update,
	});
	const version = outcome.version ? `@${outcome.version}` : "";
	process.stdout.write(
		outcome.enabled
			? `installed and enabled ${outcome.id}${version}\n`
			: `installed ${outcome.id}${version} (disabled; enable it in Ryu or re-run with --enable)\n`
	);
}

// ── main ──────────────────────────────────────────────────────────────────────

const [, , command, ...args] = process.argv;

if (!command) {
	printUsage();
	process.exit(1);
}

if (command === "pack") {
	const dir = args[0];
	if (!dir) {
		exitError("pack requires a directory argument: bunx ryu pack <dir>");
	}
	commandPack(dir).catch((err) => {
		exitError(String(err));
	});
} else if (command === "publish") {
	const dir = args[0];
	if (!dir) {
		exitError("publish requires a directory argument: bunx ryu publish <dir>");
	}
	if (process.env.RYU_ENABLE_LEGACY_MARKETPLACE_WRITES !== "true") {
		exitError(
			"ryu publish is deprecated because marketplace package contents now live in GitHub Releases; use bunx ryu github-publish <repository-or-package-url>"
		);
	}
	commandPublish(dir).catch((err) => {
		exitError(String(err));
	});
} else if (command === "github-publish") {
	const repositoryUrl = args[0];
	if (!repositoryUrl) {
		exitError(
			"github-publish requires a GitHub repository or package URL, for example https://github.com/acme/my-app"
		);
	}
	commandGithubPublish(repositoryUrl).catch((err) => {
		exitError(String(err));
	});
} else if (command === "validate") {
	const dir = args[0];
	if (!dir) {
		exitError(
			"validate requires a directory argument: bunx ryu validate <dir>"
		);
	}
	commandValidate(dir);
} else if (command === "install") {
	commandInstall(args).catch((err) => {
		exitError(err instanceof Error ? err.message : String(err));
	});
} else if (command === "package") {
	exitError(
		"`package` (portable .ryupack packages) is a command of the Ryu terminal client, not the SDK: run `ryu-cli package <validate|inspect|pack|...>`"
	);
} else if (command === "agent-plugin") {
	const dir = args[0];
	if (!dir) {
		exitError(
			"agent-plugin requires a directory argument: bunx ryu agent-plugin <dir>"
		);
	}
	commandAgentPlugin(dir);
} else if (command === "chatgpt-plugin") {
	commandChatGPTPlugin(args).catch((err) => {
		exitError(String(err));
	});
} else if (command === "dev" && args.includes("--studio")) {
	commandStudio(args).catch((err) => {
		exitError(err instanceof Error ? err.message : String(err));
	});
} else if (command === "build") {
	commandBuild(args).catch((err) => {
		exitError(err instanceof Error ? err.message : String(err));
	});
} else if (command === "deploy") {
	commandDeploy(args)
		.then((code) => {
			process.exitCode = code;
		})
		.catch((err) => {
			exitError(err instanceof Error ? err.message : String(err));
		});
} else if (command === "dev") {
	const entry = args[0];
	if (!entry) {
		exitError("dev requires an entry argument: bunx ryu dev <entry>");
	}
	commandDev(entry).catch((err) => {
		exitError(String(err));
	});
} else {
	printUsage();
	exitError(`unknown command: ${command}`);
}
