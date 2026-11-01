/**
 * A dependency-free JSON Schema validator for the subset the SDK puts on the
 * wire (tool parameters, structured-output `response_format`).
 *
 * It exists so a hand-written JSON Schema `outputSchema` is *validated*, not
 * merely forwarded: the structured-output repair loop needs concrete issues to
 * hand back to the model. Supported keywords (draft-07 / 2020-12 / OpenAPI 3.0):
 *
 * - `type` (string or array, incl. `integer` and `null`), OpenAPI `nullable`
 * - `enum`, `const`
 * - `properties`, `required`, `additionalProperties` (boolean or schema),
 *   `minProperties`, `maxProperties`
 * - `items` (schema or draft-07 tuple array), `prefixItems`, `minItems`,
 *   `maxItems`, `uniqueItems`
 * - `minLength`, `maxLength`, `pattern`
 * - `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum` (numeric and
 *   draft-04 boolean forms), `multipleOf`
 * - `allOf`, `anyOf`, `oneOf`, `not`
 * - local `$ref` (`#`, `#/definitions/…`, `#/$defs/…`, any JSON pointer)
 * - boolean schemas (`true` / `false`)
 *
 * Annotation and unsupported keywords (`format`, `title`, `description`,
 * `default`, `if`/`then`/`else`, remote `$ref`, …) are ignored, so validation is
 * permissive where the subset is silent — never stricter than the schema.
 */

/** One validation problem, addressed by its path inside the value. */
export interface SchemaIssue {
	message: string;
	path: (number | string)[];
}

type Json = unknown;

interface ValidationScope {
	issues: SchemaIssue[];
	root: unknown;
}

const MAX_REF_DEPTH = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonTypeOf(value: Json): string {
	if (value === null) {
		return "null";
	}
	if (Array.isArray(value)) {
		return "array";
	}
	if (typeof value === "number") {
		return Number.isInteger(value) ? "integer" : "number";
	}
	return typeof value;
}

function matchesType(value: Json, type: string): boolean {
	const actual = jsonTypeOf(value);
	if (type === "number") {
		return actual === "number" || actual === "integer";
	}
	return actual === type;
}

function deepEqual(a: Json, b: Json): boolean {
	if (a === b) {
		return true;
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
	}
	if (isPlainObject(a) && isPlainObject(b)) {
		const keys = Object.keys(a);
		return (
			keys.length === Object.keys(b).length &&
			keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
		);
	}
	return false;
}

function decodePointerSegment(segment: string): string {
	let decoded = segment;
	try {
		decoded = decodeURIComponent(segment);
	} catch {
		// A malformed percent-escape is matched literally rather than aborting
		// validation (the pointer then simply fails to resolve).
	}
	return decoded.replaceAll("~1", "/").replaceAll("~0", "~");
}

