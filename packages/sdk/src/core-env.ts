// packages/sdk/src/core-env.ts
//
// The one place @ryuhq/sdk reads Core connection defaults from the
// environment, so every Core client (the Agent loop, prompts, harness
// sessions, the workflow client) agrees with `ryu install`, eval uploads,
// `ryu-cli`, `ryu-mcp` and the Python `ryu_sdk` package:
//
// - token: `RYU_CORE_TOKEN`, then `RYU_TOKEN` (the older name, still read);
// - URL: `RYU_CORE_URL`, then the local node `http://127.0.0.1:7980`.
//
// Empty and whitespace-only values count as unset.

/** The local Core node. */
export const DEFAULT_CORE_URL = "http://127.0.0.1:7980";

/** The Core bearer-token variables, in the order they are read. */
export const CORE_TOKEN_ENV_VARS = ["RYU_CORE_TOKEN", "RYU_TOKEN"] as const;

/** Reads one environment variable; returns undefined when it is unset. */
export type CoreEnvReader = (name: string) => string | undefined;

function processEnv(name: string): string | undefined {
	return globalThis.process?.env?.[name];
}

function read(reader: CoreEnvReader, name: string): string | undefined {
	const value = reader(name)?.trim();
	return value === undefined || value === "" ? undefined : value;
}

/** `RYU_CORE_TOKEN`, then `RYU_TOKEN`, or undefined when neither is set. */
export function resolveCoreToken(
	reader: CoreEnvReader = processEnv
): string | undefined {
	for (const name of CORE_TOKEN_ENV_VARS) {
		const value = read(reader, name);
		if (value !== undefined) {
			return value;
		}
	}
	return undefined;
}

/** `RYU_CORE_URL`, or the local node when it is unset. */
export function resolveCoreUrl(reader: CoreEnvReader = processEnv): string {
	return read(reader, "RYU_CORE_URL") ?? DEFAULT_CORE_URL;
}

/**
 * The Core URL options every Core client accepts. `baseUrl` is the name new
 * code uses; `nodeUrl` is the older name, still read.
 */
export interface CoreUrlOptions {
	/** Core node URL, e.g. `http://127.0.0.1:7980`. */
	baseUrl?: string;
	/** @deprecated Use `baseUrl`. Still read when `baseUrl` is unset. */
	nodeUrl?: string;
}

function normalizedUrl(value: string | undefined): string | undefined {
	const trimmed = value?.trim().replace(/\/+$/u, "");
	return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/**
 * The Core URL from `baseUrl`, else the deprecated `nodeUrl`, without a
 * trailing slash; undefined when neither is set. Passing both with different
 * values (after trimming and dropping trailing slashes) throws, so a stale
 * `nodeUrl` cannot silently lose to `baseUrl`.
 */
export function pickCoreUrl(options: CoreUrlOptions): string | undefined {
	const baseUrl = normalizedUrl(options.baseUrl);
	const nodeUrl = normalizedUrl(options.nodeUrl);
	if (baseUrl !== undefined && nodeUrl !== undefined && baseUrl !== nodeUrl) {
		throw new Error(
			"[ryu-sdk] pass the Core URL as baseUrl or nodeUrl, not both with different values"
		);
	}
	return baseUrl ?? nodeUrl;
}

/** {@link pickCoreUrl} for clients that require a Core URL. */
export function requireCoreUrl(options: CoreUrlOptions): string {
	const url = pickCoreUrl(options);
	if (url === undefined) {
		throw new Error("[ryu-sdk] a Core URL is required: pass baseUrl");
	}
	return url;
}
