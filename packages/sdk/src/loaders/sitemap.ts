/**
 * A bounded, robots-aware sitemap crawler.
 *
 * Starting from a site root or a sitemap URL, it reads `robots.txt` (for
 * `Sitemap:` lines, `Allow`/`Disallow`, and `Crawl-delay`), walks sitemap
 * indexes breadth-first up to `maxSitemaps`, and loads at most `maxPages` pages
 * through {@link loadWebPage}. Gzipped sitemaps are supported.
 */

import {
	DEFAULT_USER_AGENT,
	fetchBytes,
	fetchGuarded,
	readBodyCapped,
} from "./net.ts";
import {
	ALLOW_ALL_ROBOTS,
	DISALLOW_ALL_ROBOTS,
	parseRobotsTxt,
	type RobotsPolicy,
} from "./robots.ts";
import { BaseLoader, type LoadedDocument, LoaderError } from "./types.ts";
import { loadWebPage, type WebPageLoaderOptions } from "./web.ts";
import {
	childElement,
	childElements,
	elementText,
	localName,
	parseXml,
} from "./xml.ts";

/** Options for {@link SitemapLoader}. */
export interface SitemapLoaderOptions extends WebPageLoaderOptions {
	/** Skip pages whose URL matches one of these (substring or RegExp). */
	exclude?: readonly (string | RegExp)[];
	/** Only pages whose URL matches one of these (substring or RegExp). */
	include?: readonly (string | RegExp)[];
	/** Upper bound on the wait between page fetches, in ms. Default 10 000. */
	maxDelayMs?: number;
	/** Most pages loaded. Default 50. */
	maxPages?: number;
	/** Most sitemap files read, including indexes. Default 10. */
	maxSitemaps?: number;
	/** Minimum wait between page fetches, in ms. Default 0. */
	minDelayMs?: number;
	/** Obey robots.txt. Default `true`. */
	respectRobotsTxt?: boolean;
	/** Only follow sitemap and page URLs on the start URL's host. Default `true`. */
	sameHost?: boolean;
}

/** One `<url>` entry from a sitemap. */
export interface SitemapEntry {
	changefreq?: string;
	lastmod?: string;
	loc: string;
	priority?: number;
}

const SITEMAP_PATH = /sitemap[^/]*\.xml(\.gz)?$|\.xml(\.gz)?$/i;

/** Parse a sitemap or sitemap index body. */
export function parseSitemap(xml: string): {
	pages: SitemapEntry[];
	sitemaps: string[];
} {
	const root = parseXml(xml);
	if (!root) {
		return { pages: [], sitemaps: [] };
	}
	if (localName(root) === "sitemapindex") {
		return {
			pages: [],
			sitemaps: childElements(root, "sitemap")
				.map((entry) => elementText(childElement(entry, "loc")).trim())
				.filter(Boolean),
		};
	}
	const pages: SitemapEntry[] = [];
	for (const entry of childElements(root, "url")) {
		const loc = elementText(childElement(entry, "loc")).trim();
		if (!loc) {
			continue;
		}
		const page: SitemapEntry = { loc };
		const lastmod = elementText(childElement(entry, "lastmod")).trim();
		if (lastmod) {
			page.lastmod = lastmod;
		}
		const changefreq = elementText(childElement(entry, "changefreq")).trim();
		if (changefreq) {
			page.changefreq = changefreq;
		}
		const priority = Number.parseFloat(
			elementText(childElement(entry, "priority"))
		);
		if (Number.isFinite(priority)) {
			page.priority = priority;
		}
		pages.push(page);
	}
	return { pages, sitemaps: [] };
}

function matches(url: string, patterns: readonly (string | RegExp)[]): boolean {
	return patterns.some((pattern) =>
		typeof pattern === "string" ? url.includes(pattern) : pattern.test(url)
	);
}

/** Default ceiling for one decompressed sitemap (the protocol allows 50 MB). */
const MAX_SITEMAP_BYTES = 50 * 1024 * 1024;

/** Inflate a gzipped sitemap, refusing output beyond `maxBytes` (gzip bombs). */
async function gunzip(
	bytes: Uint8Array,
	maxBytes: number
): Promise<Uint8Array> {
	const stream = new Blob([new Uint8Array(bytes)])
		.stream()
		.pipeThrough(new DecompressionStream("gzip"));
	return await readBodyCapped(new Response(stream), maxBytes);
}

function isGzip(bytes: Uint8Array): boolean {
	return bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) {
		return Promise.resolve();
	}
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason ?? new Error("aborted"));
			},
			{ once: true }
		);
	});
}

/**
 * Crawl a site through its sitemap.
 *
 * ```ts
 * const docs = await new SitemapLoader("https://example.com", {
 *   maxPages: 20,
 *   include: ["/docs/"],
 * }).load();
 * ```
 */
export class SitemapLoader extends BaseLoader {
	readonly #start: URL;
	readonly #options: SitemapLoaderOptions;
	readonly #robotsByOrigin = new Map<string, Promise<RobotsPolicy>>();

	constructor(url: string, options: SitemapLoaderOptions = {}) {
		super();
		this.#start = new URL(url);
		this.#options = options;
	}

	/** Read robots.txt for the start URL's origin. */
	robots(): Promise<RobotsPolicy> {
		return this.#robotsFor(this.#start);
	}

