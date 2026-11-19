/**
 * Web pages as Markdown documents.
 */

import { htmlPageInfo, htmlToMarkdown } from "./html.ts";
import { fetchText, type NetworkOptions } from "./net.ts";
import {
	BaseLoader,
	type LoadedDocument,
	type LoadedDocumentMetadata,
	LoaderError,
} from "./types.ts";

/** Options for {@link WebPageLoader}. */
export interface WebPageLoaderOptions extends NetworkOptions {
	/** Skip a URL that fails instead of failing the whole load. Default `false`. */
	continueOnFailure?: boolean;
	/** Extra request headers (for example a cookie the caller owns). */
	headers?: Record<string, string>;
	/** Keep `nav`, `header`, `footer`, and `aside` content. Default `false`. */
	keepNavigation?: boolean;
}

const HTML_TYPES = ["text/html", "application/xhtml+xml"];
const TEXT_TYPES = ["text/plain", "text/markdown", "text/x-markdown"];

/** Fetch one URL and convert it to a document. */
export async function loadWebPage(
	url: string,
	options: WebPageLoaderOptions = {}
): Promise<LoadedDocument> {
	const response = await fetchText(
		url,
		{
			headers: {
				accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
				...options.headers,
			},
		},
		options
	);
	const type = response.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
	const finalUrl = response.url || url;
	const metadata: LoadedDocumentMetadata = { source: finalUrl, loader: "web" };
	if (TEXT_TYPES.includes(type)) {
		return {
			content: response.text,
			metadata: { ...metadata, contentType: type },
		};
	}
	if (type && !HTML_TYPES.includes(type)) {
		throw new LoaderError(`${url} is ${type}, not an HTML page`);
	}
	const info = htmlPageInfo(response.text);
	if (info.title) {
		metadata.title = info.title;
	}
	if (info.description) {
		metadata.description = info.description;
	}
	if (info.language) {
		metadata.language = info.language;
	}
	return {
		content: htmlToMarkdown(response.text, {
			baseUrl: finalUrl,
			keepNavigation: options.keepNavigation,
		}),
		metadata,
	};
}

/**
 * Load one or more web pages, converting HTML to Markdown.
 *
 * ```ts
 * const docs = await new WebPageLoader(["https://example.com/docs"]).load();
 * ```
 */
export class WebPageLoader extends BaseLoader {
	readonly #urls: readonly string[];
	readonly #options: WebPageLoaderOptions;

	constructor(
		urls: string | readonly string[],
		options: WebPageLoaderOptions = {}
	) {
		super();
		this.#urls = typeof urls === "string" ? [urls] : urls;
		this.#options = options;
	}

	async *lazyLoad(): AsyncIterable<LoadedDocument> {
		for (const url of this.#urls) {
			try {
				yield await loadWebPage(url, this.#options);
			} catch (error) {
				if (!this.#options.continueOnFailure) {
					throw error;
				}
			}
		}
	}
}
