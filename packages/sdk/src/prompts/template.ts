/**
 * The prompt template language: a logic-less mustache subset.
 *
 * - `{{name}}`, `{{{name}}}`, `{{& name}}` insert a value. Prompts are not
 *   HTML, so no form escapes anything.
 * - Dotted paths (`{{user.name}}`) walk objects; `{{.}}` is the current item.
 * - `{{#name}}…{{/name}}` renders for a truthy value, once per item of a
 *   non-empty list, or with an object pushed as the lookup context.
 * - `{{^name}}…{{/name}}` renders when the value is falsy or an empty list.
 * - `{{! comment }}` is dropped.
 * - A section or comment tag alone on its line removes that whole line.
 *
 * Lookups try the innermost context first and fall back outwards, as in
 * mustache. The registry, Core and this compiler share the golden cases in
 * `packages/protocol/src/fixtures/prompt-templates.json`.
 */

export class TemplateSyntaxError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TemplateSyntaxError";
	}
}

/** Thrown by a strict compile when values are missing. */
export class MissingTemplateVariablesError extends Error {
	readonly missing: string[];

	constructor(missing: string[]) {
		super(`missing prompt variables: ${missing.join(", ")}`);
		this.name = "MissingTemplateVariablesError";
		this.missing = missing;
	}
}

type Token =
	| { kind: "text"; value: string }
	| { kind: "var"; path: string }
	| { kind: "open"; path: string; inverted: boolean }
	| { kind: "close"; path: string }
	| { kind: "comment" };

type Node =
	| { kind: "text"; value: string }
	| { kind: "var"; path: string }
	| { kind: "section"; path: string; inverted: boolean; children: Node[] };

