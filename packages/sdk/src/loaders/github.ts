/**
 * Files from a GitHub repository, through the REST API.
 *
 * Lists the tree once (`GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1`),
 * filters it by path and size, and downloads each blob as raw content. Binary
 * files are skipped. Works with GitHub Enterprise through `apiUrl`.
 */

import {
	type CredentialSource,
	fetchBytes,
	fetchJson,
	type NetworkOptions,
	resolveCredential,
} from "./net.ts";
import { BaseLoader, type LoadedDocument, LoaderError } from "./types.ts";

/** Options for {@link GitHubRepoLoader}. */
export interface GitHubRepoLoaderOptions extends NetworkOptions {
	/** API root. Default `https://api.github.com`. */
	apiUrl?: string;
	/** Skip paths matching any of these (substring or RegExp). */
	exclude?: readonly (string | RegExp)[];
	/** Only paths ending in one of these extensions (e.g. `[".md", ".ts"]`). */
	extensions?: readonly string[];
	/** Only paths matching one of these (substring or RegExp). */
	include?: readonly (string | RegExp)[];
	/** Largest file loaded, in bytes. Default 1 MiB. */
	maxFileBytes?: number;
	/** Most files loaded. Default 200. */
	maxFiles?: number;
	/** Repository owner. */
	owner: string;
	/** Only files under this directory (e.g. `docs`). */
	path?: string;
	/** Branch, tag, or commit. Defaults to the repository's default branch. */
	ref?: string;
	/** Repository name. */
	repo: string;
	/** Personal access or installation token (optional for public repos). */
	token?: CredentialSource;
}

interface TreeEntry {
	path: string;
	sha: string;
	size: number;
}

const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/** A GitHub owner or repo name; `.` and `..` would rewrite the API path. */
function isPlainName(value: string): boolean {
	return NAME_PATTERN.test(value) && value !== "." && value !== "..";
}

function matchesAny(
	path: string,
	patterns: readonly (string | RegExp)[]
): boolean {
	return patterns.some((pattern) =>
		typeof pattern === "string" ? path.includes(pattern) : pattern.test(path)
	);
}

function readTree(value: unknown): {
	entries: TreeEntry[];
	truncated: boolean;
} {
	if (!(value && typeof value === "object" && "tree" in value)) {
		throw new LoaderError("GitHub returned an unexpected tree response");
	}
	const tree = Array.isArray(value.tree) ? (value.tree as unknown[]) : [];
	const entries: TreeEntry[] = [];
	for (const item of tree) {
		if (
			item &&
			typeof item === "object" &&
			"type" in item &&
			item.type === "blob" &&
			"path" in item &&
			typeof item.path === "string" &&
			"sha" in item &&
			typeof item.sha === "string"
		) {
			const size =
				"size" in item && typeof item.size === "number" ? item.size : 0;
			entries.push({ path: item.path, sha: item.sha, size });
		}
	}
	return {
		entries,
		truncated: "truncated" in value && value.truncated === true,
	};
}

function looksBinary(bytes: Uint8Array): boolean {
	const sample = bytes.subarray(0, 8000);
	return sample.includes(0);
}

/**
 * Load text files from a GitHub repository.
 *
 * ```ts
 * const docs = await new GitHubRepoLoader({
 *   owner: "acme",
 *   repo: "handbook",
 *   path: "docs",
 *   extensions: [".md", ".mdx"],
 *   token: process.env.GITHUB_TOKEN,
 * }).load();
 * ```
 */
export class GitHubRepoLoader extends BaseLoader {
	readonly #options: GitHubRepoLoaderOptions;

	constructor(options: GitHubRepoLoaderOptions) {
		super();
		if (!(isPlainName(options.owner) && isPlainName(options.repo))) {
			throw new LoaderError("GitHub owner and repo must be plain names");
		}
		this.#options = options;
	}

	async #headers(accept: string): Promise<Record<string, string>> {
		const headers: Record<string, string> = {
			accept,
			"x-github-api-version": "2022-11-28",
		};
		const token = await resolveCredential(this.#options.token, "GitHub");
		if (token) {
			headers.authorization = `Bearer ${token}`;
		}
		return headers;
	}

	#api(path: string): string {
		const root = (this.#options.apiUrl ?? "https://api.github.com").replace(
			/\/+$/,
			""
		);
		const { owner, repo } = this.#options;
		return `${root}/repos/${owner}/${repo}${path}`;
	}

	async #ref(): Promise<string> {
		if (this.#options.ref) {
			return this.#options.ref;
		}
		const repository = await fetchJson(
			this.#api(""),
			{ headers: await this.#headers("application/vnd.github+json") },
			this.#options
		);
		const branch =
			repository &&
			typeof repository === "object" &&
			"default_branch" in repository
				? repository.default_branch
				: undefined;
		if (typeof branch !== "string") {
			throw new LoaderError("GitHub returned no default branch");
		}
		return branch;
	}

	/** The files that would be loaded, after filtering. */
	async files(): Promise<{
		entries: TreeEntry[];
		ref: string;
		truncated: boolean;
	}> {
		const options = this.#options;
		const ref = await this.#ref();
		const tree = readTree(
			await fetchJson(
				this.#api(`/git/trees/${encodeURIComponent(ref)}?recursive=1`),
				{ headers: await this.#headers("application/vnd.github+json") },
				options
			)
		);
		const prefix = options.path?.replace(/^\/+|\/+$/g, "");
		const maxBytes = options.maxFileBytes ?? 1024 * 1024;
		const extensions = options.extensions?.map((extension) =>
			extension.toLowerCase()
		);
		const entries = tree.entries
			.filter(
				(entry) =>
					!prefix ||
					entry.path === prefix ||
					entry.path.startsWith(`${prefix}/`)
			)
			.filter((entry) => entry.size <= maxBytes)
			.filter(
				(entry) =>
					!extensions?.length ||
					extensions.some((extension) =>
						entry.path.toLowerCase().endsWith(extension)
					)
			)
			.filter(
				(entry) =>
					!options.include?.length || matchesAny(entry.path, options.include)
			)
			.filter(
				(entry) =>
					!(options.exclude?.length && matchesAny(entry.path, options.exclude))
			)
			.slice(0, options.maxFiles ?? 200);
		return { entries, ref, truncated: tree.truncated };
	}

	async *lazyLoad(): AsyncIterable<LoadedDocument> {
		const options = this.#options;
		const { entries, ref } = await this.files();
		const web = (options.apiUrl ?? "https://api.github.com")
			.replace("://api.github.com", "://github.com")
			.replace(/\/api\/v3\/?$/, "");
		for (const entry of entries) {
			const encodedPath = entry.path
				.split("/")
				.map(encodeURIComponent)
				.join("/");
			const { bytes } = await fetchBytes(
				this.#api(`/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`),
				{ headers: await this.#headers("application/vnd.github.raw") },
				{ ...options, maxBytes: options.maxFileBytes ?? 1024 * 1024 }
			);
			if (looksBinary(bytes)) {
				continue;
			}
			yield {
				content: new TextDecoder().decode(bytes),
				metadata: {
					source: `${web}/${options.owner}/${options.repo}/blob/${ref}/${entry.path}`,
					loader: "github",
					repository: `${options.owner}/${options.repo}`,
					ref,
					path: entry.path,
					sha: entry.sha,
				},
			};
		}
	}
}
