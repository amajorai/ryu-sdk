import { z } from "zod";
import {
	type CompileOptions,
	compileTemplate,
	MissingTemplateVariablesError,
	type TemplateValues,
} from "./template.ts";

/**
 * Prompt versions as the registry serves them, and the `TextPrompt` /
 * `ChatPrompt` objects `prompts.get()` returns. The wire shape mirrors
 * `@ryuhq/protocol/prompt-hub` (`PromptVersionWire`); both the Core node
 * registry and the control-plane registry serve it.
 */

export const PROMPT_MESSAGE_ROLES = [
	"system",
	"user",
	"assistant",
	"developer",
] as const;
export type PromptMessageRole = (typeof PROMPT_MESSAGE_ROLES)[number];

const chatMessageSchema = z.object({
	role: z.enum(PROMPT_MESSAGE_ROLES),
	content: z.string(),
});
const placeholderSchema = z.object({
	type: z.literal("placeholder"),
	name: z.string(),
});

/** A chat entry as stored: a templated message or a placeholder slot. */
export type PromptChatEntry =
	| z.infer<typeof chatMessageSchema>
	| z.infer<typeof placeholderSchema>;

/** A compiled chat message, ready for a model call. */
export interface PromptMessage {
	content: string;
	role: PromptMessageRole | "tool";
}

export const promptModelConfigSchema = z.object({
	model: z.string().optional(),
	provider: z.string().optional(),
	temperature: z.number().optional(),
	topP: z.number().optional(),
	maxTokens: z.number().optional(),
	stop: z.array(z.string()).optional(),
	seed: z.number().optional(),
});
export type PromptModelConfig = z.infer<typeof promptModelConfigSchema>;

export const promptVersionWireSchema = z.object({
	name: z.string(),
	version: z.number().int(),
	type: z.enum(["text", "chat"]),
	template: z.string().nullable(),
	messages: z.array(z.union([chatMessageSchema, placeholderSchema])).nullable(),
	variables: z.array(z.string()),
	placeholders: z.array(z.string()).catch(() => []),
	modelConfig: promptModelConfigSchema.catch(() => ({})),
	labels: z.array(z.string()).catch(() => []),
	commitMessage: z.string().nullable().catch(null),
	createdAt: z.string().catch(""),
	createdBy: z.string().nullable().catch(null),
});
export type PromptVersionWire = z.infer<typeof promptVersionWireSchema>;

interface PromptBase {
	/** True when this is the caller's `fallback`, not a registry version. */
	readonly isFallback: boolean;
	/** Labels pointing at this version when it was fetched (with `latest`). */
	readonly labels: string[];
	readonly modelConfig: PromptModelConfig;
	readonly name: string;
	readonly variables: string[];
	/** 0 for a fallback. */
	readonly version: number;
}

export interface ChatCompileOptions extends CompileOptions {
	/** Messages that fill each placeholder slot (e.g. `history`). */
	placeholders?: Record<string, PromptMessage[]>;
}

/** A single-template prompt. `compile()` returns the rendered string. */
export class TextPrompt implements PromptBase {
	readonly type = "text" as const;
	readonly name: string;
	readonly version: number;
	readonly template: string;
	readonly variables: string[];
	readonly labels: string[];
	readonly modelConfig: PromptModelConfig;
	readonly isFallback: boolean;

	constructor(input: {
		isFallback?: boolean;
		labels?: string[];
		modelConfig?: PromptModelConfig;
		name: string;
		template: string;
		variables: string[];
		version: number;
	}) {
		this.name = input.name;
		this.version = input.version;
		this.template = input.template;
		this.variables = input.variables;
		this.labels = input.labels ?? [];
		this.modelConfig = input.modelConfig ?? {};
		this.isFallback = input.isFallback ?? false;
	}

	compile(values: TemplateValues = {}, options: CompileOptions = {}): string {
		return compileTemplate(this.template, values, options);
	}

	/** The rendered template as one system message. */
	toMessages(
		values: TemplateValues = {},
		options: CompileOptions = {}
	): PromptMessage[] {
		return [{ role: "system", content: this.compile(values, options) }];
	}

	/** The rendered template, for an agent's `instructions`. */
	toInstructions(
		values: TemplateValues = {},
		options: CompileOptions = {}
	): string {
		return this.compile(values, options);
	}
}

/** A message-list prompt. `compile()` returns the rendered messages. */
export class ChatPrompt implements PromptBase {
	readonly type = "chat" as const;
	readonly name: string;
	readonly version: number;
	readonly messages: PromptChatEntry[];
	readonly variables: string[];
	readonly placeholders: string[];
	readonly labels: string[];
	readonly modelConfig: PromptModelConfig;
	readonly isFallback: boolean;

	constructor(input: {
		isFallback?: boolean;
		labels?: string[];
		messages: PromptChatEntry[];
		modelConfig?: PromptModelConfig;
		name: string;
		placeholders?: string[];
		variables: string[];
		version: number;
	}) {
		this.name = input.name;
		this.version = input.version;
		this.messages = input.messages;
		this.variables = input.variables;
		this.placeholders =
			input.placeholders ??
			input.messages.flatMap((entry) => ("type" in entry ? [entry.name] : []));
		this.labels = input.labels ?? [];
		this.modelConfig = input.modelConfig ?? {};
		this.isFallback = input.isFallback ?? false;
	}

	/**
	 * Render every message and splice in placeholder messages. A placeholder
	 * with no messages is dropped, or reported as missing when `strict`.
	 */
	compile(
		values: TemplateValues = {},
		options: ChatCompileOptions = {}
	): PromptMessage[] {
		const out: PromptMessage[] = [];
		const missing = new Set<string>();
		for (const entry of this.messages) {
			if ("type" in entry) {
				const filled = options.placeholders?.[entry.name];
				if (filled === undefined) {
					missing.add(entry.name);
				}
				out.push(...(filled ?? []));
				continue;
			}
			try {
				out.push({
					role: entry.role,
					content: compileTemplate(entry.content, values, options),
				});
			} catch (error) {
				if (!(error instanceof MissingTemplateVariablesError)) {
					throw error;
				}
				for (const name of error.missing) {
					missing.add(name);
				}
			}
		}
		if (options.strict && missing.size > 0) {
			throw new MissingTemplateVariablesError([...missing]);
		}
		return out;
	}

	toMessages(
		values: TemplateValues = {},
		options: ChatCompileOptions = {}
	): PromptMessage[] {
		return this.compile(values, options);
	}

	/**
	 * The rendered system (and developer) messages joined by a blank line, for
	 * an agent's `instructions`. Other roles belong in the conversation.
	 */
	toInstructions(
		values: TemplateValues = {},
		options: ChatCompileOptions = {}
	): string {
		return this.compile(values, options)
			.filter(
				(message) => message.role === "system" || message.role === "developer"
			)
			.map((message) => message.content)
			.join("\n\n");
	}
}

export type Prompt = TextPrompt | ChatPrompt;

/** Build the prompt object for a registry version. */
export function promptFromWire(wire: PromptVersionWire): Prompt {
	if (wire.type === "chat") {
		return new ChatPrompt({
			name: wire.name,
			version: wire.version,
			messages: wire.messages ?? [],
			variables: wire.variables,
			placeholders: wire.placeholders,
			labels: wire.labels,
			modelConfig: wire.modelConfig,
		});
	}
	return new TextPrompt({
		name: wire.name,
		version: wire.version,
		template: wire.template ?? "",
		variables: wire.variables,
		labels: wire.labels,
		modelConfig: wire.modelConfig,
	});
}