const PATH_RE =
	/^(?:\.|[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*)$/u;
const SIGILS = new Set(["#", "^", "/", "&"]);

function tokenize(template: string): Token[] {
	const tokens: Token[] = [];
	let cursor = 0;
	while (cursor < template.length) {
		const open = template.indexOf("{{", cursor);
		if (open === -1) {
			tokens.push({ kind: "text", value: template.slice(cursor) });
			break;
		}
		if (open > cursor) {
			tokens.push({ kind: "text", value: template.slice(cursor, open) });
		}
		const triple = template.startsWith("{{{", open);
		const closer = triple ? "}}}" : "}}";
		const start = open + (triple ? 3 : 2);
		const close = template.indexOf(closer, start);
		if (close === -1) {
			throw new TemplateSyntaxError(`unterminated tag at offset ${open}`);
		}
		const raw = template.slice(start, close).trim();
		cursor = close + closer.length;
		const sigil = triple ? "" : raw.charAt(0);
		if (sigil === "!") {
			tokens.push({ kind: "comment" });
			continue;
		}
		const body = SIGILS.has(sigil) ? raw.slice(1).trim() : raw;
		if (!PATH_RE.test(body)) {
			throw new TemplateSyntaxError(
				`invalid tag name "${body}" at offset ${open}`
			);
		}
		if (sigil === "#" || sigil === "^") {
			tokens.push({ kind: "open", path: body, inverted: sigil === "^" });
		} else if (sigil === "/") {
			tokens.push({ kind: "close", path: body });
		} else {
			tokens.push({ kind: "var", path: body });
		}
	}
	return stripStandaloneLines(tokens);
}

const isBlank = (value: string) => /^[ \t]*$/u.test(value);

/** Remove the line around a section or comment tag that stands alone on it. */
function stripStandaloneLines(tokens: Token[]): Token[] {
	for (const [index, token] of tokens.entries()) {
		if (token.kind === "text" || token.kind === "var") {
			continue;
		}
		const before = tokens[index - 1];
		const after = tokens[index + 1];
		let lineStart: string;
		if (before === undefined) {
			lineStart = "";
		} else if (before.kind === "text") {
			lineStart = before.value.slice(before.value.lastIndexOf("\n") + 1);
			if (!before.value.includes("\n") && index - 1 !== 0) {
				continue;
			}
		} else {
			continue;
		}
		let lineEnd: string;
		if (after === undefined) {
			lineEnd = "";
		} else if (after.kind === "text") {
			const newline = after.value.indexOf("\n");
			lineEnd = newline === -1 ? after.value : after.value.slice(0, newline);
			if (newline === -1 && index + 1 !== tokens.length - 1) {
				continue;
			}
		} else {
			continue;
		}
		if (!(isBlank(lineStart) && isBlank(lineEnd))) {
			continue;
		}
		if (before?.kind === "text") {
			before.value = before.value.slice(
				0,
				before.value.length - lineStart.length
			);
		}
		if (after?.kind === "text") {
			const newline = after.value.indexOf("\n");
			after.value = newline === -1 ? "" : after.value.slice(newline + 1);
		}
	}
	return tokens;
}

function parse(template: string): Node[] {
	const root: Node[] = [];
	const stack: Array<{ children: Node[]; path: string }> = [];
	let current = root;
	for (const token of tokenize(template)) {
		if (token.kind === "text") {
			if (token.value !== "") {
				current.push(token);
			}
		} else if (token.kind === "var") {
			current.push(token);
		} else if (token.kind === "open") {
			const section: Node = {
				kind: "section",
				path: token.path,
				inverted: token.inverted,
				children: [],
			};
			current.push(section);
			stack.push({ children: current, path: token.path });
			current = section.children;
		} else if (token.kind === "close") {
			const frame = stack.pop();
			if (frame?.path !== token.path) {
				throw new TemplateSyntaxError(
					frame
						? `section "${frame.path}" closed by "${token.path}"`
						: `unopened section "${token.path}" closed`
				);
			}
			current = frame.children;
		}
	}
	const unclosed = stack.pop();
	if (unclosed) {
		throw new TemplateSyntaxError(`section "${unclosed.path}" is never closed`);
	}
	return root;
}

/**
 * Every name a template may read, in first-use order (the first segment of
 * each variable and section tag). Throws `TemplateSyntaxError`.
 */
export function templateVariables(template: string): string[] {
	const seen = new Set<string>();
	const visit = (nodes: Node[]) => {
		for (const node of nodes) {
			if (node.kind === "text") {
				continue;
			}
			if (node.path !== ".") {
				seen.add(node.path.split(".")[0] ?? node.path);
			}
			if (node.kind === "section") {
				visit(node.children);
			}
		}
	};
	visit(parse(template));
	return [...seen];
}

export type TemplateValues = Record<string, unknown>;

const MISSING = Symbol("missing");

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lookup(stack: unknown[], path: string): unknown {
	if (path === ".") {
		return stack.at(-1);
	}
	const [head = "", ...rest] = path.split(".");
	for (let index = stack.length - 1; index >= 0; index -= 1) {
		const context = stack[index];
		if (isRecord(context) && Object.hasOwn(context, head)) {
			let value: unknown = context[head];
			for (const segment of rest) {
				// Own fields only: `{{user.constructor}}` must not reach the prototype.
				value =
					isRecord(value) && Object.hasOwn(value, segment)
						? value[segment]
						: undefined;
			}
			return value;
		}
	}
	return MISSING;
}

function stringify(value: unknown): string {
	if (value === undefined || value === null || value === MISSING) {
		return "";
	}
	if (typeof value === "string") {
		return value;
	}
	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint"
	) {
		return String(value);
	}
	return JSON.stringify(value) ?? "";
}

function isFalsy(value: unknown): boolean {
	return (
		value === MISSING || !value || (Array.isArray(value) && value.length === 0)
	);
}

function render(nodes: Node[], stack: unknown[], missing: Set<string>): string {
	let out = "";
	for (const node of nodes) {
		if (node.kind === "text") {
			out += node.value;
			continue;
		}
		const value = lookup(stack, node.path);
		if (value === MISSING && stack.length === 1) {
			missing.add(node.path.split(".")[0] ?? node.path);
		}
		if (node.kind === "var") {
			out += stringify(value);
		} else if (node.inverted) {
			if (isFalsy(value)) {
				out += render(node.children, stack, missing);
			}
		} else if (Array.isArray(value)) {
			for (const item of value) {
				out += render(node.children, [...stack, item], missing);
			}
		} else if (!isFalsy(value)) {
			out += render(node.children, [...stack, value], missing);
		}
	}
	return out;
}

export interface CompileOptions {
	/** Throw `MissingTemplateVariablesError` instead of rendering blanks. */
	strict?: boolean;
}

/** Render `template` with `values`. Throws `TemplateSyntaxError`. */
export function compileTemplate(
	template: string,
	values: TemplateValues = {},
	options: CompileOptions = {}
): string {
	const missing = new Set<string>();
	const output = render(parse(template), [values], missing);
	if (options.strict && missing.size > 0) {
		throw new MissingTemplateVariablesError([...missing]);
	}
	return output;
}
