/**
 * CSV, JSON, and JSONL loaders.
 *
 * Each reads from a local file (`{ path }`), a URL (`{ url }`, fetched under the
 * SSRF policy), or an in-memory string (`{ text }`), and emits one document per
 * row, array element, or line.
 */

import { fetchText, type NetworkOptions } from "./net.ts";
import {
	BaseLoader,
	type LoadedDocument,
	LoaderError,
	type LoaderMetadataValue,
} from "./types.ts";

/** Where structured data comes from. */
export type TextInput =
	| { path: string }
	| { url: string }
	| { source?: string; text: string };

/** Read a {@link TextInput} to a string, plus the `source` label to record. */
export async function readTextInput(
	input: TextInput,
	options: NetworkOptions = {}
): Promise<{ source: string; text: string }> {
	if ("text" in input) {
		return { source: input.source ?? "inline", text: input.text };
	}
	if ("url" in input) {
		const { text } = await fetchText(input.url, {}, options);
		return { source: input.url, text };
	}
	const { readFile } = await import("node:fs/promises");
	return { source: input.path, text: await readFile(input.path, "utf8") };
}

/** Options for {@link CsvLoader}. */
export interface CsvLoaderOptions extends NetworkOptions {
	/** Columns written into `content`. Default: every column. */
	contentColumns?: readonly string[];
	/** Field delimiter. Default: detected from the header (`,`, `;`, tab, `|`). */
	delimiter?: string;
	/** Columns copied into metadata. */
	metadataColumns?: readonly string[];
	/** Column whose value becomes `metadata.source` (default: the input). */
	sourceColumn?: string;
}

const DELIMITERS = [",", ";", "\t", "|"];

function detectDelimiter(text: string): string {
	const header = text.slice(
		0,
		text.search(/\r?\n/) === -1 ? text.length : text.search(/\r?\n/)
	);
	let best = ",";
	let bestCount = 0;
	for (const delimiter of DELIMITERS) {
		const count = header.split(delimiter).length - 1;
		if (count > bestCount) {
			best = delimiter;
			bestCount = count;
		}
	}
	return best;
}

