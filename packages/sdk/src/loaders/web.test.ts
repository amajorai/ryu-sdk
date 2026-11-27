import { describe, expect, test } from "bun:test";
import { FeedLoader, parseFeed } from "./feed.ts";
import { parseRobotsTxt } from "./robots.ts";
import { parseSitemap, SitemapLoader } from "./sitemap.ts";
import { mockNetwork, textResponse } from "./test-support.ts";
import { WebPageLoader } from "./web.ts";

const page = (title: string, body: string) =>
	textResponse(
		`<html lang="en"><head><title>${title}</title></head><body><main>${body}</main></body></html>`,
		"text/html; charset=utf-8"
	);

describe("WebPageLoader", () => {
	test("loads pages as Markdown with page metadata", async () => {
		const net = mockNetwork({
			"https://example.com/a": page("Page A", "<h2>Hello</h2><p>World</p>"),
			"https://example.com/notes.txt": textResponse(
				"plain notes",
				"text/plain"
			),
		});
		const docs = await new WebPageLoader(
			["https://example.com/a", "https://example.com/notes.txt"],
			net
		).load();
		expect(docs).toEqual([
			{
				content: "## Hello\n\nWorld",
				metadata: {
					source: "https://example.com/a",
					loader: "web",
					title: "Page A",
					language: "en",
				},
			},
			{
				content: "plain notes",
				metadata: {
					source: "https://example.com/notes.txt",
					loader: "web",
					contentType: "text/plain",
				},
			},
		]);
	});

	test("refuses non-HTML binaries and private targets", async () => {
		const net = mockNetwork({
			"https://example.com/file.zip": textResponse("PK", "application/zip"),
		});
		await expect(
			new WebPageLoader("https://example.com/file.zip", net).load()
		).rejects.toThrow("not an HTML page");
		await expect(
			new WebPageLoader("http://192.168.0.10/", net).load()
		).rejects.toThrow("private address");
	});

	test("continueOnFailure skips failing URLs", async () => {
		const net = mockNetwork({
			"https://example.com/ok": page("OK", "<p>fine</p>"),
		});
		const docs = await new WebPageLoader(
			["https://example.com/missing", "https://example.com/ok"],
			{
				...net,
				continueOnFailure: true,
			}
		).load();
		expect(docs.map((doc) => doc.content)).toEqual(["fine"]);
	});
});

describe("robots.txt", () => {
	const robots = parseRobotsTxt(`
User-agent: *
Disallow: /private/
Allow: /private/public-*.html$
Crawl-delay: 2

User-agent: RyuDocumentLoader
Disallow: /no-ryu/

Sitemap: https://example.com/sitemap_index.xml
`);

	test("uses the most specific user-agent group", () => {
		expect(
			robots.isAllowed("https://example.com/no-ryu/x", "RyuDocumentLoader/1.0")
		).toBe(false);
		expect(
			robots.isAllowed("https://example.com/private/x", "RyuDocumentLoader/1.0")
		).toBe(true);
		expect(robots.isAllowed("https://example.com/private/x", "OtherBot")).toBe(
			false
		);
		expect(robots.crawlDelay("OtherBot")).toBe(2);
	});

	test("longest match wins and $ anchors", () => {
		expect(
			robots.isAllowed("https://example.com/private/public-a.html", "OtherBot")
		).toBe(true);
		expect(
			robots.isAllowed(
				"https://example.com/private/public-a.html?x=1",
				"OtherBot"
			)
		).toBe(false);
		expect(robots.sitemaps).toEqual(["https://example.com/sitemap_index.xml"]);
	});
});

