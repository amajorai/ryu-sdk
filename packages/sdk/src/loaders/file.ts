/**
 * Local files and directories.
 *
 * Text families (`.md`, `.txt`, `.json`, source code, …) are read directly and
 * HTML is converted to Markdown. Binary documents (PDF, Word, PowerPoint, Excel,
 * EPUB, …) go to a {@link DocumentParser}; {@link coreDocumentParser} uses the
 * `document.parse` capability of a Ryu node, so the same parser that reads
 * chat attachments and Space uploads reads your files.
 */

import { htmlToMarkdown } from "./html.ts";
import {
	type CoreTarget,
	coreBase,
	coreHeaders,
	type LoaderFetch,
} from "./net.ts";
import { BaseLoader, type LoadedDocument, LoaderError } from "./types.ts";

/** Converts a binary document to Markdown. */
export type DocumentParser = (
	bytes: Uint8Array,
	filename: string,
	mimeType?: string
) => Promise<string>;

/** Options for {@link coreDocumentParser}. */
export interface CoreDocumentParserOptions extends CoreTarget {
	/** How often to poll a queued parse, in ms. Default 500. */
	pollIntervalMs?: number;
	/** Give up after this long, in ms. Default 120 000. */
	timeoutMs?: number;
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
	return record(await response.json().catch(() => null));
}

/**
 * A {@link DocumentParser} backed by a Ryu node.
 *
 * Submits the bytes to `POST /api/documents/parse` and polls
 * `GET /api/documents/parse/jobs/:id` until the bound provider finishes. Text
 * formats are answered by Core directly; PDF and Office formats need a
 * `document.parse` provider app on the node.
 */
export function coreDocumentParser(
	options: CoreDocumentParserOptions
): DocumentParser {
	const doFetch: LoaderFetch =
		options.fetch ?? ((url, init) => fetch(url, init));
	const base = coreBase(options);
	const pollInterval = options.pollIntervalMs ?? 500;
	const timeout = options.timeoutMs ?? 120_000;
	return async (bytes, filename) => {
		const submitted = await doFetch(`${base}/api/documents/parse`, {
			method: "POST",
			headers: {
				...coreHeaders(options),
				"content-type": "application/octet-stream",
				"x-filename": encodeURIComponent(filename),
			},
			body: new Blob([new Uint8Array(bytes)]),
		});
		let body = await readJson(submitted);
		if (!submitted.ok) {
			throw new LoaderError(
				`Core could not parse ${filename}: ${String(body.error ?? `HTTP ${submitted.status}`)}`,
				submitted.status
			);
		}
		const deadline = Date.now() + timeout;
		const jobId = typeof body.job_id === "string" ? body.job_id : undefined;
		while (!TERMINAL.has(String(body.status))) {
			if (!jobId) {
				throw new LoaderError(
					`Core accepted ${filename} but returned no job id`
				);
			}
			if (Date.now() > deadline) {
				throw new LoaderError(
					`Core did not finish parsing ${filename} in time`
				);
			}
			await new Promise((resolve) => setTimeout(resolve, pollInterval));
			const polled = await doFetch(
				`${base}/api/documents/parse/jobs/${encodeURIComponent(jobId)}`,
				{ headers: coreHeaders(options) }
			);
			body = await readJson(polled);
			if (!(polled.ok || TERMINAL.has(String(body.status)))) {
				throw new LoaderError(
					`Core lost the parse of ${filename}: ${String(body.error ?? `HTTP ${polled.status}`)}`,
					polled.status
				);
			}
		}
		if (body.status !== "succeeded" || typeof body.markdown !== "string") {
			throw new LoaderError(
				`Core could not parse ${filename}: ${String(body.error ?? body.status)}`
			);
		}
		return body.markdown;
	};
}

/** Extensions read as text without a parser. */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
	".c",
	".cc",
	".cfg",
	".conf",
	".cpp",
	".cs",
	".css",
	".csv",
	".go",
	".h",
	".hpp",
	".ini",
	".java",
	".js",
	".json",
	".jsonl",
	".jsx",
	".kt",
	".log",
	".markdown",
	".md",
	".mdx",
	".ndjson",
	".org",
	".php",
	".py",
	".rb",
	".rs",
	".rst",
	".scala",
	".sh",
	".sql",
	".svelte",
	".swift",
	".text",
	".toml",
	".ts",
	".tsv",
	".tsx",
	".txt",
	".vue",
	".xml",
	".yaml",
	".yml",
]);
const HTML_EXTENSIONS = new Set([".html", ".htm", ".xhtml"]);

