/**
 * HTML to Markdown, without a DOM.
 *
 * A lenient tokenizer builds a tree (void elements, implied `</p>`/`</li>`
 * closes, raw-text `script`/`style`), then a renderer emits CommonMark/GFM:
 * headings, paragraphs, emphasis, links and images (resolved against the page
 * URL), lists with nesting, block quotes, fenced code, and pipe tables.
 * Scripts, styles, forms, and (by default) navigation chrome are dropped.
 */

import { decodeXmlEntities } from "./xml.ts";

interface HtmlText {
	type: "text";
	value: string;
}

interface HtmlElement {
	attributes: Record<string, string>;
	children: HtmlNode[];
	tag: string;
	type: "element";
}

type HtmlNode = HtmlElement | HtmlText;

/** Options for {@link htmlToMarkdown}. */
export interface HtmlToMarkdownOptions {
	/** Resolve relative links and images against this URL. */
	baseUrl?: string;
	/** Keep `nav`, `header`, `footer`, and `aside` content. Default `false`. */
	keepNavigation?: boolean;
}

/** Page-level facts pulled from the HTML head. */
export interface HtmlPageInfo {
	description?: string;
	language?: string;
	title?: string;
}

const VOID_TAGS = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title"]);
const DROPPED_TAGS = new Set([
	"button",
	"canvas",
	"form",
	"head",
	"iframe",
	"noscript",
	"object",
	"script",
	"select",
	"style",
	"svg",
	"template",
	"textarea",
]);
const NAVIGATION_TAGS = new Set(["aside", "footer", "header", "nav"]);
const BLOCK_TAGS = new Set([
	"address",
	"article",
	"blockquote",
	"body",
	"dd",
	"details",
	"div",
	"dl",
	"dt",
	"fieldset",
	"figcaption",
	"figure",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"hr",
	"html",
	"li",
	"main",
	"ol",
	"p",
	"pre",
	"section",
	"summary",
	"table",
	"ul",
	...NAVIGATION_TAGS,
]);
/** Opening one of these implicitly closes an open `<p>`. */
const CLOSES_PARAGRAPH = new Set([
	"address",
	"article",
	"aside",
	"blockquote",
	"div",
	"dl",
	"fieldset",
	"footer",
	"form",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"header",
	"hr",
	"main",
	"nav",
	"ol",
	"p",
	"pre",
	"section",
	"table",
	"ul",
]);
const TAG_NAME = /^\/?\s*([a-zA-Z][a-zA-Z0-9:-]*)/;
const HTML_ATTRIBUTE =
	/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const HTML_ENTITY = /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi;
