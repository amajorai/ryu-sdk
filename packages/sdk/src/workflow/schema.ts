/**
 * Schema seam for the workflow DSL.
 *
 * Steps and workflows accept any [Standard Schema](https://standardschema.dev)
 * validator (zod 4, valibot, arktype, …) for `inputSchema`, `outputSchema`,
 * `resumeSchema`, and `suspendSchema`. The DSL never depends on one schema
 * library: it reads the `~standard` contract, validates with it, and infers
 * TypeScript types from it.
 */

/** The Standard Schema v1 contract (the subset the DSL reads). */
export interface StandardSchemaV1<TInput = unknown, TOutput = TInput> {
	readonly "~standard": {
		readonly types?: { readonly input: TInput; readonly output: TOutput };
		readonly validate: (
			value: unknown
		) => StandardResult<TOutput> | Promise<StandardResult<TOutput>>;
		readonly vendor: string;
		readonly version: 1;
	};
}

/** One validation issue reported by a Standard Schema validator. */
export interface StandardIssue {
	readonly message: string;
	readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[];
}

/** A Standard Schema validation result. */
export type StandardResult<T> =
	| { readonly issues?: undefined; readonly value: T }
	| { readonly issues: readonly StandardIssue[] };

/** The validated (output) type of a schema. */
export type InferSchema<S> =
	S extends StandardSchemaV1<unknown, infer O> ? O : unknown;

/** Raised when a value fails a step or workflow schema. */
export class WorkflowValidationError extends Error {
	readonly issues: readonly StandardIssue[];
	readonly where: string;

	constructor(where: string, issues: readonly StandardIssue[]) {
		super(`${where} failed validation: ${formatIssues(issues)}`);
		this.name = "WorkflowValidationError";
		this.issues = issues;
		this.where = where;
	}
}

function issuePath(issue: StandardIssue): string {
	if (!issue.path || issue.path.length === 0) {
		return "";
	}
	const parts = issue.path.map((segment) =>
		typeof segment === "object" ? String(segment.key) : String(segment)
	);
	return `${parts.join(".")}: `;
}

function formatIssues(issues: readonly StandardIssue[]): string {
	return issues
		.map((issue) => `${issuePath(issue)}${issue.message}`)
		.join("; ");
}

/**
 * Validate `value` against `schema` when one is set. Returns the schema's
 * (possibly transformed) output, or the value unchanged when there is no
 * schema. Throws {@link WorkflowValidationError} on failure.
 */
export async function validateWithSchema<T>(
	schema: StandardSchemaV1<unknown, T> | undefined,
	value: unknown,
	where: string
): Promise<T> {
	if (!schema) {
		return value as T;
	}
	const result = await schema["~standard"].validate(value);
	if (result.issues) {
		throw new WorkflowValidationError(where, result.issues);
	}
	return result.value;
}