function extensionOf(path: string): string {
	const name = path.slice(
		Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1
	);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

/** Options for {@link LocalFileLoader}. */
export interface LocalFileLoaderOptions {
	/** Use a Ryu node's `document.parse` capability for binary documents. */
	core?: CoreDocumentParserOptions;
	/** Only files with these extensions (e.g. `[".md", ".pdf"]`). */
	extensions?: readonly string[];
	/** Largest file read, in bytes. Default 50 MiB. */
	maxFileBytes?: number;
	/** Most files loaded from directories. Default 1 000. */
	maxFiles?: number;
	/** Converts binary documents; overrides `core`. */
	parser?: DocumentParser;
	/** Descend into sub-directories. Default `true`. */
	recursive?: boolean;
	/** Skip files no parser can read instead of failing. Default `false`. */
	skipUnsupported?: boolean;
}

/**
 * Load local files, or every file under local directories.
 *
 * ```ts
 * const docs = await new LocalFileLoader(["./handbook", "./q3-report.pdf"], {
 *   core: { baseUrl: "http://127.0.0.1:7980", token: process.env.RYU_CORE_TOKEN },
 * }).load();
 * ```
 */
export class LocalFileLoader extends BaseLoader {
	readonly #paths: readonly string[];
	readonly #options: LocalFileLoaderOptions;
	readonly #parser: DocumentParser | undefined;

	constructor(
		paths: string | readonly string[],
		options: LocalFileLoaderOptions = {}
	) {
		super();
		this.#paths = typeof paths === "string" ? [paths] : paths;
		this.#options = options;
		this.#parser =
			options.parser ??
			(options.core ? coreDocumentParser(options.core) : undefined);
	}

	/** The files that would be loaded, with directories expanded. */
	async files(): Promise<string[]> {
		const { readdir, realpath, stat } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const maxFiles = this.#options.maxFiles ?? 1000;
		const wanted = this.#options.extensions?.map((extension) =>
			extension.toLowerCase()
		);
		const out: string[] = [];
		// Real paths of directories already walked, so a symlink cycle
		// (`docs/loop -> ..`) cannot recurse forever.
		const walked = new Set<string>();
		const visit = async (path: string, top: boolean): Promise<void> => {
			if (out.length >= maxFiles) {
				return;
			}
			const info = await stat(path);
			if (info.isDirectory()) {
				if (!(top || this.#options.recursive !== false)) {
					return;
				}
				const real = await realpath(path);
				if (walked.has(real)) {
					return;
				}
				walked.add(real);
				const entries = await readdir(path);
				entries.sort();
				for (const entry of entries) {
					if (!entry.startsWith(".")) {
						await visit(join(path, entry), false);
					}
				}
				return;
			}
			if (
				info.isFile() &&
				(!wanted?.length || wanted.includes(extensionOf(path)))
			) {
				out.push(path);
			}
		};
		for (const path of this.#paths) {
			await visit(path, true);
		}
		return out;
	}

	async #read(path: string): Promise<string | undefined> {
		const { readFile, stat } = await import("node:fs/promises");
		const limit = this.#options.maxFileBytes ?? 50 * 1024 * 1024;
		const size = (await stat(path)).size;
		if (size > limit) {
			throw new LoaderError(`${path} is ${size} bytes; the limit is ${limit}`);
		}
		const extension = extensionOf(path);
		if (TEXT_EXTENSIONS.has(extension)) {
			return readFile(path, "utf8");
		}
		if (HTML_EXTENSIONS.has(extension)) {
			return htmlToMarkdown(await readFile(path, "utf8"));
		}
		if (!this.#parser) {
			if (this.#options.skipUnsupported) {
				return;
			}
			throw new LoaderError(
				`no parser for ${extension || "this file"} (${path}); pass \`core\` or \`parser\``
			);
		}
		const name = path.slice(
			Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1
		);
		try {
			return await this.#parser(new Uint8Array(await readFile(path)), name);
		} catch (error) {
			if (this.#options.skipUnsupported) {
				return;
			}
			throw error;
		}
	}

	async *lazyLoad(): AsyncIterable<LoadedDocument> {
		const { resolve } = await import("node:path");
		for (const path of await this.files()) {
			const content = await this.#read(path);
			if (content === undefined) {
				continue;
			}
			yield {
				content,
				metadata: {
					source: resolve(path),
					loader: "file",
					extension: extensionOf(path),
				},
			};
		}
	}
}
