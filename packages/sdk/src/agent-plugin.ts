/**
 * Agent Plugins v1.0.0 export — the interop face of a Ryu `manifest.json`.
 *
 * The Agent Plugins Specification (https://agent-plugins.org/, TSC: Amazon,
 * Cursor, Microsoft, OpenAI, Vercel) defines a small portable floor: a plugin is
 * a directory with `plugin.json`, Agent Skills under `skills/<slug>/SKILL.md`,
 * and MCP servers in `mcp.json`. Native stdio, Streamable HTTP, and legacy SSE
 * servers all have a direct portable representation; richer Ryu-only fields stay
 * in the extension namespace or are reported as notes.
 *
 * ## Why this is a SECOND file, not a migration
 *
 * The spec manifest schema is **closed** (§5.2): the only permitted top-level
 * fields are `$schema`, `name`, `version`, `description`, `author`, `homepage`,
 * `repository`, `license`, `keywords`, and `extensions`. Every field that makes a
 * Ryu manifest a Ryu manifest — `id`, `runnables`, `contributes`, `surfaces`,
 * `engines`, `permission_grants`, `mcp_servers`, `companion`, `ui_code_sha256` —
 * is an unknown field there. So `manifest.json` can never *be* a conformant
 * `plugin.json`; it can only be projected into one.
 *
 * `manifest.json` therefore stays the single source of truth and this module
 * DERIVES the interop pair (`plugin.json` + `mcp.json`) from it. Nothing is
 * hand-maintained, so the pair cannot desync — the same reason the packaged
 * manifests are compiled in from their package home instead of copied (AGENTS.md).
 *
 * For the same reason `extensions` carries only what cannot be re-derived by a
 * reader of the spec files: the real scoped id, the display name, and the
 * per-server MCP fields the spec's closed server variants forced us to strip. It
 * is deliberately NOT a copy of the whole native manifest — that would be a second
 * source of truth with a stale-copy failure mode.
 *
 * Both `plugins-store/{plugins,lsp,external_plugins}/*` and `apps-store/*` use this one `PluginManifest` shape, so
 * one converter covers both stores.
 */

/** Agent Plugins spec version this module targets. */
export const AGENT_PLUGINS_SPEC_VERSION = "1.0.0";

/**
 * Canonical manifest schema identifier (§5.2). MUST be this exact string — a
 * client selects its validation rules from the value and MUST NOT fetch it.
 */
export const AGENT_PLUGIN_SCHEMA_URL =
	"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

/** Canonical `mcp.json` schema identifier (§7.2.1). */
export const AGENT_PLUGIN_MCP_SCHEMA_URL =
	"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

/**
 * Our reverse-domain client extension namespace (§8) — the key in `extensions`
 * AND, when a plugin ships Ryu-only files, the top-level directory name.
 *
 * The spec asks for a domain the client controls, kept stable indefinitely, so
 * this is a one-way door: changing it later orphans every published plugin's Ryu
 * data. Derived from the `@ryuhq` npm scope / `ryuhq.com`.
 */
export const AGENT_PLUGIN_EXTENSION_NS = "com.ryuhq.ryu";

/** Spec file name for the manifest (§5.1). */
export const AGENT_PLUGIN_MANIFEST_FILE = "plugin.json";

/** Spec file name for the MCP configuration (§7.2.1). */
export const AGENT_PLUGIN_MCP_FILE = "mcp.json";

/**
 * Whether a parsed JSON value is an Agent Plugins spec manifest rather than a
 * native Ryu one.
 *
 * This predicate is load-bearing, not cosmetic. `plugin.json` is BOTH the spec's
 * manifest name and a legacy alias for our own `manifest.json` (Core's
 * `MANIFEST_FILE_NAMES` and the CLI's copy of it both still accept it). Once a
 * plugin directory carries an exported spec `plugin.json`, any resolver that
 * blindly takes the first matching name can pick the wrong file and reject the
 * plugin for having no `id`/`runnables`.
 *
 * The discriminator is unambiguous: a spec manifest MUST carry `$schema` with the
 * canonical agent-plugins.org identifier (§5.2), and no native manifest has ever
 * had that field.
 */