/** Parse delimited text (RFC 4180 quoting, CRLF or LF, optional BOM). */
export function parseCsv(
	text: string,
	delimiter = detectDelimiter(text)
): string[][] {
	const body = text.startsWith("﻿") ? text.slice(1) : text;
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	for (let index = 0; index < body.length; index += 1) {
		const char = body[index];
		if (quoted) {
			if (char === '"' && body[index + 1] === '"') {
				field += '"';
				index += 1;
			} else if (char === '"') {
				quoted = false;
			} else {
				field += char;
			}
			continue;
		}
		if (char === '"' && field === "") {
			quoted = true;
		} else if (char === delimiter) {
			row.push(field);
			field = "";
		} else if (char === "\n" || char === "\r") {
			if (char === "\r" && body[index + 1] === "\n") {
				index += 1;
			}
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else {
			field += char;
		}
	}
	if (quoted) {
		throw new LoaderError("CSV has an unterminated quoted field");
	}
	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

/**
 * One document per CSV row; `content` is `column: value` lines.
 *
 * ```ts
 * const docs = await new CsvLoader({ path: "faq.csv" }, {
 *   contentColumns: ["question", "answer"],
 *   metadataColumns: ["category"],
 * }).load();
 * ```
 */
export class CsvLoader extends BaseLoader {
	readonly #input: TextInput;
	readonly #options: CsvLoaderOptions;

	constructor(input: TextInput, options: CsvLoaderOptions = {}) {
		super();
		this.#input = input;
		this.#options = options;
	}

	async *lazyLoad(): AsyncIterable<LoadedDocument> {
		const options = this.#options;
		const { source, text } = await readTextInput(this.#input, options);
		const [header = [], ...rows] = parseCsv(text, options.delimiter);
		const columns = header.map((column) => column.trim());
		const missing = [
			...(options.contentColumns ?? []),
			...(options.metadataColumns ?? []),
			...(options.sourceColumn ? [options.sourceColumn] : []),
		].filter((column) => !columns.includes(column));
		if (missing.length > 0) {
			throw new LoaderError(`CSV has no column ${missing.join(", ")}`);
		}
		const contentColumns = options.contentColumns ?? columns;
		for (const [index, cells] of rows.entries()) {
			const value = (column: string) =>
				cells[columns.indexOf(column)]?.trim() ?? "";
			const metadata: Record<string, LoaderMetadataValue> = {};
			for (const column of options.metadataColumns ?? []) {
				metadata[column] = value(column);
			}
			yield {
				content: contentColumns
					.map((column) => `${column}: ${value(column)}`)
					.join("\n"),
				metadata: {
					...metadata,
					source: options.sourceColumn
						? value(options.sourceColumn) || source
						: source,
					loader: "csv",
					row: index,
				},
			};
		}
	}
}

/** Options for {@link JsonLoader} and {@link JsonLinesLoader}. */
export interface JsonLoaderOptions extends NetworkOptions {
	/** Field (dot path, e.g. `body.text`) used as `content`. Default: the whole value as JSON. */
	contentKey?: string;
	/** Fields (dot paths) copied into metadata. */
	metadataKeys?: readonly string[];
	/**
	 * JSON Pointer (RFC 6901) to the value to load, e.g. `/data/items`. An array
	 * yields one document per element. Default: the root. ({@link JsonLoader} only.)
	 */
	pointer?: string;
}

/** Resolve an RFC 6901 JSON Pointer. */
export function jsonPointer(value: unknown, pointer: string): unknown {
	if (pointer === "" || pointer === "/") {
		return value;
	}
	if (!pointer.startsWith("/")) {
		throw new LoaderError(`JSON pointer must start with "/": ${pointer}`);
	}
	let current = value;
	for (const raw of pointer.slice(1).split("/")) {
		const token = raw.replaceAll("~1", "/").replaceAll("~0", "~");
		if (Array.isArray(current)) {
			current = current[Number(token)];
		} else if (current && typeof current === "object") {
			current = (current as Record<string, unknown>)[token];
		} else {
			return;
		}
	}
	return current;
}

function dotPath(value: unknown, path: string): unknown {
	let current = value;
	for (const key of path.split(".")) {
		if (current && typeof current === "object") {
			current = (current as Record<string, unknown>)[key];
		} else {
			return;
		}
	}
	return current;
}

function toMetadata(value: unknown): LoaderMetadataValue {
	if (value === undefined) {
		return null;
	}
	return JSON.parse(JSON.stringify(value)) as LoaderMetadataValue;
}

function jsonDocument(
	value: unknown,
	source: string,
	loader: string,
	index: number,
	options: JsonLoaderOptions
): LoadedDocument {
	let content: string;
	if (options.contentKey) {
		const field = dotPath(value, options.contentKey);
		if (field === undefined) {
			throw new LoaderError(`item ${index} has no ${options.contentKey}`);
		}
		content =
			typeof field === "string" ? field : JSON.stringify(field, null, 2);
	} else {
		content =
			typeof value === "string" ? value : JSON.stringify(value, null, 2);
	}
	const metadata: Record<string, LoaderMetadataValue> = {};
	for (const key of options.metadataKeys ?? []) {
		metadata[key] = toMetadata(dotPath(value, key));
	}
	return { content, metadata: { ...metadata, source, loader, index } };
}

/** One document per element of a JSON array (or one for a non-array value). */
export class JsonLoader extends BaseLoader {
	readonly #input: TextInput;
	readonly #options: JsonLoaderOptions;

	constructor(input: TextInput, options: JsonLoaderOptions = {}) {
		super();
		this.#input = input;
		this.#options = options;
	}

	async *lazyLoad(): AsyncIterable<LoadedDocument> {
		const { source, text } = await readTextInput(this.#input, this.#options);
		let parsed: unknown;
		try {
			parsed = JSON.parse(text) as unknown;
		} catch (error) {
			throw new LoaderError(
				`invalid JSON in ${source}: ${error instanceof Error ? error.message : String(error)}`
			);
		}
		const target = jsonPointer(parsed, this.#options.pointer ?? "");
		if (target === undefined) {
			throw new LoaderError(
				`JSON pointer ${this.#options.pointer} matched nothing`
			);
		}
		const items = Array.isArray(target) ? target : [target];
		for (const [index, item] of items.entries()) {
			yield jsonDocument(item, source, "json", index, this.#options);
		}
	}
}

/** One document per line of a JSON Lines (NDJSON) file. Blank lines are skipped. */
export class JsonLinesLoader extends BaseLoader {
	readonly #input: TextInput;
	readonly #options: JsonLoaderOptions;

	constructor(input: TextInput, options: JsonLoaderOptions = {}) {
		super();
		this.#input = input;
		this.#options = options;
	}

	async *lazyLoad(): AsyncIterable<LoadedDocument> {
		const { source, text } = await readTextInput(this.#input, this.#options);
		let index = 0;
		for (const [lineNumber, line] of text.split(/\r?\n/).entries()) {
			if (!line.trim()) {
				continue;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(line) as unknown;
			} catch {
				throw new LoaderError(
					`invalid JSON on line ${lineNumber + 1} of ${source}`
				);
			}
			yield jsonDocument(parsed, source, "jsonl", index, this.#options);
			index += 1;
		}
	}
}
