/**
 * Metadata predicate filters, the TypeScript twin of Core's
 * `ryu_rag::MetadataFilter`. The JSON shape is the one Core accepts in the
 * `filter` field of retrieval requests, so a filter can be checked locally
 * with {@link matchesFilter} and sent to Core unchanged.
 *
 * ```ts
 * const filter: MetadataFilter = {
 *   kind: "page",
 *   ordinal: { $lt: 3 },
 *   $or: [{ lang: { $in: ["en", "de"] } }, { $not: { draft: true } }],
 * };
 * ```
 */

/** A JSON value stored in chunk metadata. */
export type FilterValue =
	| string
	| number
	| boolean
	| null
	| FilterValue[]
	| { [key: string]: FilterValue };

/** Comparison operators for one field. */
export interface FieldOperators {
	$eq?: FilterValue;
	$exists?: boolean;
	$gt?: number | string;
	$gte?: number | string;
	$in?: FilterValue[];
	$lt?: number | string;
	$lte?: number | string;
	$ne?: FilterValue;
	$nin?: FilterValue[];
}

/** A metadata filter: field predicates AND-ed together, plus combinators. */
export interface MetadataFilter {
	$and?: MetadataFilter[];
	$not?: MetadataFilter;
	$or?: MetadataFilter[];
	[field: string]:
		| FilterValue
		| FieldOperators
		| MetadataFilter[]
		| MetadataFilter
		| undefined;
}

/** Maximum nesting of `$and`/`$or`/`$not` (matches Core). */
export const MAX_FILTER_DEPTH = 16;
/** Maximum predicates in one filter (matches Core). */
export const MAX_FILTER_NODES = 256;
/** Maximum values in one `$in`/`$nin` list (matches Core). */
export const MAX_IN_VALUES = 1024;

const FIELD_OPERATORS = new Set([
	"$eq",
	"$ne",
	"$in",
	"$nin",
	"$gt",
	"$gte",
	"$lt",
	"$lte",
	"$exists",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Throw a `TypeError` naming the first problem when `filter` is not a valid
 * metadata filter (unknown operator, wrong operand type, too deep or large).
 * Core rejects the same inputs with HTTP 400.
 */
export function validateFilter(
	filter: unknown
): asserts filter is MetadataFilter {
	if (filter === null || filter === undefined) {
		return;
	}
	const nodes = { count: 0 };
	validateNode(filter, 0, nodes);
}

function bump(nodes: { count: number }): void {
	nodes.count += 1;
	if (nodes.count > MAX_FILTER_NODES) {
		throw new TypeError(`filter has more than ${MAX_FILTER_NODES} predicates`);
	}
}

function validateNode(
	node: unknown,
	depth: number,
	nodes: { count: number }
): void {
	if (depth > MAX_FILTER_DEPTH) {
		throw new TypeError(`filter nests deeper than ${MAX_FILTER_DEPTH} levels`);
	}
	if (!isPlainObject(node)) {
		throw new TypeError("a filter must be a JSON object");
	}
	for (const [key, operand] of Object.entries(node)) {
		bump(nodes);
		if (key === "$and" || key === "$or") {
			if (!Array.isArray(operand) || operand.length === 0) {
				throw new TypeError(`${key} takes a non-empty array of filters`);
			}
			for (const item of operand) {
				validateNode(item, depth + 1, nodes);
			}
		} else if (key === "$not") {
			validateNode(operand, depth + 1, nodes);
		} else if (key.startsWith("$")) {
			throw new TypeError(`unknown filter operator ${key}`);
		} else if (key === "") {
			throw new TypeError("filter field names must not be empty");
		} else {
			validateField(key, operand, nodes);
		}
	}
}

function validateField(
	field: string,
	operand: unknown,
	nodes: { count: number }
): void {
	if (
		!(
			isPlainObject(operand) &&
			Object.keys(operand).some((k) => k.startsWith("$"))
		)
	) {
		return;
	}
	for (const [name, arg] of Object.entries(operand)) {
		bump(nodes);
		if (!FIELD_OPERATORS.has(name)) {
			throw new TypeError(`unknown operator ${name} on '${field}'`);
		}
		if (name === "$in" || name === "$nin") {
			if (!Array.isArray(arg)) {
				throw new TypeError(`${name} on '${field}' takes an array`);
			}
			if (arg.length > MAX_IN_VALUES) {
				throw new TypeError(
					`${name} on '${field}' lists more than ${MAX_IN_VALUES} values`
				);
			}
		} else if (["$gt", "$gte", "$lt", "$lte"].includes(name)) {
			if (typeof arg !== "number" && typeof arg !== "string") {
				throw new TypeError(`${name} on '${field}' takes a number or a string`);
			}
		} else if (name === "$exists" && typeof arg !== "boolean") {
			throw new TypeError(`$exists on '${field}' takes a boolean`);
		}
	}
}

function lookup(metadata: Record<string, unknown>, path: string): unknown {
	if (Object.hasOwn(metadata, path)) {
		return metadata[path];
	}
	let current: unknown = metadata;
	for (const segment of path.split(".")) {
		if (!(isPlainObject(current) && Object.hasOwn(current, segment))) {
			return;
		}
		current = current[segment];
	}
	return current;
}

function jsonEqual(a: unknown, b: unknown): boolean {
	if (a === b) {
		return true;
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
	}
	if (isPlainObject(a) && isPlainObject(b)) {
		const keys = Object.keys(a);
		return (
			keys.length === Object.keys(b).length &&
			keys.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]))
		);
	}
	return false;
}

