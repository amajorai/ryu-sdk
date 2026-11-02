/**
 * Standard Schema + Standard JSON Schema interfaces.
 *
 * Vendored type-only copies of the community specs (https://standardschema.dev)
 * so the SDK accepts any conforming validator — zod 4, valibot, arktype,
 * effect/schema, … — without depending on any one of them. The spec authors
 * ask libraries to copy these interfaces rather than import a package.
 *
 * `StandardSchemaV1` describes validation + type inference; the optional
 * `StandardJSONSchemaV1` props describe JSON Schema conversion (zod 4.2+ ships
 * both on `~standard`). The SDK needs the JSON Schema for the wire (model tool
 * definitions, `response_format`), so a validator that only implements
 * validation can be paired with a hand-written JSON Schema via `withJsonSchema`.
 */

/** The Standard Schema interface (v1). */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
	readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}

// biome-ignore lint/style/noNamespace: the Standard Schema spec defines its helper types in a namespace; copied verbatim for interoperability.
export declare namespace StandardSchemaV1 {
	/** The Standard Schema properties interface. */
	export interface Props<Input = unknown, Output = Input> {
		readonly types?: Types<Input, Output> | undefined;
		readonly validate: (
			value: unknown
		) => Result<Output> | Promise<Result<Output>>;
		readonly vendor: string;
		readonly version: 1;
	}

	/** The result of a validation. */
	export type Result<Output> = FailureResult | SuccessResult<Output>;

	/** A successful validation. */
	export interface SuccessResult<Output> {
		readonly issues?: undefined;
		readonly value: Output;
	}

	/** A failed validation. */
	export interface FailureResult {
		readonly issues: readonly Issue[];
	}

	/** One validation issue. */
	export interface Issue {
		readonly message: string;
		readonly path?: readonly (PropertyKey | PathSegment)[] | undefined;
	}

	/** A path segment carrying its key. */
	export interface PathSegment {
		readonly key: PropertyKey;
	}

	/** Inferable input/output types. */
	export interface Types<Input = unknown, Output = Input> {
		readonly input: Input;
		readonly output: Output;
	}

	/** Infer the input type of a Standard Schema. */
	export type InferInput<Schema extends StandardSchemaV1> = NonNullable<
		Schema["~standard"]["types"]
	>["input"];

	/** Infer the output type of a Standard Schema. */
	export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
		Schema["~standard"]["types"]
	>["output"];
}

/** JSON Schema dialects a Standard JSON Schema converter may be asked for. */
export type StandardJsonSchemaTarget =
	| "draft-2020-12"
	| "draft-07"
	| "openapi-3.0"
	| (string & {});

/** Options passed to a Standard JSON Schema converter. */
export interface StandardJsonSchemaOptions {
	readonly libraryOptions?: Record<string, unknown> | undefined;
	readonly target: StandardJsonSchemaTarget;
}

/** The JSON Schema conversion props of the Standard JSON Schema spec (v1). */
export interface StandardJsonSchemaConverter {
	readonly input: (
		options: StandardJsonSchemaOptions
	) => Record<string, unknown>;
	readonly output: (
		options: StandardJsonSchemaOptions
	) => Record<string, unknown>;
}

/** A Standard Schema that can also describe itself as JSON Schema. */
export interface StandardSchemaWithJsonSchema<Input = unknown, Output = Input>
	extends StandardSchemaV1<Input, Output> {
	readonly "~standard": StandardSchemaV1.Props<Input, Output> & {
		readonly jsonSchema: StandardJsonSchemaConverter;
	};
}

/** Infer the parsed (output) type of any Standard Schema. */
export type InferSchemaOutput<Schema extends StandardSchemaV1> =
	StandardSchemaV1.InferOutput<Schema>;

/** Infer the accepted (input) type of any Standard Schema. */
export type InferSchemaInput<Schema extends StandardSchemaV1> =
	StandardSchemaV1.InferInput<Schema>;

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
	return typeof value === "object" && value !== null;
}

/** True when `value` implements the Standard Schema v1 interface. */
export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
	if (!(isRecord(value) || typeof value === "function")) {
		return false;
	}
	const props: unknown = Reflect.get(value, "~standard");
	return (
		isRecord(props) &&
		props.version === 1 &&
		typeof props.validate === "function"
	);
}

/** True when a Standard Schema also implements Standard JSON Schema. */
export function hasStandardJsonSchema(
	value: StandardSchemaV1
): value is StandardSchemaWithJsonSchema {
	const converter: unknown = Reflect.get(value["~standard"], "jsonSchema");
	return (
		isRecord(converter) &&
		typeof converter.input === "function" &&
		typeof converter.output === "function"
	);
}
