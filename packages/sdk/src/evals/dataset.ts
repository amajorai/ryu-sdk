/**
 * Eval datasets: build one in code with `createDataset`, or load a JSON, JSONL,
 * or CSV file with `loadDataset` / `parseDataset`.
 *
 * Field names follow the common eval-file conventions so existing datasets
 * load unchanged: the prompt may be `input`, `prompt`, `question`, or `query`;
 * the reference answer `expected`, `expected_output`, `expectedOutput`,
 * `answer`, or `reference`. `context`, `id`, `metadata`, and
 * `expectedToolCalls` keep their names; any other column lands in `metadata`.
 */

import { z } from "zod";
import type { EvalItem, ExpectedToolCall } from "./types.ts";

/** A named, validated list of eval items. */
export interface Dataset {
	readonly items: readonly EvalItem[];
	readonly name: string;
}

/** Dataset file formats. */
export type DatasetFormat = "csv" | "json" | "jsonl";

/** Thrown for dataset input that cannot become eval items. */
export class DatasetError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DatasetError";
	}
}

const MAX_ITEMS = 10_000;
const INPUT_KEYS = ["input", "prompt", "question", "query"] as const;
const EXPECTED_KEYS = [
	"expected",
	"expected_output",
	"expectedOutput",
	"answer",
	"reference",
] as const;
const KNOWN_KEYS = new Set<string>([
	...INPUT_KEYS,
	...EXPECTED_KEYS,
	"context",
	"expectedToolCalls",
	"expected_tool_calls",
	"id",
	"metadata",
]);
const BYTE_ORDER_MARK = String.fromCharCode(0xfe_ff);

const rowSchema = z.record(z.string(), z.unknown());
const expectedToolCallsSchema = z.array(
	z.object({
		input: z.record(z.string(), z.unknown()).optional(),
		name: z.string().min(1),
	})
);

function validateItem(item: EvalItem, index: number): EvalItem {
	if (typeof item.input !== "string" || item.input.trim() === "") {
		throw new DatasetError(`item ${index + 1} needs a non-empty input`);
	}
	if (item.expectedToolCalls !== undefined) {
		const parsed = expectedToolCallsSchema.safeParse(item.expectedToolCalls);
		if (!parsed.success) {
			throw new DatasetError(
				`item ${index + 1} expectedToolCalls must be [{ name, input? }]`
			);
		}
	}
	return item;
}

function assignIds(items: readonly EvalItem[]): EvalItem[] {
	const seen = new Set<string>();
	return items.map((item, index) => {
		const id = item.id ?? `case-${index + 1}`;
		if (seen.has(id)) {
			throw new DatasetError(`duplicate item id '${id}'`);
		}
		seen.add(id);
		return { ...item, id };
	});
}

/**
 * Build a dataset in code. Items without an `id` get `case-<n>`; ids must be
 * unique.
 *
 * ```ts
 * const qa = createDataset("geography", [
 *   { input: "Capital of France?", expected: "Paris" },
 * ]);
 * ```
 */
export function createDataset(
	name: string,
	items: readonly EvalItem[]
): Dataset {
	if (name.trim() === "") {
		throw new DatasetError("dataset name must not be empty");
	}
	if (items.length === 0) {
		throw new DatasetError(`dataset '${name}' has no items`);
	}
	if (items.length > MAX_ITEMS) {
		throw new DatasetError(
			`dataset '${name}' has ${items.length} items; the limit is ${MAX_ITEMS}`
		);
	}
	return {
		items: Object.freeze(assignIds(items.map(validateItem))),
		name,
	};
}

/** Parse RFC 4180 CSV (quoted fields may hold commas, quotes, line breaks). */
export function parseCsvRows(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	const source = text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index];
		if (quoted) {
			if (char === '"' && source[index + 1] === '"') {
				cell += '"';
				index += 1;
			} else if (char === '"') {
				quoted = false;
			} else {
				cell += char;
			}
			continue;
		}
		if (char === '"' && cell === "") {
			quoted = true;
		} else if (char === ",") {
			row.push(cell);
			cell = "";
		} else if (char === "\n" || char === "\r") {
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
			if (char === "\r" && source[index + 1] === "\n") {
				index += 1;
			}
		} else {
			cell += char;
		}
	}
	if (quoted) {
		throw new DatasetError("CSV ends inside a quoted field");
	}
	if (cell !== "" || row.length > 0) {
		row.push(cell);
		rows.push(row);
	}
	return rows.filter((cells) => cells.some((value) => value.trim() !== ""));
}