function resolveRef(root: unknown, ref: string): unknown {
	if (!ref.startsWith("#")) {
		return undefined;
	}
	const pointer = ref.slice(1);
	if (pointer === "") {
		return root;
	}
	let node: unknown = root;
	for (const raw of pointer.replace(/^\//, "").split("/")) {
		const key = decodePointerSegment(raw);
		if (Array.isArray(node)) {
			node = node[Number(key)];
		} else if (isPlainObject(node)) {
			node = node[key];
		} else {
			return undefined;
		}
	}
	return node;
}

function describe(value: Json): string {
	const text = JSON.stringify(value);
	if (text === undefined) {
		return String(value);
	}
	return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function readNumber(
	schema: Record<string, unknown>,
	key: string
): number | undefined {
	const value = schema[key];
	return typeof value === "number" ? value : undefined;
}

function report(
	scope: ValidationScope,
	path: (number | string)[],
	message: string
) {
	scope.issues.push({ path: [...path], message });
}

function validateType(
	schema: Record<string, unknown>,
	value: Json,
	path: (number | string)[],
	scope: ValidationScope
): boolean {
	const declared = schema.type;
	if (declared === undefined) {
		return true;
	}
	const types = (Array.isArray(declared) ? declared : [declared]).filter(
		(type): type is string => typeof type === "string"
	);
	if (schema.nullable === true) {
		types.push("null");
	}
	if (types.length === 0 || types.some((type) => matchesType(value, type))) {
		return true;
	}
	report(
		scope,
		path,
		`expected ${types.join(" | ")}, received ${jsonTypeOf(value)}`
	);
	return false;
}

function validateEnumConst(
	schema: Record<string, unknown>,
	value: Json,
	path: (number | string)[],
	scope: ValidationScope
) {
	if (Array.isArray(schema.enum)) {
		const allowed = schema.enum;
		if (!allowed.some((option) => deepEqual(option, value))) {
			report(
				scope,
				path,
				`expected one of ${allowed.map(describe).join(", ")}, received ${describe(value)}`
			);
		}
	}
	if (Object.hasOwn(schema, "const") && !deepEqual(schema.const, value)) {
		report(
			scope,
			path,
			`expected ${describe(schema.const)}, received ${describe(value)}`
		);
	}
}

function validateString(
	schema: Record<string, unknown>,
	value: string,
	path: (number | string)[],
	scope: ValidationScope
) {
	const length = [...value].length;
	const minLength = readNumber(schema, "minLength");
	const maxLength = readNumber(schema, "maxLength");
	if (minLength !== undefined && length < minLength) {
		report(scope, path, `must be at least ${minLength} characters`);
	}
	if (maxLength !== undefined && length > maxLength) {
		report(scope, path, `must be at most ${maxLength} characters`);
	}
	if (typeof schema.pattern === "string") {
		let pattern: RegExp | undefined;
		try {
			pattern = new RegExp(schema.pattern, "u");
		} catch {
			pattern = undefined;
		}
		if (pattern && !pattern.test(value)) {
			report(scope, path, `must match pattern ${schema.pattern}`);
		}
	}
}

function validateNumber(
	schema: Record<string, unknown>,
	value: number,
	path: (number | string)[],
	scope: ValidationScope
) {
	const minimum = readNumber(schema, "minimum");
	const maximum = readNumber(schema, "maximum");
	const exclusiveMinimum = schema.exclusiveMinimum;
	const exclusiveMaximum = schema.exclusiveMaximum;
	if (minimum !== undefined) {
		const exclusive = exclusiveMinimum === true;
		if (exclusive ? value <= minimum : value < minimum) {
			report(
				scope,
				path,
				`must be ${exclusive ? ">" : ">="} ${minimum}, received ${value}`
			);
		}
	}
	if (maximum !== undefined) {
		const exclusive = exclusiveMaximum === true;
		if (exclusive ? value >= maximum : value > maximum) {
			report(
				scope,
				path,
				`must be ${exclusive ? "<" : "<="} ${maximum}, received ${value}`
			);
		}
	}
	if (typeof exclusiveMinimum === "number" && value <= exclusiveMinimum) {
		report(scope, path, `must be > ${exclusiveMinimum}, received ${value}`);
	}
	if (typeof exclusiveMaximum === "number" && value >= exclusiveMaximum) {
		report(scope, path, `must be < ${exclusiveMaximum}, received ${value}`);
	}
	const multipleOf = readNumber(schema, "multipleOf");
	if (multipleOf !== undefined && multipleOf > 0) {
		const quotient = value / multipleOf;
		if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
			report(scope, path, `must be a multiple of ${multipleOf}`);
		}
	}
}

function validateArray(
	schema: Record<string, unknown>,
	value: Json[],
	path: (number | string)[],
	scope: ValidationScope,
	depth: number
) {
	const minItems = readNumber(schema, "minItems");
	const maxItems = readNumber(schema, "maxItems");
	if (minItems !== undefined && value.length < minItems) {
		report(scope, path, `must contain at least ${minItems} items`);
	}
	if (maxItems !== undefined && value.length > maxItems) {
		report(scope, path, `must contain at most ${maxItems} items`);
	}
	if (schema.uniqueItems === true) {
		const duplicate = value.findIndex((item, index) =>
			value.slice(0, index).some((earlier) => deepEqual(earlier, item))
		);
		if (duplicate !== -1) {
			report(scope, [...path, duplicate], "duplicate item");
		}
	}
	let tuple: unknown[] = [];
	if (Array.isArray(schema.prefixItems)) {
		tuple = schema.prefixItems;
	} else if (Array.isArray(schema.items)) {
		tuple = schema.items;
	}
	let rest: unknown;
	if (Array.isArray(schema.items)) {
		rest = schema.additionalItems;
	} else {
		rest = schema.items;
	}
	for (const [index, item] of value.entries()) {
		const itemSchema = index < tuple.length ? tuple[index] : rest;
		if (itemSchema !== undefined) {
			validateNode(itemSchema, item, [...path, index], scope, depth);
		}
	}
}

function validateObject(
	schema: Record<string, unknown>,
	value: Record<string, unknown>,
	path: (number | string)[],
	scope: ValidationScope,
	depth: number
) {
	const properties = isPlainObject(schema.properties) ? schema.properties : {};
	if (Array.isArray(schema.required)) {
		for (const key of schema.required) {
			if (typeof key === "string" && !Object.hasOwn(value, key)) {
				report(scope, [...path, key], "required property is missing");
			}
		}
	}
	const keys = Object.keys(value);
	const minProperties = readNumber(schema, "minProperties");
	const maxProperties = readNumber(schema, "maxProperties");
	if (minProperties !== undefined && keys.length < minProperties) {
		report(scope, path, `must have at least ${minProperties} properties`);
	}
	if (maxProperties !== undefined && keys.length > maxProperties) {
		report(scope, path, `must have at most ${maxProperties} properties`);
	}
	for (const key of keys) {
		if (Object.hasOwn(properties, key)) {
			validateNode(properties[key], value[key], [...path, key], scope, depth);
			continue;
		}
		const additional = schema.additionalProperties;
		if (additional === false) {
			report(scope, [...path, key], "unexpected property");
		} else if (isPlainObject(additional)) {
			validateNode(additional, value[key], [...path, key], scope, depth);
		}
	}
}

function validateCombinators(
	schema: Record<string, unknown>,
	value: Json,
	path: (number | string)[],
	scope: ValidationScope,
	depth: number
) {
	if (Array.isArray(schema.allOf)) {
		for (const branch of schema.allOf) {
			validateNode(branch, value, path, scope, depth);
		}
	}
	const passing = (branches: unknown[]) =>
		branches.filter((branch) => isValidAgainst(branch, value, scope, depth))
			.length;
	if (Array.isArray(schema.anyOf) && passing(schema.anyOf) === 0) {
		report(scope, path, "must match at least one allowed schema (anyOf)");
	}
	if (Array.isArray(schema.oneOf) && passing(schema.oneOf) !== 1) {
		report(scope, path, "must match exactly one allowed schema (oneOf)");
	}
	if (
		schema.not !== undefined &&
		isValidAgainst(schema.not, value, scope, depth)
	) {
		report(scope, path, "must not match the excluded schema (not)");
	}
}

function isValidAgainst(
	schema: unknown,
	value: Json,
	scope: ValidationScope,
	depth: number
): boolean {
	const probe: ValidationScope = { issues: [], root: scope.root };
	validateNode(schema, value, [], probe, depth);
	return probe.issues.length === 0;
}

function validateNode(
	schema: unknown,
	value: Json,
	path: (number | string)[],
	scope: ValidationScope,
	depth: number
) {
	if (schema === true || schema === undefined) {
		return;
	}
	if (schema === false) {
		report(scope, path, "no value is allowed here");
		return;
	}
	if (!isPlainObject(schema)) {
		return;
	}
	if (typeof schema.$ref === "string") {
		if (depth >= MAX_REF_DEPTH) {
			report(scope, path, `$ref nesting exceeded ${MAX_REF_DEPTH} levels`);
			return;
		}
		const target = resolveRef(scope.root, schema.$ref);
		if (target !== undefined) {
			validateNode(target, value, path, scope, depth + 1);
		}
	}
	if (!validateType(schema, value, path, scope)) {
		return;
	}
	validateEnumConst(schema, value, path, scope);
	if (typeof value === "string") {
		validateString(schema, value, path, scope);
	} else if (typeof value === "number") {
		validateNumber(schema, value, path, scope);
	} else if (Array.isArray(value)) {
		validateArray(schema, value, path, scope, depth);
	} else if (isPlainObject(value)) {
		validateObject(schema, value, path, scope, depth);
	}
	validateCombinators(schema, value, path, scope, depth);
}

/**
 * Validate a JSON value against a JSON Schema document. Returns every issue
 * found (empty when the value conforms).
 */
export function validateJsonSchema(
	schema: unknown,
	value: unknown
): SchemaIssue[] {
	const scope: ValidationScope = { issues: [], root: schema };
	validateNode(schema, value, [], scope, 0);
	return scope.issues;
}