	/**
	 * robots.txt policy for `url`'s origin, fetched once per origin. A sitemap
	 * crawled with `sameHost: false` lists pages on other origins, and each
	 * origin's own rules (and Crawl-delay) govern its pages.
	 */
	#robotsFor(url: URL): Promise<RobotsPolicy> {
		const cached = this.#robotsByOrigin.get(url.origin);
		if (cached) {
			return cached;
		}
		const pending = this.#fetchRobots(url);
		this.#robotsByOrigin.set(url.origin, pending);
		// A failed fetch (an aborted signal, a blocked URL) must not stay cached.
		pending.catch(() => {
			if (this.#robotsByOrigin.get(url.origin) === pending) {
				this.#robotsByOrigin.delete(url.origin);
			}
		});
		return pending;
	}

	async #fetchRobots(origin: URL): Promise<RobotsPolicy> {
		const robotsUrl = new URL("/robots.txt", origin);
		let response: Response;
		try {
			response = await fetchGuarded(robotsUrl, {}, this.#options);
		} catch (error) {
			if (error instanceof LoaderError) {
				throw error;
			}
			// RFC 9309 §2.3.1.4: an unreachable robots.txt (network error or
			// timeout) means complete disallow, the same as a 5xx.
			return DISALLOW_ALL_ROBOTS;
		}
		if (response.status >= 500) {
			await response.body?.cancel();
			return DISALLOW_ALL_ROBOTS;
		}
		if (!response.ok) {
			await response.body?.cancel();
			return ALLOW_ALL_ROBOTS;
		}
		const bytes = await readBodyCapped(response, 512 * 1024);
		return parseRobotsTxt(new TextDecoder().decode(bytes));
	}

	/** Discover page entries without loading the pages. */
	async entries(robots?: RobotsPolicy): Promise<SitemapEntry[]> {
		const options = this.#options;
		const policy = robots ?? (await this.robots());
		this.#robotsByOrigin.set(this.#start.origin, Promise.resolve(policy));
		const maxSitemaps = options.maxSitemaps ?? 10;
		const maxPages = options.maxPages ?? 50;
		const queue: string[] = SITEMAP_PATH.test(this.#start.pathname)
			? [this.#start.toString()]
			: [...policy.sitemaps];
		if (queue.length === 0) {
			queue.push(new URL("/sitemap.xml", this.#start).toString());
		}
		const seenSitemaps = new Set<string>();
		const seenPages = new Set<string>();
		const pages: SitemapEntry[] = [];
		while (
			queue.length > 0 &&
			seenSitemaps.size < maxSitemaps &&
			pages.length < maxPages
		) {
			const next = queue.shift();
			if (!next || seenSitemaps.has(next) || !this.#onHost(next)) {
				continue;
			}
			seenSitemaps.add(next);
			let xml: string;
			try {
				const { bytes } = await fetchBytes(next, {}, options);
				xml = new TextDecoder().decode(
					isGzip(bytes)
						? await gunzip(bytes, options.maxBytes ?? MAX_SITEMAP_BYTES)
						: bytes
				);
			} catch (error) {
				// One unreadable child sitemap need not end the crawl when the
				// caller asked to skip failures.
				if (options.continueOnFailure) {
					continue;
				}
				throw error;
			}
			const parsed = parseSitemap(xml);
			queue.push(...parsed.sitemaps);
			for (const page of parsed.pages) {
				if (pages.length >= maxPages) {
					break;
				}
				if (seenPages.has(page.loc) || !(await this.#wanted(page.loc))) {
					continue;
				}
				seenPages.add(page.loc);
				pages.push(page);
			}
		}
		return pages;
	}

	async *lazyLoad(): AsyncIterable<LoadedDocument> {
		const options = this.#options;
		const policy = await this.robots();
		const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
		const delayFor = async (loc: string): Promise<number> => {
			const robotsDelay =
				options.respectRobotsTxt === false
					? 0
					: ((await this.#robotsFor(new URL(loc))).crawlDelay(userAgent) ?? 0) *
						1000;
			return Math.min(
				Math.max(options.minDelayMs ?? 0, robotsDelay),
				options.maxDelayMs ?? 10_000
			);
		};
		let first = true;
		for (const entry of await this.entries(policy)) {
			if (!first) {
				await sleep(await delayFor(entry.loc), options.signal);
			}
			first = false;
			let document: LoadedDocument;
			try {
				document = await loadWebPage(entry.loc, options);
			} catch (error) {
				if (options.continueOnFailure) {
					continue;
				}
				throw error;
			}
			document.metadata.loader = "sitemap";
			if (entry.lastmod) {
				document.metadata.lastmod = entry.lastmod;
			}
			if (entry.changefreq) {
				document.metadata.changefreq = entry.changefreq;
			}
			if (entry.priority !== undefined) {
				document.metadata.priority = entry.priority;
			}
			yield document;
		}
	}

	#onHost(url: string): boolean {
		if (this.#options.sameHost === false) {
			return true;
		}
		try {
			return new URL(url).host === this.#start.host;
		} catch {
			return false;
		}
	}

	async #wanted(url: string): Promise<boolean> {
		const options = this.#options;
		if (!this.#onHost(url)) {
			return false;
		}
		if (options.include?.length && !matches(url, options.include)) {
			return false;
		}
		if (options.exclude?.length && matches(url, options.exclude)) {
			return false;
		}
		if (options.respectRobotsTxt === false) {
			return true;
		}
		let origin: URL;
		try {
			origin = new URL(url);
		} catch {
			return false;
		}
		const policy = await this.#robotsFor(origin);
		return policy.isAllowed(url, options.userAgent ?? DEFAULT_USER_AGENT);
	}
}
