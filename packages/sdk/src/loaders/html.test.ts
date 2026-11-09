import { describe, expect, test } from "bun:test";
import { htmlPageInfo, htmlToMarkdown } from "./html.ts";

describe("htmlToMarkdown", () => {
	test("converts headings, paragraphs, emphasis, and links", () => {
		const markdown = htmlToMarkdown(
			`<html><body><nav><a href="/">Home</a></nav><main>
			<h1>Guide</h1><p>Read <strong>this</strong> and <em>that</em>, then
			<a href="/next">continue</a>.</p><p>Second&nbsp;line<br>wrapped &amp; done</p>
			</main><footer>© Acme</footer></body></html>`,
			{ baseUrl: "https://example.com/docs/" }
		);
		expect(markdown).toBe(
			"# Guide\n\nRead **this** and *that*, then [continue](https://example.com/next).\n\nSecond line\nwrapped & done"
		);
	});

	test("renders nested lists, code, quotes, and tables", () => {
		const markdown = htmlToMarkdown(`<body>
			<ul><li>One<ul><li>Nested</li></ul></li><li>Two</li></ul>
			<ol start="3"><li>Three<li>Four</ol>
			<pre><code class="language-ts">const a = 1;
const b = 2;</code></pre>
			<blockquote><p>Quoted</p></blockquote>
			<table><tr><th>Name</th><th>Qty</th></tr><tr><td>A|B</td><td>2</td></tr></table>
			<p>Use <code>npm i</code> now</p>
		</body>`);
		expect(markdown).toBe(
			[
				"- One\n  - Nested\n- Two",
				"3. Three\n4. Four",
				"```ts\nconst a = 1;\nconst b = 2;\n```",
				"> Quoted",
				"| Name | Qty |\n| --- | --- |\n| A\\|B | 2 |",
				"Use `npm i` now",
			].join("\n\n")
		);
	});

	test("drops scripts, styles, forms, hidden content, and unsafe links", () => {
		const markdown = htmlToMarkdown(
			`<p>Visible</p><script>alert("x")</script><style>p{}</style>
			<form><input name="q"><button>Go</button></form>
			<div hidden>secret</div><a href="javascript:alert(1)">click</a>
			<img src="/logo.png" alt="Logo">`,
			{ baseUrl: "https://example.com" }
		);
		expect(markdown).toBe(
			"Visible\n\nclick ![Logo](https://example.com/logo.png)"
		);
	});

	test("keeps navigation when asked", () => {
		expect(
			htmlToMarkdown("<nav>Menu</nav><p>Body</p>", { keepNavigation: true })
		).toBe("Menu\n\nBody");
	});

	test("escapes Markdown control characters in text", () => {
		expect(htmlToMarkdown("<p>2 * 3 = [6]</p>")).toBe("2 \\* 3 = \\[6\\]");
	});
});

describe("htmlPageInfo", () => {
	test("reads title, description, and language", () => {
		expect(
			htmlPageInfo(
				`<html lang="en"><head><title> Docs &amp; More </title>
				<meta name="description" content="All the docs"></head><body></body></html>`
			)
		).toEqual({
			title: "Docs & More",
			description: "All the docs",
			language: "en",
		});
	});
});