describe("SitemapLoader", () => {
	const index = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap-docs.xml</loc></sitemap>
  <sitemap><loc>https://evil.example.net/sitemap.xml</loc></sitemap>
</sitemapindex>`;
	const docsMap = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/docs/a</loc><lastmod>2026-01-02</lastmod><priority>0.8</priority></url>
  <url><loc>https://example.com/private/b</loc></url>
  <url><loc>https://example.com/docs/c</loc><changefreq>weekly</changefreq></url>
  <url><loc>https://example.com/blog/d</loc></url>
  <url><loc>https://other.example.org/docs/e</loc></url>
</urlset>`;

	test("parses url sets and indexes", () => {
		expect(parseSitemap(index).sitemaps).toHaveLength(2);
		expect(parseSitemap(docsMap).pages[0]).toEqual({
			loc: "https://example.com/docs/a",
			lastmod: "2026-01-02",
			priority: 0.8,
		});
	});

	test("crawls through robots.txt sitemaps, honoring rules, filters, and bounds", async () => {
		const net = mockNetwork({
			"https://example.com/robots.txt": textResponse(
				"User-agent: *\nDisallow: /private/\nSitemap: https://example.com/sitemap_index.xml\n",
				"text/plain"
			),
			"https://example.com/sitemap_index.xml": textResponse(
				index,
				"application/xml"
			),
			"https://example.com/sitemap-docs.xml": textResponse(
				docsMap,
				"application/xml"
			),
			"https://example.com/docs/a": page("A", "<p>alpha</p>"),
			"https://example.com/docs/c": page("C", "<p>gamma</p>"),
		});
		const docs = await new SitemapLoader("https://example.com/", {
			...net,
			exclude: ["/blog/"],
			maxPages: 5,
		}).load();
		expect(docs.map((doc) => [doc.metadata.source, doc.content])).toEqual([
			["https://example.com/docs/a", "alpha"],
			["https://example.com/docs/c", "gamma"],
		]);
		expect(docs[0]?.metadata).toMatchObject({
			loader: "sitemap",
			lastmod: "2026-01-02",
			priority: 0.8,
		});
		expect(docs[1]?.metadata.changefreq).toBe("weekly");
		const fetched = net.requests.map((request) => request.url);
		expect(fetched).not.toContain("https://evil.example.net/sitemap.xml");
		expect(fetched).not.toContain("https://example.com/private/b");
	});

	test("maxPages bounds the crawl and gzip sitemaps are read", async () => {
		const gz = Bun.gzipSync(new TextEncoder().encode(docsMap));
		const net = mockNetwork({
			"https://example.com/robots.txt": new Response("", { status: 404 }),
			"https://example.com/sitemap.xml.gz": new Response(gz, {
				headers: { "content-type": "application/gzip" },
			}),
			"https://example.com/docs/a": page("A", "<p>alpha</p>"),
		});
		const entries = await new SitemapLoader(
			"https://example.com/sitemap.xml.gz",
			{
				...net,
				maxPages: 1,
			}
		).entries();
		expect(entries.map((entry) => entry.loc)).toEqual([
			"https://example.com/docs/a",
		]);
	});

	test("sameHost: false checks each page against its own origin's robots.txt", async () => {
		const net = mockNetwork({
			"https://example.com/robots.txt": new Response("", { status: 404 }),
			"https://other.example.org/robots.txt": textResponse(
				"User-agent: *\nDisallow: /docs/\n",
				"text/plain"
			),
			"https://example.com/sitemap.xml": textResponse(
				docsMap,
				"application/xml"
			),
		});
		const entries = await new SitemapLoader("https://example.com/sitemap.xml", {
			...net,
			sameHost: false,
		}).entries();
		expect(entries.map((entry) => entry.loc)).toEqual([
			"https://example.com/docs/a",
			"https://example.com/private/b",
			"https://example.com/docs/c",
			"https://example.com/blog/d",
		]);
		expect(net.requests.map((request) => request.url)).toContain(
			"https://other.example.org/robots.txt"
		);
	});

	test("an unreachable robots.txt disallows the crawl", async () => {
		const net = mockNetwork({
			"https://example.com/sitemap.xml": textResponse(
				docsMap,
				"application/xml"
			),
		});
		const offline = {
			...net,
			fetch: (url: string, init: RequestInit) =>
				url.endsWith("/robots.txt")
					? Promise.reject(new TypeError("connection reset"))
					: net.fetch(url, init),
		};
		expect(
			await new SitemapLoader("https://example.com/", offline).entries()
		).toEqual([]);
	});

	test("a gzip bomb is refused and a failing child sitemap can be skipped", async () => {
		const index = `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap><loc>https://example.com/bomb.xml.gz</loc></sitemap>
<sitemap><loc>https://example.com/docs.xml</loc></sitemap></sitemapindex>`;
		const bomb = Bun.gzipSync(new Uint8Array(64 * 1024));
		const routes = {
			"https://example.com/robots.txt": new Response("", { status: 404 }),
			"https://example.com/sitemap.xml": textResponse(index, "application/xml"),
			"https://example.com/bomb.xml.gz": new Response(bomb, {
				headers: { "content-type": "application/gzip" },
			}),
			"https://example.com/docs.xml": textResponse(docsMap, "application/xml"),
		};
		await expect(
			new SitemapLoader("https://example.com/sitemap.xml", {
				...mockNetwork(routes),
				maxBytes: 4096,
			}).entries()
		).rejects.toThrow("4096-byte limit");
		const entries = await new SitemapLoader("https://example.com/sitemap.xml", {
			...mockNetwork(routes),
			maxBytes: 4096,
			continueOnFailure: true,
		}).entries();
		expect(entries.length).toBeGreaterThan(0);
	});

	test("a 5xx robots.txt disallows the crawl", async () => {
		const net = mockNetwork({
			"https://example.com/robots.txt": new Response("down", { status: 503 }),
			"https://example.com/sitemap.xml": textResponse(
				docsMap,
				"application/xml"
			),
		});
		expect(
			await new SitemapLoader("https://example.com/", net).entries()
		).toEqual([]);
	});
});