export function isAgentPluginManifest(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const schema = (value as Record<string, unknown>).$schema;
	return (
		typeof schema === "string" &&
		schema.startsWith("https://agent-plugins.org/schemas/")
	);
}

/** Author object — the only three fields the spec permits (§5.4). */
export interface AgentPluginAuthor {
	email?: string;
	name?: string;
	url?: string;
}

/** Ryu data carried under {@link AGENT_PLUGIN_EXTENSION_NS}. */
export interface RyuExtensionData {
	/** Human display name; spec `name` is a slug, not a display string. */
	displayName: string;
	/** The real scoped plugin id (`@ryu/advisor`) — unrecoverable from spec `name`. */
	id: string;
	/** Per-MCP-server fields the spec's closed server variants do not allow. */
	mcp?: Record<string, RyuMcpServerExtras>;
}

/** Native MCP fields stripped out of the exported `mcp.json`. */
export interface RyuMcpServerExtras {
	/** Env var that overrides `command` with an absolute path at spawn. */
	command_env?: string;
	/** Human description for our MCP listing endpoint. */
	description?: string;
	/**
	 * Present and `false` when the native manifest disables the server. Such a
	 * server is OMITTED from `mcp.json` entirely — the spec has no `enabled` flag,
	 * so emitting the entry would make a foreign client spawn something we
	 * deliberately do not.
	 */
	enabled?: false;
}

/** A conformant `plugin.json` (§5.2). */
export interface AgentPluginJson {
	$schema: string;
	author?: AgentPluginAuthor;
	description?: string;
	extensions: Record<string, unknown>;
	homepage?: string;
	keywords?: string[];
	license?: string;
	name: string;
	repository?: string;
	version?: string;
}

/** A stdio server entry (§7.2.1). */
export interface AgentPluginStdioServer {
	args?: string[];
	command: string;
	cwd?: string;
	env?: Record<string, string>;
	type: "stdio";
}

/** A remote server entry (§7.2.1). */
export interface AgentPluginRemoteServer {
	headers?: Record<string, string>;
	type: "streamable-http" | "sse";
	url: string;
}

/** Any server variant a conformant Agent Plugins client can consume. */
export type AgentPluginServer =
	| AgentPluginStdioServer
	| AgentPluginRemoteServer;

/** A conformant `mcp.json` (§7.2.1). */
export interface AgentPluginMcpJson {
	$schema: string;
	mcpServers: Record<string, AgentPluginServer>;
}

/** What {@link toAgentPlugin} produces, plus what it had to leave behind. */
export interface AgentPluginExport {
	/** The `mcp.json` contents, or null when the plugin exports no server. */
	mcp: AgentPluginMcpJson | null;
	/**
	 * Human-readable notes about anything dropped or rewritten, so a lossy export
	 * is visible at the call site instead of silent.
	 */
	notes: string[];
	/** The `plugin.json` contents. */
	plugin: AgentPluginJson;
}

const SPEC_NAME_MAX = 64;
const ILLEGAL_NAME_CHARS = /[^a-z0-9.-]+/g;
const REPEATED_HYPHENS = /-{2,}/g;
const REPEATED_DOTS = /\.{2,}/g;
const LEADING_NON_ALNUM = /^[^a-z0-9]+/;
const TRAILING_NON_ALNUM = /[^a-z0-9]+$/;
/** A spec `command` must be ONE executable token (§7.2.1), so no whitespace. */
const WHITESPACE = /\s/;

/**
 * Project a Ryu plugin id onto a spec-legal `name` (§5.5): 1–64 chars of
 * `a-z 0-9 - .`, alphanumeric at both ends, no `--` and no `..`.
 *
 * Our ids are all `@scope/name`, which is illegal there (`@` and `/`), so
 * `@ryu/advisor` becomes `ryu.advisor`. Periods ARE legal, which is what makes the
 * mapping readable rather than a hash. The mapping is lossy by construction (two
 * ids could collide after normalization), so the true id always rides in
 * `extensions` and this value is never treated as an identity on our side.
 */
