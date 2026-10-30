import { z } from "zod";
import { DEFAULT_CORE_URL, resolveCoreToken } from "../core-env.ts";
import {
	ChatPrompt,
	type Prompt,
	type PromptChatEntry,
	type PromptModelConfig,
	promptFromWire,
	promptVersionWireSchema,
	TextPrompt,
} from "./prompt.ts";
import { templateVariables } from "./template.ts";

/**
 * The prompt registry client behind `@ryuhq/sdk/prompts`.
 *
 * `get(name, { label | version })` resolves a prompt from a registry, keeps it
 * in an in-process cache for `cacheTtlMs`, serves the last good copy when a
 * refresh fails, and falls back to a caller-supplied template when the
 * registry has never answered. Two registries speak the same routes:
 *
 * - the local Core node (`/api/prompts/...`, the default): works offline, and
 *   mirrors the organization registry when the node is signed in;
 * - the organization registry on the hosted control plane
 *   (`/api/control-plane/orgs/:orgId/prompts/...`), when `organizationId`,
 *   `apiKey` or `hosted` is set. It authenticates with a `ryu_` API key
 *   (`x-api-key` plus `X-Ryu-Organization`) or a signed-in session token, and
 *   never with the Core token.
 *
 * Redirects are refused, never followed: `fetch` strips only `authorization`
 * and cookies on a cross-origin redirect, so following one would hand the
 * `x-api-key` to whatever origin the redirect names.
 */

const DEFAULT_CACHE_TTL_MS = 60_000;
/** The hosted control-plane origin when neither `baseUrl` nor `RYU_API_URL` is set. */
export const DEFAULT_PROMPT_API_URL = "https://api.ryuhq.com";

export type FetchLike = (
	input: string,
	init?: RequestInit
) => Promise<Response>;

export interface PromptClientOptions {
	/**
	 * Hosted registry only: a Ryu API key (`ryu_...`) with `prompts:read`
	 * (and `prompts:manage` to write), sent as `x-api-key` with the
	 * organization in `X-Ryu-Organization`. Setting it selects the hosted
	 * registry. Defaults to `RYU_API_KEY` there unless `token` is passed.
	 */
	apiKey?: string;
	/**
	 * Registry base URL: a Core node (`http://127.0.0.1:7980`) or, for the
	 * hosted registry, the control-plane API origin. Defaults to `RYU_CORE_URL`,
	 * then the local node; for the hosted registry to `RYU_API_URL`, then
	 * `https://api.ryuhq.com`.
	 */
	baseUrl?: string;
	/** Default cache lifetime for resolved prompts (60s). 0 disables caching. */
	cacheTtlMs?: number;
	/** Custom transport (tests, proxies). Defaults to global `fetch`. */
	fetch?: FetchLike;
	/**
	 * Use the organization registry on the hosted control plane with every
	 * setting from the environment (`RYU_API_URL`, `RYU_API_KEY`,
	 * `RYU_ORGANIZATION_ID`). Implied by `organizationId` or `apiKey`.
	 */
	hosted?: boolean;
	/**
	 * The organization whose hosted registry to use. Setting it selects the
	 * hosted registry. Defaults to `RYU_ORGANIZATION_ID` there.
	 */
	organizationId?: string;
	/**
	 * Bearer token. On the local node it is a Core token and defaults to
	 * `RYU_CORE_TOKEN`, then `RYU_TOKEN`. On the hosted registry (when
	 * `organizationId`, `apiKey` or `hosted` is set) it must be a signed-in
	 * session token, used instead of an API key, and it is sent to `baseUrl`,
	 * `RYU_API_URL` or `https://api.ryuhq.com`, never to `RYU_CORE_URL`. A
	 * hosted client refuses a token equal to `RYU_CORE_TOKEN` / `RYU_TOKEN`, so
	 * a Core node token is never sent to the control plane.
	 */
	token?: string;
}

/** What `get()` falls back to when the registry cannot be reached. */
export type PromptFallback =
	| string
	| Array<
			| { content: string; role: "system" | "user" | "assistant" | "developer" }
			| { name: string; type: "placeholder" }
	  >;

export interface GetPromptOptions {
	/** Override the client's cache lifetime for this call. */
	cacheTtlMs?: number;
	/** Used (with `isFallback: true`) when the registry never answered. */
	fallback?: PromptFallback;
	/** Label to resolve (default `production`; `latest` is the newest version). */
	label?: string;
	/** Exact version to resolve; exclusive with `label`. */
	version?: number;
}

export class PromptRegistryError extends Error {
	readonly status: number;
	readonly code: string | null;

	constructor(message: string, status: number, code: string | null) {
		super(message);
		this.name = "PromptRegistryError";
		this.status = status;
		this.code = code;
	}
}

export const promptSummarySchema = z.object({
	name: z.string(),
	description: z.string().nullable().catch(null),
	tags: z.array(z.string()).catch(() => []),
	type: z.enum(["text", "chat"]),
	latestVersion: z.number().int(),
	labels: z.record(z.string(), z.number().int()).catch(() => ({})),
	source: z.enum(["local", "cloud"]).optional(),
	createdAt: z.string().catch(""),
	updatedAt: z.string().catch(""),
});
export type PromptSummary = z.infer<typeof promptSummarySchema>;

