/**
 * `ryu install <bundle|dir>` — side-load a packed plugin into a Ryu node.
 *
 * Posts the `ryu pack` output (`dist/plugin.bundle.json`: the manifest plus any
 * bundled `ui_code`) to Core's authenticated `POST /api/plugins/install-bundle`,
 * then optionally enables it. A side-loaded plugin installs DISABLED, exactly
 * like a store install, so enabling (which validates its grants through the
 * Gateway) stays an explicit step.
 *
 * Core URL / bearer resolution mirrors the other local Ryu clients:
 *   - URL: `RYU_CORE_URL`, else `http://127.0.0.1:7980`.
 *   - Bearer: `RYU_CORE_TOKEN`, else `RYU_TOKEN`, else — ONLY for a loopback
 *     URL — the token Core minted at `<data dir>/secrets/node-auth.token`. The
 *     machine's own node token is never sent to a remote URL.
 *   - Data dir: resolved like Core (`@ryuhq/core-client`'s `ryuHomeDir`):
 *     `RYU_DIR`, else the Storage pointer `<os config>/ryu<sfx>/data-path.json`,
 *     else `~/.ryu<sfx>`.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

const DEFAULT_CORE_URL = "http://127.0.0.1:7980";
const TRAILING_SLASHES = /\/+$/;
const IPV6_BRACKETS = /^\[|\]$/g;
const TRAILING_DOT = /\.$/;

type EnvReader = (key: string) => string | undefined;

const processEnv: EnvReader = (key) => {
	const value = process.env[key]?.trim();
	return value ? value : undefined;
};

/** Data/config dir suffix: `""` for release, `-<profile>` otherwise. */
function profileSuffix(env: EnvReader): string {
	const profile = (env("RYU_PROFILE") ?? "").toLowerCase();
	return profile && profile !== "release" ? `-${profile}` : "";
}

/** The OS config dir, matching Rust's `dirs::config_dir()`. */
function osConfigDir(env: EnvReader): string {
	if (process.platform === "win32") {
		return env("APPDATA") ?? join(homedir(), "AppData", "Roaming");
	}
	if (process.platform === "darwin") {
		return join(homedir(), "Library", "Application Support");
	}
	const xdg = env("XDG_CONFIG_HOME");
	return xdg?.startsWith("/") ? xdg : join(homedir(), ".config");
}

const dataPathPointerSchema = z.object({
	data_dir: z.string().refine((dir) => dir.trim() !== ""),
});

/** The Storage relocation pointer's `data_dir`, or null when absent/corrupt. */
function readDataPathPointer(env: EnvReader): string | null {
	const pointer = join(
		osConfigDir(env),
		`ryu${profileSuffix(env)}`,
		"data-path.json"
	);
	try {
		const parsed = dataPathPointerSchema.safeParse(
			JSON.parse(readFileSync(pointer, "utf8"))
		);
		return parsed.success ? parsed.data.data_dir : null;
	} catch {
		// Missing or corrupt pointer: fall back to the profile default.
		return null;
	}
}

/**
 * The Ryu data directory Core uses for this profile, resolved like Core:
 * `RYU_DIR` > Storage pointer > `~/.ryu<sfx>`.
 */
export function ryuDataDir(env: EnvReader = processEnv): string {
	const explicit = env("RYU_DIR");
	if (explicit) {
		return explicit;
	}
	return (
		readDataPathPointer(env) ?? join(homedir(), `.ryu${profileSuffix(env)}`)
	);
}

/** True when `url` addresses Core on this machine (parsed, never string-matched). */
export function isLoopbackUrl(url: string): boolean {
	let hostname: string;
	try {
		hostname = new URL(url).hostname;
	} catch {
		return false;
	}
	const host = hostname
		.replace(IPV6_BRACKETS, "")
		.replace(TRAILING_DOT, "")
		.toLowerCase();
	return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export interface CoreTarget {
	baseUrl: string;
	token: string | null;
}

/** Resolve the Core node to install into and the bearer to present to it. */
export function resolveCoreTarget(
	env: EnvReader = processEnv,
	readToken: (path: string) => string | null = readTokenFile
): CoreTarget {
	const baseUrl = (env("RYU_CORE_URL") ?? DEFAULT_CORE_URL).replace(
		TRAILING_SLASHES,
		""
	);
	const explicit = env("RYU_CORE_TOKEN") ?? env("RYU_TOKEN");
	if (explicit) {
		return { baseUrl, token: explicit };
	}
	if (!isLoopbackUrl(baseUrl)) {
		return { baseUrl, token: null };
	}
	return {
		baseUrl,
		token: readToken(join(ryuDataDir(env), "secrets", "node-auth.token")),
	};
}

function readTokenFile(path: string): string | null {
	try {
		return readFileSync(path, "utf8").trim() || null;
	} catch {
		return null;
	}
}

/** Accept a bundle file, or a project directory containing `dist/plugin.bundle.json`. */
export function resolveBundlePath(input: string): string {
	const absolute = resolve(input);
	if (existsSync(absolute) && statSync(absolute).isDirectory()) {
		return join(absolute, "dist", "plugin.bundle.json");
	}
	return absolute;
}

const bundleIdentitySchema = z.object({
	id: z.string().min(1),
	version: z.string().optional(),
});

const coreErrorSchema = z.object({ error: z.string() });

function describeFailure(status: number, text: string): string {
	let detail = text;
	try {
		detail = coreErrorSchema.parse(JSON.parse(text)).error;
	} catch {
		// Non-JSON or unexpected shape: report the raw body.
	}
	const hint =
		status === 401 ? " (set RYU_CORE_TOKEN to the node's bearer token)" : "";
	return `${status}: ${detail}${hint}`;
}

export interface InstallOptions {
	bundlePath: string;
	enable?: boolean;
	fetchImpl?: typeof fetch;
	target?: CoreTarget;
	update?: boolean;
}

export interface InstallOutcome {
	enabled: boolean;
	id: string;
	version?: string;
}

/** Install (and optionally enable) a packed bundle. Throws with a readable message. */
export async function installBundle(
	options: InstallOptions
): Promise<InstallOutcome> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const target = options.target ?? resolveCoreTarget();
	if (!existsSync(options.bundlePath)) {
		throw new Error(
			`bundle not found: ${options.bundlePath} (run \`ryu pack <dir>\` first)`
		);
	}
	const raw: unknown = JSON.parse(readFileSync(options.bundlePath, "utf8"));
	const identity = bundleIdentitySchema.safeParse(raw);
	if (!identity.success) {
		throw new Error(`${options.bundlePath} is not a plugin bundle (no id)`);
	}
	const body =
		options.update && raw !== null && typeof raw === "object"
			? { ...raw, update: true }
			: raw;
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (target.token) {
		headers.authorization = `Bearer ${target.token}`;
	}

	const installUrl = `${target.baseUrl}/api/plugins/install-bundle`;
	const installed = await fetchImpl(installUrl, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
	if (!installed.ok) {
		throw new Error(
			`install failed ${describeFailure(installed.status, await installed.text())}`
		);
	}

	const { id, version } = identity.data;
	if (!options.enable) {
		return { id, version, enabled: false };
	}
	const enableUrl = `${target.baseUrl}/api/plugins/${encodeURIComponent(id)}/enable`;
	const enabled = await fetchImpl(enableUrl, { method: "POST", headers });
	if (!enabled.ok) {
		throw new Error(
			`installed ${id}, but enable failed ${describeFailure(enabled.status, await enabled.text())}`
		);
	}
	return { id, version, enabled: true };
}