export function toSpecName(id: string): string {
	const normalized = id
		.trim()
		.toLowerCase()
		.replace(/^@/, "")
		.replace(/[/_]/g, ".")
		.replace(ILLEGAL_NAME_CHARS, "-")
		.replace(REPEATED_HYPHENS, "-")
		.replace(REPEATED_DOTS, ".")
		.replace(LEADING_NON_ALNUM, "")
		.replace(TRAILING_NON_ALNUM, "")
		.slice(0, SPEC_NAME_MAX)
		// A slice can re-expose a trailing separator; trim again after clamping.
		.replace(TRAILING_NON_ALNUM, "");
	if (!normalized) {
		throw new Error(
			`plugin id ${JSON.stringify(id)} has no spec-legal name projection`
		);
	}
	return normalized;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return;
	}
	const strings = value.filter((v): v is string => typeof v === "string");
	return strings.length > 0 ? strings : undefined;
}

/**
 * Normalize our `author` (a bare string OR a Claude-style object) into the spec's
 * object form. The spec permits ONLY `name`, `email`, and `url` — any other member
 * makes the whole manifest invalid, so extra keys are dropped rather than passed
 * through.
 */
function toSpecAuthor(value: unknown): AgentPluginAuthor | undefined {
	const bare = asString(value);
	if (bare) {
		return { name: bare };
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return;
	}
	const source = value as Record<string, unknown>;
	const author: AgentPluginAuthor = {};
	const name = asString(source.name);
	const email = asString(source.email);
	const url = asString(source.url);
	if (name) {
		author.name = name;
	}
	if (email) {
		author.email = email;
	}
	if (url) {
		author.url = url;
	}
	return Object.keys(author).length > 0 ? author : undefined;
}

function toSpecEnv(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return;
	}
	const env: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (typeof raw === "string") {
			env[key] = raw;
		}
	}
	return Object.keys(env).length > 0 ? env : undefined;
}

function validateRemoteUrl(name: string, raw: string): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return `mcp server '${name}' remote url ${JSON.stringify(raw)} is invalid and was omitted`;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return `mcp server '${name}' remote url must use http or https and was omitted`;
	}
	if (parsed.username || parsed.password || parsed.hash) {
		return `mcp server '${name}' remote url must not contain credentials or a fragment and was omitted`;
	}
	return undefined;
}

/**
 * Convert one native MCP server declaration to a spec entry, or return the
 * reason it cannot be exported.
 *
 * Strictness is not optional here and differs from the manifest: an unknown field
 * in a server entry makes THAT ENTRY invalid (§7.2.2 rule 3), where an unknown
 * top-level manifest field is merely reported and ignored. So the export is an
 * allowlist — `command`, `args`, `env` — and everything else moves to `extensions`.
 */
function toSpecServer(
	name: string,
	decl: Record<string, unknown>
): { server?: AgentPluginServer; extras: RyuMcpServerExtras; note?: string } {
	const extras: RyuMcpServerExtras = {};
	const commandEnv = asString(decl.command_env);
	const description = asString(decl.description);
	if (commandEnv) {
		extras.command_env = commandEnv;
	}
	if (description) {
		extras.description = description;
	}

	if (decl.enabled === false) {
		extras.enabled = false;
		return {
			extras,
			note: `mcp server '${name}' is disabled in the native manifest and was omitted from ${AGENT_PLUGIN_MCP_FILE}`,
		};
	}

	const declaredType = asString(decl.type);
	const remoteUrl = asString(decl.url);
	const remoteType =
		declaredType === "sse"
			? "sse"
			: declaredType === "streamable-http" ||
					declaredType === "streamable_http" ||
					declaredType === "http" ||
					(!declaredType && remoteUrl)
				? "streamable-http"
				: undefined;
	if (remoteType) {
		if (!remoteUrl) {
			return {
				extras,
				note: `mcp server '${name}' has remote type '${remoteType}' but no url and was omitted`,
			};
		}
		const urlNote = validateRemoteUrl(name, remoteUrl);
		if (urlNote) {
			return { extras, note: urlNote };
		}
		const server: AgentPluginRemoteServer = {
			type: remoteType,
			url: remoteUrl,
		};
		const headers = toSpecEnv(decl.headers);
		if (headers) {
			server.headers = headers;
		}
		const note = decl.auth
			? `mcp server '${name}' uses Ryu OAuth metadata that is not portable; static headers were exported`
			: undefined;
		return { server, extras, note };
	}
	if (declaredType && declaredType !== "stdio") {
		return {
			extras,
			note: `mcp server '${name}' has unsupported transport '${declaredType}' and was omitted`,
		};
	}

	const command = asString(decl.command);
	if (!command) {
		return {
			extras,
			note: `mcp server '${name}' has no command and was omitted`,
		};
	}
	// §7.2.1: `command` is a bare executable name or a `./`-relative path — never a
	// shell string and never absolute. Ours are all bare names today; a violation is
	// reported rather than exported as an entry a conformant client would reject.
	if (WHITESPACE.test(command)) {
		return {
			extras,
			note: `mcp server '${name}' command ${JSON.stringify(command)} is not a single executable token and was omitted`,
		};
	}
	if (command.startsWith("/") || command.startsWith("~")) {
		return {
			extras,
			note: `mcp server '${name}' command ${JSON.stringify(command)} is an absolute path (spec allows a bare name or './' relative path) and was omitted`,
		};
	}

	const server: AgentPluginStdioServer = { type: "stdio", command };
	const args = asStringArray(decl.args);
	if (args) {
		server.args = args;
	}
	const env = toSpecEnv(decl.env);
	if (env) {
		server.env = env;
	}
	return { server, extras };
}

