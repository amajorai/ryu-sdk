/**
 * RSS 2.0, RSS 1.0 (RDF), and Atom feeds.
 *
 * Each entry becomes a document whose content is the entry's full content (or
 * summary) converted from HTML to Markdown. With `loadArticles`, the linked page
 * is fetched instead and loaded through {@link loadWebPage}.
 */

import { htmlToMarkdown } from "./html.ts";
import { fetchText } from "./net.ts";
import { BaseLoader, type LoadedDocument, LoaderError } from "./types.ts";
import { loadWebPage, type WebPageLoaderOptions } from "./web.ts";
import {
	childElement,
	childElements,
	elementText,
	localName,
	parseXml,
	type XmlElement,
} from "./xml.ts";

/** Options for {@link FeedLoader}. */
export interface FeedLoaderOptions extends WebPageLoaderOptions {
	/** Fetch each entry's link and load the full page. Default `false`. */
	loadArticles?: boolean;
	/** Most entries loaded per feed. Default 50. */
	maxItems?: number;
}

/** One parsed feed entry. */
export interface FeedEntry {
	author?: string;
	categories: string[];
	contentHtml: string;
	id?: string;
	link?: string;
	published?: string;
	title: string;
}

/** A parsed feed. */
export interface ParsedFeed {
	entries: FeedEntry[];
	format: "rss" | "atom" | "rdf";
	title: string;
}

function text(element: XmlElement, name: string): string {
	return elementText(childElement(element, name)).trim();
}

function atomLink(entry: XmlElement): string | undefined {
	const links = childElements(entry, "link");
	const alternate =
		links.find(
			(link) => (link.attributes.rel ?? "alternate") === "alternate"
		) ?? links[0];
	return alternate?.attributes.href;
}

function rssEntry(item: XmlElement): FeedEntry {
	const entry: FeedEntry = {
		title: text(item, "title"),
		contentHtml:
			elementText(childElement(item, "content:encoded")) ||
			text(item, "description"),
		categories: childElements(item, "category").map((category) =>
			elementText(category).trim()
		),
	};
	const link = text(item, "link") || item.attributes["rdf:about"];
	if (link) {
		entry.link = link;
	}
	const id = text(item, "guid");
	if (id) {
		entry.id = id;
	}
	const published = text(item, "pubDate") || text(item, "dc:date");
	if (published) {
		entry.published = published;
	}
	const author = text(item, "dc:creator") || text(item, "author");
	if (author) {
		entry.author = author;
	}
	return entry;
}

function atomEntry(item: XmlElement): FeedEntry {
	const entry: FeedEntry = {
		title: text(item, "title"),
		contentHtml:
			elementText(childElement(item, "content")) || text(item, "summary"),
		categories: childElements(item, "category")
			.map(
				(category) =>
					category.attributes.term ?? category.attributes.label ?? ""
			)
			.filter(Boolean),
	};
	const link = atomLink(item);
	if (link) {
		entry.link = link;
	}
	const id = text(item, "id");
	if (id) {
		entry.id = id;
	}
	const published = text(item, "published") || text(item, "updated");
	if (published) {
		entry.published = published;
	}
	const author = childElement(item, "author");
	if (author) {
		entry.author = text(author, "name") || elementText(author).trim();
	}
	return entry;
}

/** Parse an RSS or Atom document. */
export function parseFeed(xml: string): ParsedFeed {
	const root = parseXml(xml);
	if (!root) {
		throw new LoaderError("the feed is not XML");
	}
	const kind = localName(root);
	if (kind === "feed") {
		return {
			format: "atom",
			title: text(root, "title"),
			entries: childElements(root, "entry").map(atomEntry),
		};
	}
	if (kind === "rss") {
		const channel = childElement(root, "channel") ?? root;
		return {
			format: "rss",
			title: text(channel, "title"),
			entries: childElements(channel, "item").map(rssEntry),
		};
	}
	if (kind === "RDF") {
		const channel = childElement(root, "channel");
		return {
			format: "rdf",
			title: channel ? text(channel, "title") : "",
			entries: childElements(root, "item").map(rssEntry),
		};
	}
	throw new LoaderError(`unsupported feed root <${root.name}>`);
}

/**
 * Load RSS or Atom feeds.
 *
 * ```ts
 * const docs = await new FeedLoader("https://example.com/feed.xml").load();
 * ```
 */
export class FeedLoader extends BaseLoader {
	readonly #urls: readonly string[];
	readonly #options: FeedLoaderOptions;

	constructor(
		urls: string | readonly string[],
		options: FeedLoaderOptions = {}
	) {
		super();
		this.#urls = typeof urls === "string" ? [urls] : urls;
		this.#options = options;
	}

	async *lazyLoad(): AsyncIterable<LoadedDocument> {
		const options = this.#options;
		for (const url of this.#urls) {
			const { text: body, url: finalUrl } = await fetchText(
				url,
				{
					headers: {
						accept:
							"application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.5",
					},
				},
				options
			);
			const feed = parseFeed(body);
			const base = finalUrl || url;
			for (const entry of feed.entries.slice(0, options.maxItems ?? 50)) {
				const link = entry.link
					? new URL(entry.link, base).toString()
					: undefined;
				let content = htmlToMarkdown(entry.contentHtml, {
					baseUrl: link ?? base,
				});
				if (options.loadArticles && link) {
					try {
						content = (await loadWebPage(link, options)).content;
					} catch (error) {
						if (!options.continueOnFailure) {
							throw error;
						}
					}
				}
				yield {
					content,
					metadata: {
						source: link ?? base,
						loader: "feed",
						feed: base,
						feedTitle: feed.title,
						title: entry.title,
						id: entry.id ?? null,
						published: entry.published ?? null,
						author: entry.author ?? null,
						categories: entry.categories,
					},
				};
			}
		}
	}
}
