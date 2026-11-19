/**
 * Confluence pages through the REST API (`/rest/api/content`).
 *
 * Works with Confluence Cloud (`https://<site>.atlassian.net/wiki`, email +
 * API token) and Data Center (`https://confluence.example.com`, personal access
 * token). Pages are read in their rendered `export_view` HTML and converted to
 * Markdown.
 */

import { htmlToMarkdown } from "./html.ts";
import {
	type CredentialSource,
	fetchJson,
	type NetworkOptions,
	resolveCredential,
} from "./net.ts";
import { BaseLoader, type LoadedDocument, LoaderError } from "./types.ts";

/** Options for {@link ConfluenceLoader}. */
export interface ConfluenceLoaderOptions extends NetworkOptions {
	/** Atlassian API token (Cloud). Used with `email` for Basic auth. */
	apiToken?: CredentialSource;
	/**
	 * Site root including the context path: `https://acme.atlassian.net/wiki`
	 * on Cloud, the server URL on Data Center.
	 */
	baseUrl: string;
	/** A CQL query selecting pages (e.g. `space = ENG and label = runbook`). */
	cql?: string;
	/** Account email (Cloud). */
	email?: string;
	/** Most pages loaded. Default 200. */
	maxPages?: number;
	/** Page ids to load. */
	pageIds?: readonly string[];
	/** Personal access token (Data Center), sent as a bearer token. */
	personalAccessToken?: CredentialSource;
	/** Load every current page in this space. */
	spaceKey?: string;
}

type JsonObject = Record<string, unknown>;

const EXPAND = "body.export_view,body.storage,version,space";
const PAGE_ID = /^\d+$/;
const SPACE_KEY = /^[A-Za-z0-9~_-]+$/;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bodyHtml(page: JsonObject): string {
	const body = isObject(page.body) ? page.body : {};
	for (const key of ["export_view", "view", "storage"]) {
		const representation = body[key];
		if (isObject(representation) && typeof representation.value === "string") {
			return representation.value;
		}
	}
	return "";
}

/**
 * Load Confluence pages as Markdown.
 *
 * ```ts
 * const docs = await new ConfluenceLoader({
 *   baseUrl: "https://acme.atlassian.net/wiki",
 *   email: "me@acme.com",
 *   apiToken: process.env.CONFLUENCE_TOKEN!,
 *   spaceKey: "ENG",
 * }).load();
 * ```
 */
export class ConfluenceLoader extends BaseLoader {
	readonly #options: ConfluenceLoaderOptions;
	readonly #base: string;

	constructor(options: ConfluenceLoaderOptions) {
		super();
		if (options.spaceKey && !SPACE_KEY.test(options.spaceKey)) {
			throw new LoaderError("Confluence space key must be a plain key");
		}
		for (const id of options.pageIds ?? []) {
			if (!PAGE_ID.test(id)) {
				throw new LoaderError(`Confluence page id must be numeric: ${id}`);
			}
		}
		this.#options = options;
		this.#base = options.baseUrl.replace(/\/+$/, "");
	}

	async #headers(): Promise<Record<string, string>> {
		const options = this.#options;
		const headers: Record<string, string> = { accept: "application/json" };
		const pat = await resolveCredential(
			options.personalAccessToken,
			"Confluence"
		);
		if (pat) {
			headers.authorization = `Bearer ${pat}`;
			return headers;
		}
		const apiToken = await resolveCredential(options.apiToken, "Confluence");
		if (apiToken) {
			if (!options.email) {
				throw new LoaderError("Confluence apiToken needs the account email");
			}
			headers.authorization = `Basic ${btoa(`${options.email}:${apiToken}`)}`;
		}
		return headers;
	}

	async #get(path: string, query: Record<string, string>): Promise<JsonObject> {
		const result = await fetchJson(
			`${this.#base}/rest/api${path}?${new URLSearchParams(query)}`,
			{ headers: await this.#headers() },
			this.#options
		);
		if (!isObject(result)) {
			throw new LoaderError("Confluence returned an unexpected response");
		}
		return result;
	}

	async #collect(
		path: string,
		query: Record<string, string>,
		into: JsonObject[]
	) {
		const maxPages = this.#options.maxPages ?? 200;
		let start = 0;
		while (into.length < maxPages) {
			const limit = Math.min(50, maxPages - into.length);
			const page = await this.#get(path, {
				...query,
				start: String(start),
				limit: String(limit),
			});
			const results = Array.isArray(page.results)
				? page.results.filter(isObject)
				: [];
			into.push(...results.slice(0, maxPages - into.length));
			const links = isObject(page._links) ? page._links : {};
			if (results.length === 0 || typeof links.next !== "string") {
				break;
			}
			start += results.length;
		}
	}

	/** The raw page objects that would be loaded. */
	async pages(): Promise<JsonObject[]> {
		const options = this.#options;
		const pages: JsonObject[] = [];
		for (const id of options.pageIds ?? []) {
			pages.push(await this.#get(`/content/${id}`, { expand: EXPAND }));
		}
		if (options.spaceKey) {
			await this.#collect(
				"/content",
				{
					spaceKey: options.spaceKey,
					type: "page",
					status: "current",
					expand: EXPAND,
				},
				pages
			);
		}
		if (options.cql) {
			await this.#collect(
				"/content/search",
				{ cql: options.cql, expand: EXPAND },
				pages
			);
		}
		return pages;
	}

	async *lazyLoad(): AsyncIterable<LoadedDocument> {
		for (const page of await this.pages()) {
			const id = typeof page.id === "string" ? page.id : String(page.id ?? "");
			const title = typeof page.title === "string" ? page.title : "Untitled";
			const links = isObject(page._links) ? page._links : {};
			const webui =
				typeof links.webui === "string" ? links.webui : `/pages/${id}`;
			const space = isObject(page.space) ? page.space : {};
			const version = isObject(page.version) ? page.version : {};
			const markdown = htmlToMarkdown(bodyHtml(page), {
				baseUrl: `${this.#base}/`,
			});
			yield {
				content: markdown ? `# ${title}\n\n${markdown}` : `# ${title}`,
				metadata: {
					source: `${this.#base}${webui}`,
					loader: "confluence",
					id,
					title,
					space: typeof space.key === "string" ? space.key : null,
					version: typeof version.number === "number" ? version.number : null,
					lastModified: typeof version.when === "string" ? version.when : null,
				},
			};
		}
	}
}
