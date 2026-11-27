/**
 * Where a third party agent framework should send its model calls: the Ryu
 * Gateway's OpenAI compatible base URL and the Gateway key.
 *
 * Pure TypeScript on purpose. The framework entry points (`@ryuhq/sdk/mastra`,
 * `@ryuhq/sdk/langchain`) hand a plain configuration object to the
 * framework's own OpenAI compatible client, so they must load in any
 * JavaScript runtime without the native addon that backs `@ryuhq/sdk/model`.
 * The environment variable names, the default URL and the direct provider
 * blocklist mirror `crates/sdk/core/src/gateway.rs`; `gateway-target.test.ts`
 * reads that file and fails when the two drift.
 */

/** Default base URL of the local Ryu Gateway (Core 7980, Gateway 7981). */
export const DEFAULT_GATEWAY_URL = "http://127.0.0.1:7981";

/** Environment variable holding the Gateway base URL (with or without `/v1`). */
export const ENV_GATEWAY_URL = "RYU_GATEWAY_URL";

/** Environment variable holding the Gateway key. */
export const ENV_GATEWAY_TOKEN = "RYU_GATEWAY_TOKEN";

/**
 * Sent as the key when none is configured. It is not a secret and matches no
 * Gateway key: a Gateway with `require_auth = false` accepts it, any other
 * Gateway answers 401. Without it the frameworks' OpenAI clients fall back to
 * `OPENAI_API_KEY` and would send that provider key to the Gateway.
 */
export const RYU_NO_KEY = "ryu-gateway-no-key";

/**
 * Hosts of public model providers. A framework pointed at one of them would
 * bypass the Gateway, so they are refused as a base URL. Same list, same
 * order, as `BLOCKED_PROVIDER_PATTERNS` in the Rust core.
 */
export const BLOCKED_PROVIDER_PATTERNS: readonly string[] = [
	"api\\.openai\\.com",
	"api\\.anthropic\\.com",
	"generativelanguage\\.googleapis\\.com",
	"api\\.cohere\\.ai",
	"api\\.mistral\\.ai",
	"openrouter\\.ai",
	"api\\.groq\\.com",
	"api\\.together\\.xyz",
	"api\\.replicate\\.com",
	"api\\.perplexity\\.ai",
];

const BLOCKED_PROVIDERS = BLOCKED_PROVIDER_PATTERNS.map(
	(pattern) => new RegExp(pattern, "i")
);
const TRAILING_SLASHES = /\/+$/;
const V1_SUFFIX = /\/v1$/i;
const LOOPBACK_IPV4 = /^127(?:\.\d{1,3}){3}$/;
let warnedPlainHttp = false;

/** Options shared by every framework helper. */
export interface RyuGatewayOptions {
	/**
	 * The Gateway key. Defaults to `RYU_GATEWAY_TOKEN`. This is a Ryu Gateway
	 * key, never a provider key: provider credentials stay in the Gateway.
	 */
	apiKey?: string;
	/**
	 * Gateway base URL, with or without a trailing `/v1`. Defaults to
	 * `RYU_GATEWAY_URL`, then the local Gateway. A direct provider URL throws.
	 */
	baseUrl?: string;
	/** Extra headers sent with every model call, for example a trace id. */
	headers?: Record<string, string>;
}

/** A resolved Gateway target. */
export interface RyuGatewayTarget {
	/** The Gateway key, or {@link RYU_NO_KEY} when none is configured. */
	apiKey: string;
	/** OpenAI compatible base URL. Always ends in `/v1`, never in a slash. */
	baseUrl: string;
	/** True when a key came from the options or the environment. */
	hasKey: boolean;
	/** Extra headers, when any were given. */
	headers?: Record<string, string>;
}

function readEnv(name: string): string | undefined {
	if (typeof process === "undefined") {
		return;
	}
	return process.env?.[name]?.trim() || undefined;
}

function parseUrl(raw: string): URL | undefined {
	try {
		return new URL(raw);
	} catch {
		return;
	}
}

/**
 * Throw when `baseUrl` is a known direct provider endpoint. The raw text and
 * the parsed hostname are both checked, because the URL parser turns an
 * encoded host such as `api%2Eopenai%2Ecom` into `api.openai.com`. The message
 * is the one the Rust core gives, except that it names only the scheme and
 * host (or `<unparseable>`), so a secret in the URL never lands in a log.
 */