const WHITESPACE = /\s+/g;
const HEADING = /^h([1-6])$/;
const UNSAFE_LINK = /^\s*(javascript|vbscript|data):/i;
const MARKDOWN_SPECIAL = /([\\`*_[\]])/g;
const BLANK_RUNS = /\n{3,}/g;
const TRAILING_SPACE = /[ \t]+\n/g;

const EXTRA_ENTITIES: Record<string, string> = {
	copy: "©",
	hellip: "…",
	laquo: "«",
	ldquo: "“",
	lsquo: "‘",
	mdash: "—",
	middot: "·",
	nbsp: " ",
	ndash: "–",
	raquo: "»",
	rdquo: "”",
	reg: "®",
	rsquo: "’",
	trade: "™",
};

function decodeHtmlEntities(value: string): string {
	return value.replace(HTML_ENTITY, (match, entity: string) => {
		const named = EXTRA_ENTITIES[entity.toLowerCase()];
		if (named !== undefined) {
			return named;
		}
		return decodeXmlEntities(`&${entity};`) === `&${entity};`
			? match
			: decodeXmlEntities(`&${entity};`);
	});
}

function parseHtmlAttributes(source: string): Record<string, string> {
	const attributes: Record<string, string> = {};
	for (const match of source.matchAll(HTML_ATTRIBUTE)) {
		const [, name, double, single, bare] = match;
		if (name) {
			attributes[name.toLowerCase()] = decodeHtmlEntities(
				double ?? single ?? bare ?? ""
			);
		}
	}
	return attributes;
}

function closeTag(stack: HtmlElement[], tag: string): void {
	const at = stack.findLastIndex((element) => element.tag === tag);
	if (at > 0) {
		stack.length = at;
	}
}

function implicitClose(stack: HtmlElement[], tag: string): void {
	const top = stack.at(-1);
	if (!top) {
		return;
	}
	if (top.tag === "p" && CLOSES_PARAGRAPH.has(tag)) {
		stack.pop();
	}
	const listItem = tag === "li" ? "li" : undefined;
	const cell = tag === "td" || tag === "th" ? ["td", "th"] : undefined;
	const row = tag === "tr" ? "tr" : undefined;
	const definition = tag === "dt" || tag === "dd" ? ["dt", "dd"] : undefined;
	const closing = [listItem, row, ...(cell ?? []), ...(definition ?? [])];
	const current = stack.at(-1);
	if (current && closing.includes(current.tag)) {
		stack.pop();
	}
	if (row) {
		const inner = stack.at(-1);
		if (inner && (inner.tag === "td" || inner.tag === "th")) {
			stack.pop();
			closeTag(stack, "tr");
		}
	}
}

function parseHtml(html: string): HtmlElement {
	const root: HtmlElement = {
		type: "element",
		tag: "#root",
		attributes: {},
		children: [],
	};
	const stack: HtmlElement[] = [root];
	let index = 0;
	while (index < html.length) {
		const open = html.indexOf("<", index);
		const parent = stack.at(-1) ?? root;
		if (open === -1) {
			parent.children.push({ type: "text", value: html.slice(index) });
			break;
		}
		if (open > index) {
			parent.children.push({ type: "text", value: html.slice(index, open) });
		}
		if (html.startsWith("<!--", open)) {
			const end = html.indexOf("-->", open + 4);
			index = end === -1 ? html.length : end + 3;
			continue;
		}
		if (html.startsWith("<!", open) || html.startsWith("<?", open)) {
			const end = html.indexOf(">", open);
			index = end === -1 ? html.length : end + 1;
			continue;
		}
		const close = html.indexOf(">", open);
		const nameMatch = TAG_NAME.exec(html.slice(open + 1, open + 64));
		if (close === -1 || !nameMatch?.[1]) {
			parent.children.push({ type: "text", value: "<" });
			index = open + 1;
			continue;
		}
		const tag = nameMatch[1].toLowerCase();
		const raw = html.slice(open + 1, close);
		index = close + 1;
		if (raw.startsWith("/")) {
			closeTag(stack, tag);
			continue;
		}
		implicitClose(stack, tag);
		const element: HtmlElement = {
			type: "element",
			tag,
			attributes: parseHtmlAttributes(raw.slice(nameMatch[0].length)),
			children: [],
		};
		(stack.at(-1) ?? root).children.push(element);
		if (RAW_TEXT_TAGS.has(tag)) {
			const end = html.toLowerCase().indexOf(`</${tag}`, index);
			const stop = end === -1 ? html.length : end;
			element.children.push({ type: "text", value: html.slice(index, stop) });
			const after = html.indexOf(">", stop);
			index = after === -1 ? html.length : after + 1;
			continue;
		}
		if (!(VOID_TAGS.has(tag) || raw.trimEnd().endsWith("/"))) {
			stack.push(element);
		}
	}
	return root;
}

function findElements(
	node: HtmlElement,
	predicate: (element: HtmlElement) => boolean,
	out: HtmlElement[] = []
): HtmlElement[] {
	for (const child of node.children) {
		if (child.type === "element") {
			if (predicate(child)) {
				out.push(child);
			}
			findElements(child, predicate, out);
		}
	}
	return out;
}

function rawText(node: HtmlNode): string {
	if (node.type === "text") {
		return decodeHtmlEntities(node.value);
	}
	return node.children.map(rawText).join("");
}

interface RenderContext {
	baseUrl: string | undefined;
	keepNavigation: boolean;
	listDepth: number;
}

function resolveLink(
	href: string,
	base: string | undefined
): string | undefined {
	if (!href || UNSAFE_LINK.test(href)) {
		return;
	}
	try {
		return base ? new URL(href, base).toString() : href;
	} catch {
		return href;
	}
}

function isDropped(element: HtmlElement, context: RenderContext): boolean {
	if (DROPPED_TAGS.has(element.tag)) {
		return true;
	}
	if (!context.keepNavigation && NAVIGATION_TAGS.has(element.tag)) {
		return true;
	}
	return (
		element.attributes.hidden !== undefined ||
		element.attributes["aria-hidden"] === "true"
	);
}

function renderInline(nodes: HtmlNode[], context: RenderContext): string {
	let out = "";
	for (const node of nodes) {
		out += renderInlineNode(node, context);
	}
	return out;
}

function wrapInline(inner: string, marker: string): string {
	const trimmed = inner.trim();
	if (!trimmed) {
		return inner;
	}
	const lead = inner.startsWith(" ") ? " " : "";
	const tail = inner.endsWith(" ") ? " " : "";
	return `${lead}${marker}${trimmed}${marker}${tail}`;
}

function renderInlineNode(node: HtmlNode, context: RenderContext): string {
	if (node.type === "text") {
		return decodeHtmlEntities(node.value)
			.replace(WHITESPACE, " ")
			.replace(MARKDOWN_SPECIAL, "\\$1");
	}
	if (isDropped(node, context)) {
		return "";
	}
	switch (node.tag) {
		case "br":
			return "\n";
		case "strong":
		case "b":
			return wrapInline(renderInline(node.children, context), "**");
		case "em":
		case "i":
			return wrapInline(renderInline(node.children, context), "*");
		case "del":
		case "s":
		case "strike":
			return wrapInline(renderInline(node.children, context), "~~");
		case "code": {
			const code = rawText(node).replace(WHITESPACE, " ");
			const fence = code.includes("`") ? "``" : "`";
			return code ? `${fence}${code}${fence}` : "";
		}
		case "a": {
			const text = renderInline(node.children, context).trim();
			const href = resolveLink(node.attributes.href ?? "", context.baseUrl);
			if (!href || href.startsWith("#")) {
				return text;
			}
			return text ? `[${text}](${href})` : "";
		}
		case "img": {
			const src = resolveLink(node.attributes.src ?? "", context.baseUrl);
			const alt = (node.attributes.alt ?? "").replace(WHITESPACE, " ").trim();
			return src ? `![${alt}](${src})` : "";
		}
		default:
			if (BLOCK_TAGS.has(node.tag)) {
				return ` ${renderBlocks(node.children, context).replace(WHITESPACE, " ")} `;
			}
			return renderInline(node.children, context);
	}
}

function renderList(element: HtmlElement, context: RenderContext): string {
	const ordered = element.tag === "ol";
	const start = Number.parseInt(element.attributes.start ?? "1", 10) || 1;
	const indent = "  ".repeat(context.listDepth);
	const items: string[] = [];
	let counter = start;
	for (const child of element.children) {
		if (child.type !== "element" || child.tag !== "li") {
			continue;
		}
		const marker = ordered ? `${counter}.` : "-";
		counter += 1;
		const body = renderBlocks(child.children, {
			...context,
			listDepth: context.listDepth + 1,
		});
		const [first = "", ...rest] = body.split("\n");
		const continuation = rest
			.filter((line, at) => line.trim() !== "" || rest[at + 1]?.trim() !== "")
			.map((line) =>
				line.startsWith(`${indent}  `) || line === ""
					? line
					: `${indent}  ${line}`
			);
		items.push(
			[`${indent}${marker} ${first.trim()}`, ...continuation].join("\n")
		);
	}
	return items.join("\n");
}

function renderTable(element: HtmlElement, context: RenderContext): string {
	const rows = findElements(element, (candidate) => candidate.tag === "tr");
	const matrix = rows.map((row) =>
		row.children
			.filter(
				(cell): cell is HtmlElement =>
					cell.type === "element" && (cell.tag === "td" || cell.tag === "th")
			)
			.map((cell) =>
				renderInline(cell.children, context)
					.replace(WHITESPACE, " ")
					.trim()
					.replaceAll("|", "\\|")
			)
	);
	const width = Math.max(0, ...matrix.map((row) => row.length));
	if (width === 0) {
		return "";
	}
	const padded = matrix.map((row) => [
		...row,
		...Array.from({ length: width - row.length }, () => ""),
	]);
	const [header = [], ...body] = padded;
	const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
	return [
		line(header),
		line(Array.from({ length: width }, () => "---")),
		...body.map(line),
	].join("\n");
}

function renderBlockElement(
	element: HtmlElement,
	context: RenderContext
): string {
	const heading = HEADING.exec(element.tag);
	if (heading) {
		const text = renderInline(element.children, context)
			.replace(WHITESPACE, " ")
			.trim();
		return text ? `${"#".repeat(Number(heading[1]))} ${text}` : "";
	}
	switch (element.tag) {
		case "hr":
			return "---";
		case "pre": {
			const code = rawText(element).replace(/^\n/, "").trimEnd();
			const language = (
				element.children.find(
					(child): child is HtmlElement =>
						child.type === "element" && child.tag === "code"
				)?.attributes.class ?? ""
			).match(/language-([\w+-]+)/)?.[1];
			const fence = code.includes("```") ? "~~~~" : "```";
			return `${fence}${language ?? ""}\n${code}\n${fence}`;
		}
		case "ul":
		case "ol":
			return renderList(element, context);
		case "blockquote":
			return renderBlocks(element.children, context)
				.split("\n")
				.map((line) => (line ? `> ${line}` : ">"))
				.join("\n");
		case "table":
			return renderTable(element, context);
		default:
			return renderBlocks(element.children, context);
	}
}

function renderBlocks(nodes: HtmlNode[], context: RenderContext): string {
	const blocks: string[] = [];
	let inline = "";
	const flush = () => {
		const text = inline
			.split("\n")
			.map((line) => line.replace(/ {2,}/g, " ").trim())
			.join("\n")
			.trim();
		if (text) {
			blocks.push(text);
		}
		inline = "";
	};
	for (const node of nodes) {
		if (
			node.type === "element" &&
			BLOCK_TAGS.has(node.tag) &&
			!isDropped(node, context)
		) {
			flush();
			const rendered = renderBlockElement(node, context).trim();
			if (rendered) {
				blocks.push(rendered);
			}
		} else {
			inline += renderInlineNode(node, context);
		}
	}
	flush();
	const listContext = context.listDepth > 0;
	return blocks.join(listContext ? "\n" : "\n\n");
}

/** Convert an HTML document or fragment to Markdown. */
export function htmlToMarkdown(
	html: string,
	options: HtmlToMarkdownOptions = {}
): string {
	const root = parseHtml(html);
	const main =
		findElements(root, (element) => element.tag === "main")[0] ??
		findElements(root, (element) => element.tag === "article")[0] ??
		findElements(root, (element) => element.tag === "body")[0] ??
		root;
	const markdown = renderBlocks(main.children, {
		baseUrl: options.baseUrl,
		keepNavigation: options.keepNavigation ?? false,
		listDepth: 0,
	});
	return markdown
		.replace(TRAILING_SPACE, "\n")
		.replace(BLANK_RUNS, "\n\n")
		.trim();
}

/** Read the `<title>`, meta description, and `<html lang>` of a page. */
export function htmlPageInfo(html: string): HtmlPageInfo {
	const root = parseHtml(html);
	const info: HtmlPageInfo = {};
	const title = findElements(root, (element) => element.tag === "title")[0];
	const titleText = title ? rawText(title).replace(WHITESPACE, " ").trim() : "";
	if (titleText) {
		info.title = titleText;
	}
	const description = findElements(
		root,
		(element) =>
			element.tag === "meta" &&
			(element.attributes.name ?? element.attributes.property ?? "")
				.toLowerCase()
				.match(/^(og:)?description$/) !== null
	)[0]?.attributes.content?.trim();
	if (description) {
		info.description = description;
	}
	const language = findElements(root, (element) => element.tag === "html")[0]
		?.attributes.lang;
	if (language) {
		info.language = language;
	}
	return info;
}