/** The content of a new version. */
export type PromptVersionInput =
	| {
			commitMessage?: string;
			expectedLatestVersion?: number;
			labels?: string[];
			modelConfig?: PromptModelConfig;
			template: string;
			type: "text";
	  }
	| {
			commitMessage?: string;
			expectedLatestVersion?: number;
			labels?: string[];
			messages: PromptChatEntry[];
			modelConfig?: PromptModelConfig;
			type: "chat";
	  };

const versionEnvelope = z.object({ version: promptVersionWireSchema });
const promptEnvelope = z.object({ prompt: promptSummarySchema });
const listEnvelope = z.object({ prompts: z.array(promptSummarySchema) });
const commitEnvelope = z.object({
	prompt: promptSummarySchema,
	version: promptVersionWireSchema,
});
const errorEnvelope = z.object({ error: z.string() });

function env(name: string): string | undefined {
	return typeof process === "undefined" ? undefined : process.env[name];
}

interface CacheEntry {
	fetchedAt: number;
	prompt: Prompt;
}

/** Where a request goes and the credential headers it carries. */
interface RegistryTarget {
	headers: Record<string, string>;
	root: string;
}

const trimmed = (value: string | undefined): string | undefined => {
	const text = value?.trim();
	return text ? text : undefined;
};

export class PromptClient {
	private readonly options: PromptClientOptions;
	private readonly cache = new Map<string, CacheEntry>();
	private readonly now: () => number;

	constructor(options: PromptClientOptions = {}, now: () => number = Date.now) {
		if (options.apiKey !== undefined && options.token !== undefined) {
			throw new Error(
				"[ryu-sdk] PromptClient takes an apiKey or a session token, not both"
			);
		}
		this.options = options;
		this.now = now;
	}

	private get hosted(): boolean {
		const { apiKey, hosted, organizationId } = this.options;
		return (
			hosted === true || organizationId !== undefined || apiKey !== undefined
		);
	}

	/**
	 * The registry root and credential headers. Throws (before any request, so
	 * a `fallback` never hides it) when the hosted registry has no
	 * organization or no credential, or is handed the Core token.
	 */
	private target(): RegistryTarget {
		const headers: Record<string, string> = { accept: "application/json" };
		if (!this.hosted) {
			const base =
				this.options.baseUrl ?? env("RYU_CORE_URL") ?? DEFAULT_CORE_URL;
			const token = this.options.token ?? resolveCoreToken();
			if (token) {
				headers.authorization = `Bearer ${token}`;
			}
			return { headers, root: `${base.replace(/\/+$/u, "")}/api/prompts` };
		}
		const organizationId =
			trimmed(this.options.organizationId) ??
			trimmed(env("RYU_ORGANIZATION_ID"));
		if (!organizationId) {
			throw new Error(
				"[ryu-sdk] the hosted prompt registry needs organizationId or RYU_ORGANIZATION_ID"
			);
		}
		const base =
			this.options.baseUrl ??
			trimmed(env("RYU_API_URL")) ??
			DEFAULT_PROMPT_API_URL;
		// A Core node token never goes to the control plane: the hosted registry
		// takes a `ryu_` API key, or an explicit session token instead of one.
		if (this.options.token === undefined) {
			const apiKey =
				trimmed(this.options.apiKey) ?? trimmed(env("RYU_API_KEY"));
			if (!apiKey) {
				throw new Error(
					"[ryu-sdk] the hosted prompt registry needs an API key: pass apiKey or set RYU_API_KEY"
				);
			}
			headers["x-api-key"] = apiKey;
			headers["x-ryu-organization"] = organizationId;
		} else {
			const token = trimmed(this.options.token);
			if (!token) {
				throw new Error(
					"[ryu-sdk] the hosted prompt registry needs a session token or an API key (RYU_API_KEY)"
				);
			}
			if (token === trimmed(resolveCoreToken())) {
				throw new Error(
					"[ryu-sdk] the hosted prompt registry takes a session token or a ryu_ API key (RYU_API_KEY), never the Core token"
				);
			}
			headers.authorization = `Bearer ${token}`;
		}
		return {
			headers,
			root: `${base.replace(/\/+$/u, "")}/api/control-plane/orgs/${encodeURIComponent(organizationId)}/prompts`,
		};
	}