function anyElement(
	value: unknown,
	predicate: (x: unknown) => boolean
): boolean {
	return predicate(value) || (Array.isArray(value) && value.some(predicate));
}

function compare(a: unknown, b: unknown): number | undefined {
	if (typeof a === "number" && typeof b === "number") {
		return Math.sign(a - b);
	}
	if (typeof a === "string" && typeof b === "string") {
		if (a === b) {
			return 0;
		}
		return a < b ? -1 : 1;
	}
	return;
}

function compareAny(
	actual: unknown,
	bound: unknown,
	accept: (ordering: number) => boolean
): boolean {
	if (actual === undefined) {
		return false;
	}
	const check = (value: unknown) => {
		const ordering = compare(value, bound);
		return ordering !== undefined && accept(ordering);
	};
	return Array.isArray(actual) ? actual.some(check) : check(actual);
}

function fieldMatches(actual: unknown, operand: unknown): boolean {
	if (
		!(
			isPlainObject(operand) &&
			Object.keys(operand).some((k) => k.startsWith("$"))
		)
	) {
		return (
			actual !== undefined && anyElement(actual, (x) => jsonEqual(x, operand))
		);
	}
	return Object.entries(operand).every(([name, arg]) => {
		switch (name) {
			case "$eq":
				return (
					actual !== undefined && anyElement(actual, (x) => jsonEqual(x, arg))
				);
			case "$ne":
				return !(
					actual !== undefined && anyElement(actual, (x) => jsonEqual(x, arg))
				);
			case "$in":
				return (
					actual !== undefined &&
					anyElement(actual, (x) =>
						(arg as unknown[]).some((o) => jsonEqual(x, o))
					)
				);
			case "$nin":
				return !(
					actual !== undefined &&
					anyElement(actual, (x) =>
						(arg as unknown[]).some((o) => jsonEqual(x, o))
					)
				);
			case "$gt":
				return compareAny(actual, arg, (o) => o > 0);
			case "$gte":
				return compareAny(actual, arg, (o) => o >= 0);
			case "$lt":
				return compareAny(actual, arg, (o) => o < 0);
			case "$lte":
				return compareAny(actual, arg, (o) => o <= 0);
			case "$exists":
				return (actual !== undefined && actual !== null) === arg;
			default:
				return false;
		}
	});
}

function nodeMatches(
	node: Record<string, unknown>,
	metadata: Record<string, unknown>
): boolean {
	return Object.entries(node).every(([key, operand]) => {
		if (key === "$and") {
			return (operand as Record<string, unknown>[]).every((f) =>
				nodeMatches(f, metadata)
			);
		}
		if (key === "$or") {
			return (operand as Record<string, unknown>[]).some((f) =>
				nodeMatches(f, metadata)
			);
		}
		if (key === "$not") {
			return !nodeMatches(operand as Record<string, unknown>, metadata);
		}
		return fieldMatches(lookup(metadata, key), operand);
	});
}

/**
 * Evaluate `filter` against one metadata object with Core's semantics:
 * dotted paths walk nested objects, array values match `$eq`/`$in` when any
 * element does, comparisons are numeric or lexicographic only, and a missing
 * field fails everything except `$ne`, `$nin`, and `$exists: false`. An empty
 * or nullish filter matches everything. Throws on an invalid filter.
 */
export function matchesFilter(
	filter: MetadataFilter | null | undefined,
	metadata: Record<string, unknown>
): boolean {
	if (filter === null || filter === undefined) {
		return true;
	}
	validateFilter(filter);
	return nodeMatches(filter, metadata);
}
