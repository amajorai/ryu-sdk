/**
 * Notion pages and databases through the public REST API (version 2022-06-28).
 *
 * A page becomes one Markdown document built from its block tree. A database
 * becomes one document per row: the row's page content as Markdown, and its
 * properties flattened into metadata. Use an internal-integration token, or an
 * OAuth access token, that the pages are shared with.
 */

import {
	type CredentialSource,
	fetchJson,
	type NetworkOptions,
	resolveCredential,
} from "./net.ts";
import {
	BaseLoader,
	type LoadedDocument,
	LoaderError,
	type LoaderMetadataValue,
} from "./types.ts";

/** Options for {@link NotionLoader}. */
export interface NotionLoaderOptions extends NetworkOptions {
	/** API root. Default `https://api.notion.com`. */
	apiUrl?: string;
	/** Database ids or URLs; each row becomes a document. */
	databaseIds?: readonly string[];
	/** Load each database row's page content. Default `true`. */
	loadRowContent?: boolean;
	/** Most blocks read per page, across nesting. Default 2 000. */
	maxBlocks?: number;
	/** Deepest nested block level read. Default 5. */
	maxDepth?: number;
	/** Most rows read per database. Default 500. */
	maxRows?: number;
	/** Page ids or URLs; each becomes a document. */
	pageIds?: readonly string[];
	/** Integration or OAuth token. */
	token: CredentialSource;
}

type JsonObject = Record<string, unknown>;