function maybeJson(value: unknown): unknown {
	if (typeof value !== "string") {
		return value;
	}
	const trimmed = value.trim();
	if (!(trimmed.startsWith("[") || trimmed.startsWith("{"))) {
		return value;
	}
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

function firstPresent(
	row: Record<string, unknown>,
	keys: readonly string[]
): unknown {
	for (const key of keys) {
		const value = row[key];
		if (value !== undefined && value !== null && value !== "") {
			return value;
		}
	}
	return;
}

function rowToItem(
	row: Record<string, unknown>,
	label: string,
	fromCsv: boolean
): EvalItem {
	const rawInput = firstPresent(row, INPUT_KEYS);
	let input = "";
	if (typeof rawInput === "string") {
		input = rawInput;
	} else if (rawInput !== undefined) {
		// A structured input (an object or a number) is sent as its JSON text;
		// a missing one stays empty so validation rejects the row.
		input = JSON.stringify(rawInput);
	}
	const item: EvalItem = { input };
	const expected = firstPresent(row, EXPECTED_KEYS);
	if (expected !== undefined) {
		item.expected = expected;
	}
	const context = fromCsv ? maybeJson(row.context) : row.context;
	if (context !== undefined && context !== "") {
		item.context = context;
	}
	if (row.id !== undefined && row.id !== "") {
		item.id = String(row.id);
	}
	const toolCalls = row.expectedToolCalls ?? row.expected_tool_calls;
	if (toolCalls !== undefined && toolCalls !== "") {
		const parsed = expectedToolCallsSchema.safeParse(
			fromCsv ? maybeJson(toolCalls) : toolCalls
		);
		if (!parsed.success) {
			throw new DatasetError(
				`${label} expectedToolCalls must be a JSON array of { name, input? }`
			);
		}
		item.expectedToolCalls = parsed.data satisfies ExpectedToolCall[];
	}
	const metadata: Record<string, unknown> = {};
	const declared = rowSchema.safeParse(row.metadata);
	if (declared.success) {
		Object.assign(metadata, declared.data);
	}
	for (const [key, value] of Object.entries(row)) {
		if (!KNOWN_KEYS.has(key)) {
			metadata[key] = value;
		}
	}
	if (Object.keys(metadata).length > 0) {
		item.metadata = metadata;
	}
	return item;
}

function objectRow(value: unknown, label: string): Record<string, unknown> {
	const parsed = rowSchema.safeParse(value);
	if (!parsed.success || Array.isArray(value)) {
		throw new DatasetError(`${label} must be a JSON object`);
	}
	return parsed.data;
}

function detectFormat(text: string, fileName?: string): DatasetFormat {
	const lower = fileName?.toLowerCase() ?? "";
	if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) {
		return "jsonl";
	}
	if (lower.endsWith(".json")) {
		return "json";
	}
	if (lower.endsWith(".csv")) {
		return "csv";
	}
	const trimmed = text.trimStart();
	if (trimmed.startsWith("[")) {
		return "json";
	}
	if (trimmed.startsWith("{")) {
		try {
			JSON.parse(trimmed);
			return "json";
		} catch {
			return "jsonl";
		}
	}
	return "csv";
}

function parseJsonText(text: string, label: string): unknown {
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new DatasetError(
			`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

const envelopeSchema = z.object({
	cases: z.array(z.unknown()).optional(),
	items: z.array(z.unknown()).optional(),
	name: z.string().optional(),
});

/** Options for {@link parseDataset} and {@link loadDataset}. */
export interface ParseDatasetOptions {
	/** Used to pick the format by extension. */
	fileName?: string;
	/** Force a format instead of detecting it. */
	format?: DatasetFormat;
	/** Dataset name (defaults to the JSON envelope's `name`, else the file name). */
	name?: string;
}

/** Parse dataset text into a {@link Dataset}. */
export function parseDataset(
	text: string,
	options: ParseDatasetOptions = {}
): Dataset {
	const format = options.format ?? detectFormat(text, options.fileName);
	let items: EvalItem[];
	let name = options.name;
	if (format === "csv") {
		const [header, ...body] = parseCsvRows(text);
		const columns = (header ?? []).map((column) => column.trim());
		items = body.map((cells, index) => {
			if (cells.length > columns.length) {
				throw new DatasetError(
					`CSV row ${index + 2} has more cells than the header`
				);
			}
			const row: Record<string, unknown> = {};
			for (const [column, key] of columns.entries()) {
				if (key !== "") {
					row[key] = cells[column] ?? "";
				}
			}
			return rowToItem(row, `CSV row ${index + 2}`, true);
		});
	} else if (format === "jsonl") {
		items = [];
		for (const [index, line] of text.split(/\r?\n/).entries()) {
			if (line.trim() === "") {
				continue;
			}
			const label = `JSONL line ${index + 1}`;
			items.push(
				rowToItem(objectRow(parseJsonText(line, label), label), label, false)
			);
		}
	} else {
		const parsed = parseJsonText(text, "dataset");
		let rows: unknown[];
		if (Array.isArray(parsed)) {
			rows = parsed;
		} else {
			const envelope = envelopeSchema.safeParse(parsed);
			const list = envelope.success
				? (envelope.data.items ?? envelope.data.cases)
				: undefined;
			if (!list) {
				throw new DatasetError(
					"a JSON dataset must be an array or an object with an `items` array"
				);
			}
			rows = list;
			name ??= envelope.data?.name;
		}
		items = rows.map((value, index) =>
			rowToItem(
				objectRow(value, `item ${index + 1}`),
				`item ${index + 1}`,
				false
			)
		);
	}
	return createDataset(name ?? options.fileName ?? "dataset", items);
}

/** Read and parse a dataset file (Node, Bun, or Deno). */
export async function loadDataset(
	path: string,
	options: Omit<ParseDatasetOptions, "fileName"> = {}
): Promise<Dataset> {
	const { readFile } = await import("node:fs/promises");
	const { basename } = await import("node:path");
	const text = await readFile(path, "utf8");
	return parseDataset(text, { ...options, fileName: basename(path) });
}