	private async request(
		path: string,
		init: { body?: unknown; method?: string } = {}
	): Promise<unknown> {
		const transport = this.options.fetch ?? fetch;
		const { headers, root } = this.target();
		if (init.body !== undefined) {
			headers["content-type"] = "application/json";
		}
		const response = await transport(`${root}${path}`, {
			method: init.method ?? "GET",
			headers,
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
			// Never follow: a cross-origin redirect would carry `x-api-key`.
			redirect: "manual",
		});
		if (
			response.type === "opaqueredirect" ||
			(response.status >= 300 && response.status < 400)
		) {
			throw new PromptRegistryError(
				"redirect_refused: the prompt registry answered with a redirect, which the client does not follow",
				response.status,
				"redirect_refused"
			);
		}
		const text = await response.text();
		if (!response.ok) {
			let message = text.trim() || response.statusText;
			try {
				const parsed = errorEnvelope.safeParse(JSON.parse(text));
				if (parsed.success) {
					message = parsed.data.error;
				}
			} catch {
				// Plain-text error bodies are used as they are.
			}
			const code = /^([a-z_]+): /u.exec(message)?.[1] ?? null;
			throw new PromptRegistryError(message, response.status, code);
		}
		return text === "" ? {} : JSON.parse(text);
	}

	/**
	 * Resolve a prompt by label (default `production`) or version, with cache
	 * and fallback. Without a fallback, an unreachable registry and an unknown
	 * prompt both throw `PromptRegistryError`.
	 */
	async get(name: string, options: GetPromptOptions = {}): Promise<Prompt> {
		if (options.label !== undefined && options.version !== undefined) {
			throw new Error(
				"[ryu-sdk] prompts.get takes a label or a version, not both"
			);
		}
		const selector =
			options.version === undefined
				? `label=${encodeURIComponent(options.label ?? "production")}`
				: `version=${options.version}`;
		const key = `${name}?${selector}`;
		const ttl =
			options.cacheTtlMs ?? this.options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
		const cached = this.cache.get(key);
		if (cached && ttl > 0 && this.now() - cached.fetchedAt < ttl) {
			return cached.prompt;
		}
		// A configuration error is the caller's to fix, never a fallback.
		this.target();
		try {
			const body = versionEnvelope.parse(
				await this.request(`/${encodeURIComponent(name)}/resolve?${selector}`)
			);
			const prompt = promptFromWire(body.version);
			if (ttl > 0) {
				this.cache.set(key, { prompt, fetchedAt: this.now() });
			}
			return prompt;
		} catch (error) {
			if (cached) {
				return cached.prompt;
			}
			if (options.fallback !== undefined) {
				return fallbackPrompt(name, options.fallback);
			}
			throw error;
		}
	}

	/** Drop cached resolutions (all, or one prompt's). */
	invalidate(name?: string): void {
		if (name === undefined) {
			this.cache.clear();
			return;
		}
		for (const key of this.cache.keys()) {
			if (key.startsWith(`${name}?`)) {
				this.cache.delete(key);
			}
		}
	}

	async list(): Promise<PromptSummary[]> {
		return listEnvelope.parse(await this.request("")).prompts;
	}

	/** Create a prompt and commit its first version. */
	async create(input: {
		description?: string;
		name: string;
		tags?: string[];
		version: PromptVersionInput;
	}): Promise<Prompt> {
		const body = commitEnvelope.parse(
			await this.request("", { method: "POST", body: input })
		);
		this.invalidate(input.name);
		return promptFromWire(body.version);
	}

	/** Commit a new immutable version, optionally moving labels onto it. */
	async commit(name: string, version: PromptVersionInput): Promise<Prompt> {
		const body = commitEnvelope.parse(
			await this.request(`/${encodeURIComponent(name)}/versions`, {
				method: "POST",
				body: version,
			})
		);
		this.invalidate(name);
		return promptFromWire(body.version);
	}

	/** Point `label` at `version` (promote, roll back). */
	async setLabel(
		name: string,
		label: string,
		version: number
	): Promise<PromptSummary> {
		const body = promptEnvelope.parse(
			await this.request(
				`/${encodeURIComponent(name)}/labels/${encodeURIComponent(label)}`,
				{ method: "PUT", body: { version } }
			)
		);
		this.invalidate(name);
		return body.prompt;
	}
}

/** The prompt object for a caller-supplied fallback. */
export function fallbackPrompt(name: string, fallback: PromptFallback): Prompt {
	if (typeof fallback === "string") {
		return new TextPrompt({
			name,
			version: 0,
			template: fallback,
			variables: templateVariables(fallback),
			isFallback: true,
		});
	}
	const variables = new Set<string>();
	for (const entry of fallback) {
		if ("content" in entry) {
			for (const variable of templateVariables(entry.content)) {
				variables.add(variable);
			}
		}
	}
	return new ChatPrompt({
		name,
		version: 0,
		messages: fallback,
		variables: [...variables],
		isFallback: true,
	});
}

export function createPromptClient(
	options: PromptClientOptions = {}
): PromptClient {
	return new PromptClient(options);
}

/**
 * The default client: the local Core node (`RYU_CORE_URL`, `RYU_CORE_TOKEN` / `RYU_TOKEN`), with
 * a 60s cache. Create another with `createPromptClient()` for the hosted
 * organization registry (`{ hosted: true }` reads `RYU_API_URL`,
 * `RYU_API_KEY` and `RYU_ORGANIZATION_ID`) or a different node.
 */
export const prompts = createPromptClient();
