import { type PromptClient, prompts } from "./client.ts";
import type { ChatCompileOptions, Prompt } from "./prompt.ts";
import type { TemplateValues } from "./template.ts";

/**
 * Prompt references an `Agent` accepts as `instructions`. They are resolved
 * when a run starts, so a label move (e.g. promoting a new `production`
 * version) reaches the next run without redeploying the agent.
 */
export interface PromptReference {
	/** Registry client; defaults to the shared `prompts` client. */
	client?: PromptClient;
	/** Used when the registry cannot be reached (see `prompts.get`). */
	fallback?: string;
	label?: string;
	/** Registry prompt name. */
	prompt: string;
	/** Throw when a variable is missing instead of rendering it blank. */
	strict?: boolean;
	/** Template values. */
	variables?: TemplateValues;
	version?: number;
}

/** A registry reference or an already-fetched prompt (with values). */
export type PromptInstructions =
	| PromptReference
	| { prompt: Prompt; strict?: boolean; variables?: TemplateValues };

export function isPromptInstructions(
	value: unknown
): value is PromptInstructions {
	return typeof value === "object" && value !== null && "prompt" in value;
}

/** Resolve `instructions` (a string or a prompt reference) to text. */
export async function resolveInstructions(
	instructions: string | PromptInstructions | undefined
): Promise<string | undefined> {
	if (instructions === undefined || typeof instructions === "string") {
		return instructions;
	}
	const options: ChatCompileOptions = { strict: instructions.strict };
	if (typeof instructions.prompt !== "string") {
		return instructions.prompt.toInstructions(instructions.variables, options);
	}
	const reference = instructions as PromptReference;
	const client = reference.client ?? prompts;
	const prompt = await client.get(reference.prompt, {
		label: reference.label,
		version: reference.version,
		fallback: reference.fallback,
	});
	return prompt.toInstructions(reference.variables, options);
}
