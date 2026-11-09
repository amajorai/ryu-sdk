/**
 * `ryu validate <dir>` — check a manifest against BOTH contracts an author meets:
 *
 *  1. the SDK's Zod `PluginManifestSchema` (what `ryu pack` enforces), and
 *  2. the public JSON Schema published at https://ryuhq.com/schemas/plugin.json
 *     (the copy in `../generated/plugin-schema.json` is kept byte-identical by
 *     the repository's schema sync check).
 *
 * The JSON Schema is the stricter authoring-time check: it rejects a misspelled
 * turn-hook phase or settings field type that Core would otherwise accept and
 * silently never use.
 */

import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import publicSchema from "../generated/plugin-schema.json" with {
	type: "json",
};
import { PluginManifestSchema } from "../manifest.ts";

type SchemaInput = Parameters<AjvJsonSchemaValidator["getValidator"]>[0];

/** One validation finding, attributed to the contract that raised it. */
export interface ManifestFinding {
	message: string;
	source: "json-schema" | "sdk";
}

/**
 * Drop `format` annotations before compiling. They are advisory in the public
 * schema (Rust integer widths such as `uint64`, plus `uri`), and an unknown
 * format would otherwise print a compiler warning on every run.
 */
function withoutFormats(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(withoutFormats);
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value)) {
			if (key === "format" && typeof child === "string") {
				continue;
			}
			out[key] = withoutFormats(child);
		}
		return out;
	}
	return value;
}

function isSchemaObject(value: unknown): value is SchemaInput {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

let compiled: ReturnType<AjvJsonSchemaValidator["getValidator"]> | null = null;

function publicSchemaValidator() {
	if (compiled) {
		return compiled;
	}
	const schema = withoutFormats(publicSchema);
	if (!isSchemaObject(schema)) {
		throw new Error("bundled public manifest schema is not an object");
	}
	compiled = new AjvJsonSchemaValidator().getValidator(schema);
	return compiled;
}

/** Validate a parsed manifest value; an empty array means it passes both. */
export function validateManifestValue(value: unknown): ManifestFinding[] {
	const findings: ManifestFinding[] = [];
	const sdk = PluginManifestSchema.safeParse(value);
	if (!sdk.success) {
		for (const issue of sdk.error.issues) {
			const field = issue.path.join(".") || "(root)";
			findings.push({ source: "sdk", message: `${field}: ${issue.message}` });
		}
	}
	const result = publicSchemaValidator()(value);
	if (!result.valid) {
		for (const message of result.errorMessage.split(", data")) {
			findings.push({
				source: "json-schema",
				message: message.startsWith("data") ? message : `data${message}`,
			});
		}
	}
	return findings;
}