describe("FeedLoader", () => {
	const rss = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>Acme Blog</title>
<item><title>Launch</title><link>https://example.com/launch</link><guid>1</guid>
<pubDate>Tue, 01 Sep 2026 10:00:00 GMT</pubDate><dc:creator>Ada</dc:creator><category>news</category>
<description>short</description><content:encoded><![CDATA[<p>We <b>launched</b>.</p>]]></content:encoded></item>
<item><title>Second</title><link>/second</link><description>&lt;p&gt;Escaped &amp;amp; fine&lt;/p&gt;</description></item>
</channel></rss>`;
	const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Feed</title>
<entry><title>Entry</title><id>urn:1</id><updated>2026-09-01T00:00:00Z</updated>
<link rel="alternate" href="https://example.com/entry"/><author><name>Grace</name></author>
<category term="tech"/><summary type="html">&lt;em&gt;Summary&lt;/em&gt;</summary></entry></feed>`;

	test("parses RSS and Atom", () => {
		const parsedRss = parseFeed(rss);
		expect(parsedRss.format).toBe("rss");
		expect(parsedRss.entries[0]).toMatchObject({
			title: "Launch",
			author: "Ada",
			categories: ["news"],
			contentHtml: "<p>We <b>launched</b>.</p>",
		});
		const parsedAtom = parseFeed(atom);
		expect(parsedAtom.entries[0]).toMatchObject({
			title: "Entry",
			link: "https://example.com/entry",
			author: "Grace",
			categories: ["tech"],
			published: "2026-09-01T00:00:00Z",
		});
	});

	test("loads entries as Markdown documents", async () => {
		const net = mockNetwork({
			"https://example.com/feed.xml": textResponse(rss, "application/rss+xml"),
			"https://example.com/atom.xml": textResponse(
				atom,
				"application/atom+xml"
			),
		});
		const docs = await new FeedLoader(
			["https://example.com/feed.xml", "https://example.com/atom.xml"],
			net
		).load();
		expect(docs.map((doc) => doc.content)).toEqual([
			"We **launched**.",
			"Escaped & fine",
			"*Summary*",
		]);
		expect(docs[1]?.metadata.source).toBe("https://example.com/second");
		expect(docs[0]?.metadata).toMatchObject({
			feedTitle: "Acme Blog",
			author: "Ada",
			loader: "feed",
		});
	});

	test("loadArticles fetches the linked page", async () => {
		const net = mockNetwork({
			"https://example.com/atom.xml": textResponse(
				atom,
				"application/atom+xml"
			),
			"https://example.com/entry": page("Entry", "<p>Full article</p>"),
		});
		const docs = await new FeedLoader("https://example.com/atom.xml", {
			...net,
			loadArticles: true,
		}).load();
		expect(docs[0]?.content).toBe("Full article");
	});
});
