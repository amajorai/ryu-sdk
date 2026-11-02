/**
 * `@ryuhq/sdk/prompts` — versioned prompts from the Ryu prompt registry.
 *
 * ```ts
 * import { prompts } from "@ryuhq/sdk/prompts";
 *
 * const triage = await prompts.get("support-triage", {
 *   label: "production",
 *   fallback: "Classify this ticket: {{ticket}}",
 * });
 * const text = triage.compile({ ticket });
 * ```
 *
 * Agents take a prompt reference as `instructions`:
 * `new Agent({ instructions: { prompt: "support-triage", variables: { team } } })`.
 */

export type {
	FetchLike,
	GetPromptOptions,
	PromptClientOptions,
	PromptFallback,
	PromptSummary,
	PromptVersionInput,
} from "./client.ts";
export {
	createPromptClient,
	DEFAULT_PROMPT_API_URL,
	fallbackPrompt,
	PromptClient,
	PromptRegistryError,
	prompts,
} from "./client.ts";
export type { PromptInstructions, PromptReference } from "./instructions.ts";
export { isPromptInstructions, resolveInstructions } from "./instructions.ts";
export type {
	ChatCompileOptions,
	Prompt,
	PromptChatEntry,
	PromptMessage,
	PromptMessageRole,
	PromptModelConfig,
	PromptVersionWire,
} from "./prompt.ts";
export { ChatPrompt, promptFromWire, TextPrompt } from "./prompt.ts";
export type { CompileOptions, TemplateValues } from "./template.ts";
export {
	compileTemplate,
	MissingTemplateVariablesError,
	TemplateSyntaxError,
	templateVariables,
} from "./template.ts";