const NOTION_VERSION = "2022-06-28";
const ID_PATTERN = /([0-9a-f]{32})(?:[?#].*)?$/i;
const DASHED_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** Normalize a Notion id or page URL to the dashed UUID form. */
export function notionId(value: string): string {
	const trimmed = value.trim();
	if (DASHED_ID.test(trimmed)) {
		return trimmed.toLowerCase();
	}
	const compact = ID_PATTERN.exec(trimmed.replaceAll("-", ""))?.[1];
	if (!compact) {
		throw new LoaderError(`not a Notion id or URL: ${value}`);
	}
	const hex = compact.toLowerCase();
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Render a Notion rich-text array as Markdown. */
export function notionRichText(value: unknown): string {
	let out = "";
	for (const part of asArray(value)) {
		if (!isObject(part)) {
			continue;
		}
		const raw = asString(part.plain_text) ?? "";
		let text = raw.trim();
		if (!text) {
			out += raw;
			continue;
		}
		const annotations = isObject(part.annotations) ? part.annotations : {};
		if (annotations.code === true) {
			text = `\`${text}\``;
		}
		if (annotations.bold === true) {
			text = `**${text}**`;
		}
		if (annotations.italic === true) {
			text = `*${text}*`;
		}
		if (annotations.strikethrough === true) {
			text = `~~${text}~~`;
		}
		const href = asString(part.href);
		if (href) {
			text = `[${text}](${href})`;
		}
		// Keep surrounding spaces outside the markers: `** bold**` is not bold.
		const lead = raw.length - raw.trimStart().length;
		const tail = raw.length - raw.trimEnd().length;
		out += `${raw.slice(0, lead)}${text}${raw.slice(raw.length - tail)}`;
	}
	return out;
}

function fileUrl(value: unknown): string | undefined {
	if (!isObject(value)) {
		return;
	}
	const external = isObject(value.external)
		? asString(value.external.url)
		: undefined;
	const hosted = isObject(value.file) ? asString(value.file.url) : undefined;
	return external ?? hosted ?? asString(value.url);
}

/** A Notion block with its already-loaded children. */
export interface NotionBlockNode {
	block: JsonObject;
	children: NotionBlockNode[];
}

function renderTable(node: NotionBlockNode): string {
	const rows = node.children
		.filter((child) => child.block.type === "table_row")
		.map((child) => {
			const row = isObject(child.block.table_row) ? child.block.table_row : {};
			return asArray(row.cells).map((cell) =>
				notionRichText(cell).replaceAll("|", "\\|").replaceAll("\n", " ")
			);
		});
	if (rows.length === 0) {
		return "";
	}
	const width = Math.max(...rows.map((row) => row.length));
	const line = (cells: string[]) =>
		`| ${[...cells, ...Array.from({ length: width - cells.length }, () => "")].join(" | ")} |`;
	const [header = [], ...body] = rows;
	return [
		line(header),
		line(Array.from({ length: width }, () => "---")),
		...body.map(line),
	].join("\n");
}

function indentLines(text: string, prefix: string): string {
	return text
		.split("\n")
		.map((line) => (line ? `${prefix}${line}` : line))
		.join("\n");
}

function renderBlock(node: NotionBlockNode, numbered: number): string {
	const type = asString(node.block.type) ?? "";
	const data = isObject(node.block[type])
		? (node.block[type] as JsonObject)
		: {};
	const text = notionRichText(data.rich_text);
	const children = notionBlocksToMarkdown(node.children);
	const nested = children ? `\n${indentLines(children, "  ")}` : "";
	switch (type) {
		case "paragraph":
			return `${text}${children ? `\n\n${children}` : ""}`;
		case "heading_1":
			return `# ${text}${children ? `\n\n${children}` : ""}`;
		case "heading_2":
			return `## ${text}${children ? `\n\n${children}` : ""}`;
		case "heading_3":
			return `### ${text}${children ? `\n\n${children}` : ""}`;
		case "bulleted_list_item":
			return `- ${text}${nested}`;
		case "numbered_list_item":
			return `${numbered}. ${text}${nested}`;
		case "to_do":
			return `- [${data.checked === true ? "x" : " "}] ${text}${nested}`;
		case "toggle":
			return `- ${text}${nested}`;
		case "quote":
		case "callout":
			return indentLines(`${text}${children ? `\n\n${children}` : ""}`, "> ");
		case "code": {
			const language = asString(data.language) ?? "";
			return `\`\`\`${language === "plain text" ? "" : language}\n${notionRichText(data.rich_text)}\n\`\`\``;
		}
		case "equation":
			return `$$\n${asString(data.expression) ?? ""}\n$$`;
		case "divider":
			return "---";
		case "image": {
			const url = fileUrl(data);
			return url ? `![${notionRichText(data.caption)}](${url})` : "";
		}
		case "file":
		case "pdf":
		case "video":
		case "audio": {
			const url = fileUrl(data);
			const caption =
				notionRichText(data.caption) || asString(data.name) || type;
			return url ? `[${caption}](${url})` : "";
		}
		case "bookmark":
		case "embed":
		case "link_preview": {
			const url = asString(data.url);
			return url ? `[${notionRichText(data.caption) || url}](${url})` : "";
		}
		case "child_page":
		case "child_database":
			return `**${asString(data.title) ?? "Untitled"}**`;
		case "table":
			return renderTable(node);
		default:
			// column_list, column, synced_block, template, …: render the content.
			return [text, children].filter(Boolean).join("\n\n");
	}
}

/** Render a loaded Notion block tree as Markdown. */
export function notionBlocksToMarkdown(
	nodes: readonly NotionBlockNode[]
): string {
	const parts: string[] = [];
	let numbered = 0;
	let previousType = "";
	for (const node of nodes) {
		const type = asString(node.block.type) ?? "";
		numbered = type === "numbered_list_item" ? numbered + 1 : 0;
		const rendered = renderBlock(node, numbered).trimEnd();
		if (!rendered) {
			previousType = type;
			continue;
		}
		const listLike = (value: string) =>
			value === "bulleted_list_item" ||
			value === "numbered_list_item" ||
			value === "to_do";
		const separator = listLike(type) && listLike(previousType) ? "\n" : "\n\n";
		parts.push(parts.length === 0 ? rendered : `${separator}${rendered}`);
		previousType = type;
	}
	return parts.join("");
}

/** Flatten one Notion property value into a metadata value. */
export function notionPropertyValue(property: unknown): LoaderMetadataValue {
	if (!isObject(property)) {
		return null;
	}
	const type = asString(property.type) ?? "";
	const value = property[type];
	switch (type) {
		case "title":
		case "rich_text":
			return asArray(value)
				.map((part) =>
					isObject(part) ? (asString(part.plain_text) ?? "") : ""
				)
				.join("");
		case "number":
		case "checkbox":
		case "url":
		case "email":
		case "phone_number":
		case "created_time":
		case "last_edited_time":
			return typeof value === "string" ||
				typeof value === "number" ||
				typeof value === "boolean"
				? value
				: null;
		case "select":
		case "status":
			return isObject(value) ? (asString(value.name) ?? null) : null;
		case "multi_select":
			return asArray(value).map((option) =>
				isObject(option) ? (asString(option.name) ?? "") : ""
			);
		case "date":
			if (!isObject(value)) {
				return null;
			}
			return asString(value.end)
				? `${asString(value.start) ?? ""}/${asString(value.end)}`
				: (asString(value.start) ?? null);
		case "people":
			return asArray(value).map((person) =>
				isObject(person)
					? (asString(person.name) ?? asString(person.id) ?? "")
					: ""
			);
		case "relation":
			return asArray(value).map((link) =>
				isObject(link) ? (asString(link.id) ?? "") : ""
			);
		case "formula":
		case "rollup":
			return isObject(value) ? notionPropertyValue(value) : null;
		case "unique_id":
			return isObject(value)
				? `${asString(value.prefix) ? `${asString(value.prefix)}-` : ""}${String(value.number ?? "")}`
				: null;
		case "created_by":
		case "last_edited_by":
			return isObject(value)
				? (asString(value.name) ?? asString(value.id) ?? null)
				: null;
		case "files":
			return asArray(value)
				.map((file) => fileUrl(file) ?? "")
				.filter(Boolean);
		default:
			if (
				typeof value === "string" ||
				typeof value === "number" ||
				typeof value === "boolean"
			) {
				return value;
			}
			return null;
	}
}

function pageTitle(page: JsonObject): string {
	const properties = isObject(page.properties) ? page.properties : {};
	for (const property of Object.values(properties)) {
		if (isObject(property) && property.type === "title") {
			const title = notionPropertyValue(property);
			if (typeof title === "string" && title.trim()) {
				return title.trim();
			}
		}
	}
	return "Untitled";
}

/**
 * Load Notion pages and database rows as Markdown.
 *
 * ```ts
 * const docs = await new NotionLoader({
 *   token: process.env.NOTION_TOKEN!,
 *   pageIds: ["https://www.notion.so/acme/Handbook-0123456789abcdef0123456789abcdef"],
 * }).load();
 * ```
 */
export class NotionLoader extends BaseLoader {
	readonly #options: NotionLoaderOptions;

	constructor(options: NotionLoaderOptions) {
		super();
		this.#options = options;
	}

	async #request(path: string, body?: JsonObject): Promise<JsonObject> {
		const token = await resolveCredential(this.#options.token, "Notion");
		const root = (this.#options.apiUrl ?? "https://api.notion.com").replace(
			/\/+$/,
			""
		);
		const result = await fetchJson(
			`${root}/v1${path}`,
			{
				method: body ? "POST" : "GET",
				headers: {
					authorization: `Bearer ${token}`,
					"notion-version": NOTION_VERSION,
					"content-type": "application/json",
				},
				body: body ? JSON.stringify(body) : undefined,
			},
			this.#options
		);
		if (!isObject(result)) {
			throw new LoaderError("Notion returned an unexpected response");
		}
		return result;
	}

	/** Load a block's children recursively, within the depth and block budgets. */
	async blockTree(
		blockId: string,
		budget = { remaining: this.#options.maxBlocks ?? 2000 },
		depth = 0
	): Promise<NotionBlockNode[]> {
		const nodes: NotionBlockNode[] = [];
		let cursor: string | undefined;
		do {
			const query = new URLSearchParams({ page_size: "100" });
			if (cursor) {
				query.set("start_cursor", cursor);
			}
			const page = await this.#request(`/blocks/${blockId}/children?${query}`);
			for (const block of asArray(page.results)) {
				if (!isObject(block) || budget.remaining <= 0) {
					continue;
				}
				budget.remaining -= 1;
				const id = asString(block.id);
				const recurse =
					block.has_children === true &&
					id !== undefined &&
					depth + 1 < (this.#options.maxDepth ?? 5) &&
					block.type !== "child_page" &&
					block.type !== "child_database";
				nodes.push({
					block,
					children: recurse ? await this.blockTree(id, budget, depth + 1) : [],
				});
			}
			cursor = page.has_more === true ? asString(page.next_cursor) : undefined;
		} while (cursor && budget.remaining > 0);
		return nodes;
	}

	async #pageDocument(
		page: JsonObject,
		loadContent: boolean
	): Promise<LoadedDocument> {
		const id = asString(page.id) ?? "";
		const properties = isObject(page.properties) ? page.properties : {};
		const flattened: Record<string, LoaderMetadataValue> = {};
		for (const [name, property] of Object.entries(properties)) {
			flattened[name] = notionPropertyValue(property);
		}
		const content = loadContent
			? notionBlocksToMarkdown(await this.blockTree(id))
			: "";
		return {
			content,
			metadata: {
				source: asString(page.url) ?? `notion://page/${id}`,
				loader: "notion",
				id,
				title: pageTitle(page),
				properties: flattened,
				lastEditedTime: asString(page.last_edited_time) ?? null,
			},
		};
	}

	/** Every row of one database, following pagination up to `maxRows`. */
	async databaseRows(databaseId: string): Promise<JsonObject[]> {
		const rows: JsonObject[] = [];
		const maxRows = this.#options.maxRows ?? 500;
		let cursor: string | undefined;
		do {
			const body: JsonObject = {
				page_size: Math.min(100, maxRows - rows.length),
			};
			if (cursor) {
				body.start_cursor = cursor;
			}
			const page = await this.#request(
				`/databases/${notionId(databaseId)}/query`,
				body
			);
			for (const row of asArray(page.results)) {
				if (isObject(row) && rows.length < maxRows) {
					rows.push(row);
				}
			}
			cursor = page.has_more === true ? asString(page.next_cursor) : undefined;
		} while (cursor && rows.length < maxRows);
		return rows;
	}

	async *lazyLoad(): AsyncIterable<LoadedDocument> {
		for (const pageId of this.#options.pageIds ?? []) {
			const page = await this.#request(`/pages/${notionId(pageId)}`);
			const document = await this.#pageDocument(page, true);
			const title = asString(document.metadata.title);
			if (title && title !== "Untitled" && document.content) {
				document.content = `# ${title}\n\n${document.content}`;
			}
			yield document;
		}
		for (const databaseId of this.#options.databaseIds ?? []) {
			for (const row of await this.databaseRows(databaseId)) {
				const document = await this.#pageDocument(
					row,
					this.#options.loadRowContent ?? true
				);
				document.metadata.databaseId = notionId(databaseId);
				yield document;
			}
		}
	}
}
