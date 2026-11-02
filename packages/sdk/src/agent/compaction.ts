/**
 * Context compaction for the SDK agent loop.
 *
 * When the outbound transcript grows past `threshold` estimated tokens, the
 * older turns are summarized by a side model (default: the agent's own model)
 * and replaced with one summary system message; the newest turns are kept
 * verbatim. This mirrors Core's `context.*` compaction for agents that run
 * their own loop, and is configured per agent with `Agent({ compaction })`.
 *
 * The transcript the loop keeps is never rewritten: compaction only changes
 * what one model call sends, so a later call with a bigger budget (or a failed
 * summarization) still has the full history. A summarization failure fails
 * open and sends the uncompacted request.
 */

import type { AgentMiddleware } from "./middleware.ts";
import { callModelWithTools, type LoopMessage } from "./model-call.ts";

/** `Agent({ compaction })` configuration. */
export interface CompactionOptions {
	/**
	 * Keep at least this many of the newest messages verbatim (default 6). The
	 * kept window always starts at a user message, so a tool call is never
	 * separated from its result.
	 */
	keepRecent?: number;
	/** Model that writes the summary. Defaults to the agent's model. */
	model?: string;
	/**
	 * Replace the gateway summarizer (tests, or a custom summarization
	 * strategy). Receives the dropped messages, returns the summary text.
	 */
	summarize?: (messages: LoopMessage[]) => Promise<string>;
	/** Estimated token count above which older turns are compacted. */
	threshold: number;
}

/** Where the default summarizer sends its request. */
export interface CompactionGateway {
	baseUrl: string;
	model: string;
	token?: string;
}

const DEFAULT_KEEP_RECENT = 6;
const SUMMARY_LABEL = "[Summary of the earlier conversation]";
const SUMMARIZER_PROMPT =
	"Summarize the conversation so far for an assistant that will continue it without seeing the original messages. Preserve the user's goals, key facts, decisions, constraints, tool results that matter, open questions, and what was about to happen next. Use concise bullet points. Keep it under 400 words.";

/** Estimate tokens like Core does: `ceil(chars / 3.5)`. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 3.5);
}

function messageText(message: LoopMessage): string {
	if (message.role === "assistant") {
		const calls = (message.tool_calls ?? [])
			.map((call) => `${call.function.name}(${call.function.arguments})`)
			.join("\n");
		return [message.content ?? "", calls].filter(Boolean).join("\n");
	}
	return message.content;
}

/** Estimated tokens of a whole transcript. */
export function estimateMessagesTokens(
	messages: readonly LoopMessage[]
): number {
	let total = 0;
	for (const message of messages) {
		total += estimateTokens(messageText(message)) + 4;
	}
	return total;
}

/**
 * Split a transcript into `{ head, dropped, kept }`: leading system messages,
 * the turns to summarize, and the newest turns to keep. Returns `undefined`
 * when there is nothing safe to drop.
 */
export function planCompaction(
	messages: readonly LoopMessage[],
	keepRecent: number
):
	| { dropped: LoopMessage[]; head: LoopMessage[]; kept: LoopMessage[] }
	| undefined {
	let headEnd = 0;
	while (messages[headEnd]?.role === "system") {
		headEnd += 1;
	}
	const head = messages.slice(0, headEnd);
	const body = messages.slice(headEnd);
	let cut = Math.max(0, body.length - Math.max(1, keepRecent));
	while (cut > 0 && body[cut]?.role !== "user") {
		cut -= 1;
	}
	if (cut <= 0) {
		return;
	}
	return { head, dropped: body.slice(0, cut), kept: body.slice(cut) };
}

function transcriptForSummary(messages: readonly LoopMessage[]): string {
	return messages
		.map((message) => `${message.role.toUpperCase()}: ${messageText(message)}`)
		.join("\n\n");
}

function gatewaySummarizer(gateway: CompactionGateway) {
	return async (messages: LoopMessage[]): Promise<string> => {
		const result = await callModelWithTools({
			baseUrl: gateway.baseUrl,
			model: gateway.model,
			token: gateway.token,
			messages: [
				{ role: "system", content: SUMMARIZER_PROMPT },
				{ role: "user", content: transcriptForSummary(messages) },
			],
		});
		return (result.message.content ?? "").trim();
	};
}

/** Build the compaction middleware for one agent. */
export function compactionMiddleware(
	options: CompactionOptions,
	gateway: CompactionGateway
): AgentMiddleware {
	if (!(Number.isFinite(options.threshold) && options.threshold > 0)) {
		throw new Error("compaction.threshold must be a positive number");
	}
	const keepRecent = options.keepRecent ?? DEFAULT_KEEP_RECENT;
	const summarize =
		options.summarize ??
		gatewaySummarizer({
			...gateway,
			model: options.model ?? gateway.model,
		});
	// Memo of summaries keyed by the exact dropped transcript, so an unchanged
	// cut is summarized once per run instead of once per model call.
	const memo = new Map<string, string>();
	return {
		name: "compaction",
		async wrapModelCall(request, next) {
			if (estimateMessagesTokens(request.messages) <= options.threshold) {
				return next(request);
			}
			const plan = planCompaction(request.messages, keepRecent);
			if (!plan) {
				return next(request);
			}
			const key = transcriptForSummary(plan.dropped);
			let summary = memo.get(key);
			if (summary === undefined) {
				try {
					summary = await summarize(plan.dropped);
				} catch {
					return next(request);
				}
				memo.set(key, summary);
			}
			if (!summary) {
				return next(request);
			}
			return next({
				...request,
				messages: [
					...plan.head,
					{ role: "system", content: `${SUMMARY_LABEL}\n${summary}` },
					...plan.kept,
				],
			});
		},
	};
}
