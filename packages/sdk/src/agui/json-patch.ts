/**
 * RFC 6902 JSON Patch helpers for AG-UI `STATE_DELTA` events.
 *
 * `diffJsonState` produces the operations that turn one state into the next
 * (objects are diffed key by key; arrays and scalars that differ are replaced
 * whole, which keeps the patch valid without array index bookkeeping).
 * `applyJsonPatch` applies a patch immutably, so a client — or a test — can
 * fold deltas onto a snapshot.
 */

import type { AgUiJson, JsonPatchOperation } from "./events.ts";

interface JsonObject {
	[key: string]: AgUiJson;
}

function isObject(value: AgUiJson | undefined): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Escape one path segment per RFC 6901. */
export function escapePointerSegment(segment: string): string {
	return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function unescapePointerSegment(segment: string): string {
	return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

/** Deep structural equality over JSON values. */
export function jsonEqual(a: AgUiJson, b: AgUiJson): boolean {
	if (a === b) {
		return true;
	}
	if (Array.isArray(a)) {
		return (
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((item, index) => jsonEqual(item, b[index] ?? null))
		);
	}
	if (isObject(a) && isObject(b)) {
		const keys = Object.keys(a);
		return (
			keys.length === Object.keys(b).length &&
			keys.every(
				(key) =>
					Object.hasOwn(b, key) && jsonEqual(a[key] ?? null, b[key] ?? null)
			)
		);
	}
	return false;
}

function diffInto(
	prev: AgUiJson,
	next: AgUiJson,
	path: string,
	ops: JsonPatchOperation[]
) {
	if (jsonEqual(prev, next)) {
		return;
	}
	if (!(isObject(prev) && isObject(next))) {
		ops.push({ op: "replace", path, value: next });
		return;
	}
	for (const key of Object.keys(prev)) {
		if (!Object.hasOwn(next, key)) {
			ops.push({ op: "remove", path: `${path}/${escapePointerSegment(key)}` });
		}
	}
	for (const [key, value] of Object.entries(next)) {
		const childPath = `${path}/${escapePointerSegment(key)}`;
		if (Object.hasOwn(prev, key)) {
			diffInto(prev[key] ?? null, value, childPath, ops);
		} else {
			ops.push({ op: "add", path: childPath, value });
		}
	}
}

/** Compute the JSON Patch that turns `prev` into `next` (empty when equal). */
export function diffJsonState(
	prev: AgUiJson,
	next: AgUiJson
): JsonPatchOperation[] {
	const ops: JsonPatchOperation[] = [];
	diffInto(prev, next, "", ops);
	return ops;
}

function parsePointer(path: string): string[] {
	if (path === "") {
		return [];
	}
	if (!path.startsWith("/")) {
		throw new Error(`invalid JSON pointer: ${path}`);
	}
	return path.slice(1).split("/").map(unescapePointerSegment);
}

function clone(value: AgUiJson): AgUiJson {
	return structuredClone(value);
}

function readAt(doc: AgUiJson, segments: string[]): AgUiJson {
	let current: AgUiJson = doc;
	for (const segment of segments) {
		if (Array.isArray(current)) {
			const item = current[Number(segment)];
			if (item === undefined) {
				throw new Error(`JSON pointer index out of range: ${segment}`);
			}
			current = item;
		} else if (isObject(current) && Object.hasOwn(current, segment)) {
			current = current[segment] ?? null;
		} else {
			throw new Error(`JSON pointer target missing: ${segment}`);
		}
	}
	return current;
}

/** Mutate `doc` (already cloned) by setting/removing at a path; returns the new root. */
function writeAt(
	doc: AgUiJson,
	segments: string[],
	mode: "add" | "remove" | "replace",
	value: AgUiJson = null
): AgUiJson {
	if (segments.length === 0) {
		if (mode === "remove") {
			throw new Error("cannot remove the document root");
		}
		return value;
	}
	const parent = readAt(doc, segments.slice(0, -1));
	const key = segments.at(-1) ?? "";
	if (Array.isArray(parent)) {
		const index = key === "-" ? parent.length : Number(key);
		const valid =
			Number.isInteger(index) &&
			index >= 0 &&
			(mode === "add" ? index <= parent.length : index < parent.length);
		if (!valid) {
			throw new Error(`JSON pointer index out of range: ${key}`);
		}
		if (mode === "add") {
			parent.splice(index, 0, value);
		} else if (mode === "remove") {
			parent.splice(index, 1);
		} else {
			parent[index] = value;
		}
		return doc;
	}
	if (!isObject(parent)) {
		throw new Error(`JSON pointer parent is not a container: ${key}`);
	}
	if (mode !== "add" && !Object.hasOwn(parent, key)) {
		throw new Error(`JSON pointer target missing: ${key}`);
	}
	if (mode === "remove") {
		delete parent[key];
	} else {
		parent[key] = value;
	}
	return doc;
}

/** Apply an RFC 6902 patch, returning a new document (the input is untouched). */
export function applyJsonPatch(
	document: AgUiJson,
	patch: JsonPatchOperation[]
): AgUiJson {
	let doc = clone(document);
	for (const operation of patch) {
		const target = parsePointer(operation.path);
		switch (operation.op) {
			case "add":
			case "replace":
				doc = writeAt(doc, target, operation.op, clone(operation.value));
				break;
			case "remove":
				doc = writeAt(doc, target, "remove");
				break;
			case "test":
				if (!jsonEqual(readAt(doc, target), operation.value)) {
					throw new Error(`JSON patch test failed at ${operation.path}`);
				}
				break;
			case "copy":
			case "move": {
				const source = parsePointer(operation.from);
				const value = clone(readAt(doc, source));
				if (operation.op === "move") {
					doc = writeAt(doc, source, "remove");
				}
				doc = writeAt(doc, target, "add", value);
				break;
			}
			default:
				throw new Error("unsupported JSON patch operation");
		}
	}
	return doc;
}