/**
 * Project a Ryu `manifest.json` onto the Agent Plugins interop pair.
 *
 * Takes the RAW parsed manifest (not the SDK's narrower zod type) because the
 * fields that matter for export — notably `mcp_servers` — live in Core's richer
 * model. Throws only when the id cannot be projected onto a spec-legal name;
 * every other lossy step is reported through {@link AgentPluginExport.notes}.
 */
export function toAgentPlugin(
	manifest: Record<string, unknown>
): AgentPluginExport {
	const id = asString(manifest.id);
	if (!id) {
		throw new Error("manifest has no id");
	}
	const notes: string[] = [];

	const ryu: RyuExtensionData = {
		id,
		displayName: asString(manifest.name) ?? id,
	};

	// Built in the spec's own field order (§5.2) so the emitted file reads like the
	// spec's examples; `extensions` is attached last for the same reason.
	const plugin = {
		$schema: AGENT_PLUGIN_SCHEMA_URL,
		name: toSpecName(id),
	} as AgentPluginJson;

	const version = asString(manifest.version);
	if (version) {
		plugin.version = version;
	}
	// `tagline` is our one-line pitch; it is the better `description` when no long
	// description exists, and the spec has no second summary field to put it in.
	const description =
		asString(manifest.description) ?? asString(manifest.tagline);
	if (description) {
		plugin.description = description;
	}
	const author = toSpecAuthor(manifest.author);
	if (author) {
		plugin.author = author;
	}
	const homepage = asString(manifest.homepage);
	if (homepage) {
		plugin.homepage = homepage;
	}
	const repository = asString(manifest.repository);
	if (repository) {
		plugin.repository = repository;
	}
	const license = asString(manifest.license);
	if (license) {
		plugin.license = license;
	}
	const keywords = asStringArray(manifest.keywords);
	if (keywords) {
		plugin.keywords = keywords;
	}

	const declared = manifest.mcp_servers;
	const servers: Record<string, AgentPluginServer> = {};
	const mcpExtras: Record<string, RyuMcpServerExtras> = {};
	if (declared && typeof declared === "object" && !Array.isArray(declared)) {
		for (const [name, raw] of Object.entries(
			declared as Record<string, unknown>
		)) {
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
				notes.push(`mcp server '${name}' is not an object and was omitted`);
				continue;
			}
			const { server, extras, note } = toSpecServer(
				name,
				raw as Record<string, unknown>
			);
			if (Object.keys(extras).length > 0) {
				mcpExtras[name] = extras;
			}
			if (note) {
				notes.push(note);
			}
			if (server) {
				servers[name] = server;
			}
		}
	}
	if (Object.keys(mcpExtras).length > 0) {
		ryu.mcp = mcpExtras;
	}
	plugin.extensions = { [AGENT_PLUGIN_EXTENSION_NS]: ryu };

	const mcp =
		Object.keys(servers).length > 0
			? { $schema: AGENT_PLUGIN_MCP_SCHEMA_URL, mcpServers: servers }
			: null;

	return { plugin, mcp, notes };
}