export function assertGatewayUrl(baseUrl: string): void {
	const parsed = parseUrl(baseUrl);
	const hostname = parsed?.hostname ?? "";
	const blocked = BLOCKED_PROVIDERS.some(
		(pattern) => pattern.test(baseUrl) || pattern.test(hostname)
	);
	if (blocked) {
		const shown = parsed?.host
			? `${parsed.protocol}//${parsed.host}`
			: "<unparseable>";
		throw new Error(
			`[ryu-sdk] direct provider egress is not allowed: "${shown}". All model calls must route through the Ryu gateway. Set ${ENV_GATEWAY_URL} to your gateway base URL, or omit baseUrl to use the default (${DEFAULT_GATEWAY_URL}). Provider credentials belong in the gateway, not in SDK config.`
		);
	}
}

/**
 * Validate the base URL and give it the `/v1` suffix. The credential and
 * query checks come first and do not repeat the URL, so a secret typed into
 * the URL never lands in an error message or a log. The result is built from
 * the parsed URL, so an empty `?` or `#` in the raw text cannot end up in it.
 */
function openAiBaseUrl(raw: string): string {
	const parsed = parseUrl(raw);
	if (!parsed) {
		throw new Error(
			`[ryu-sdk] the Gateway base URL is not a valid URL. Use a form like ${DEFAULT_GATEWAY_URL}.`
		);
	}
	if (parsed.username || parsed.password) {
		throw new Error(
			"[ryu-sdk] the Gateway base URL must not carry credentials. Pass the Gateway key as apiKey."
		);
	}
	if (parsed.search || parsed.hash) {
		throw new Error(
			"[ryu-sdk] the Gateway base URL must not carry a query or a fragment."
		);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(
			`[ryu-sdk] the Gateway base URL must start with http:// or https://, got the scheme "${parsed.protocol}".`
		);
	}
	const trimmed = `${parsed.origin}${parsed.pathname}`.replace(
		TRAILING_SLASHES,
		""
	);
	return V1_SUFFIX.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function isLoopbackHost(hostname: string): boolean {
	const name = hostname.toLowerCase();
	return name === "localhost" || name === "[::1]" || LOOPBACK_IPV4.test(name);
}

/**
 * Warn once per process when a real Gateway key would travel over plain http
 * to a host that is not this machine. Only a warning, never a refusal, so a
 * Gateway in docker or on the LAN keeps working. It names the host only.
 */
function warnPlainHttp(rawUrl: string, hasKey: boolean): void {
	const parsed = parseUrl(rawUrl);
	if (
		warnedPlainHttp ||
		!hasKey ||
		parsed?.protocol !== "http:" ||
		isLoopbackHost(parsed.hostname)
	) {
		return;
	}
	warnedPlainHttp = true;
	console.warn(
		`[ryu-sdk] the Gateway at ${parsed.hostname} is reached over plain http, so the Gateway key travels in clear text. Use https:// for a Gateway that is not on the same machine.`
	);
}

/**
 * Resolve the Gateway target from the options, then the environment, then the
 * local default. Use it directly for any other OpenAI compatible client.
 *
 *   const { baseUrl, apiKey } = resolveRyuGateway();
 */
export function resolveRyuGateway(
	options: RyuGatewayOptions = {}
): RyuGatewayTarget {
	const rawUrl =
		options.baseUrl?.trim() || readEnv(ENV_GATEWAY_URL) || DEFAULT_GATEWAY_URL;
	const baseUrl = openAiBaseUrl(rawUrl);
	assertGatewayUrl(rawUrl);
	const key = options.apiKey?.trim() || readEnv(ENV_GATEWAY_TOKEN);
	const target: RyuGatewayTarget = {
		apiKey: key ?? RYU_NO_KEY,
		baseUrl,
		hasKey: key !== undefined,
	};
	if (options.headers && Object.keys(options.headers).length > 0) {
		target.headers = { ...options.headers };
	}
	warnPlainHttp(rawUrl, target.hasKey);
	return target;
}

/** Trim a Gateway model id and refuse an empty one. */
export function gatewayModelId(model: string): string {
	const id = typeof model === "string" ? model.trim() : "";
	if (!id) {
		throw new Error(
			"[ryu-sdk] a model id is required, for example gpt-4o. GET /v1/models on the Gateway lists the ids."
		);
	}
	return id;
}
