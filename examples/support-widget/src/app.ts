#!/usr/bin/env bun

/**
 * ResolveDesk — a customer-support app built with the Ryu SDK.
 *
 * The render tool is both:
 *   1. a `ToolRunnable`, so Ryu can execute its body in Core's inline sandbox;
 *   2. a `defineApp` render tool, so its structured result becomes a widget.
 *
 * The body intentionally keeps its verified help-center excerpts next to the
 * logic. A production team would replace those excerpts with a Ryu RAG call,
 * but the boundary stays the same: the widget receives data, and models are
 * reached through `host.sideModel`/the Ryu Gateway rather than a provider key.
 */

import { writeFileSync } from "node:fs";
import {
	defineApp,
	defineTool,
	type PluginManifest,
	type ToolSchema,
} from "@ryuhq/sdk";

export interface SupportInput {
	conversation?: Array<{ content: string; role: "assistant" | "user" }>;
	message: string;
	[key: string]: unknown;
}

export interface SupportPayload {
	answer: string;
	handoff: boolean;
	mode: "ai" | "grounded";
	sources: Array<{ excerpt: string; label: string }>;
	suggestedReplies: string[];
}

export interface SupportToolResult {
	content: Array<{ text: string; type: "text" }>;
	isError: false;
	structuredContent: SupportPayload;
}

export const SUPPORT_INPUT_SCHEMA: ToolSchema = {
	type: "object",
	properties: {
		message: {
			description: "The customer's latest support question.",
			type: "string",
		},
		conversation: {
			description: "Optional recent messages for conversational context.",
			items: {
				properties: {
					role: { enum: ["user", "assistant"], type: "string" },
					content: { type: "string" },
				},
				type: "object",
			},
			type: "array",
		},
	},
	required: ["message"],
};

/**
 * The executable support answer. Keep this function self-contained: Core
 * serializes its source into the `inline_deno` backend and invokes it with the
 * validated `input` plus the injected `host` capability surface.
 */
export const supportRenderTool = defineTool<SupportInput, SupportToolResult>({
	id: "resolvedesk.render",
	name: "ResolveDesk support answer",
	schema: SUPPORT_INPUT_SCHEMA,
	async run(input, context) {
		const articles = [
			{
				answer:
					"You can request a full refund within 30 days of purchase. Open Billing → Invoices, choose the invoice, and select Request refund. The refund goes back to the original payment method.",
				excerpt:
					"Refunds are available within 30 days from Billing → Invoices.",
				keywords: ["refund", "refunded", "money back", "cancel"],
				label: "Billing & refunds",
				suggestedReplies: [
					"Where can I find my invoice?",
					"I still need help with a refund",
				],
			},
			{
				answer:
					"CSV exports are available on Growth and Scale plans. Go to Reports, choose a date range, then select Export CSV. Large exports finish in the background and appear in your download tray.",
				excerpt: "Reports → Export CSV supports Growth and Scale plans.",
				keywords: ["export", "csv", "download", "report"],
				label: "Reports & exports",
				suggestedReplies: [
					"Which plans include exports?",
					"My export is still processing",
				],
			},
			{
				answer:
					"You can invite teammates from Settings → Members. Owners and admins can invite people; members can request access from their workspace admin.",
				excerpt: "Owners and admins manage invitations in Settings → Members.",
				keywords: ["invite", "member", "teammate", "access", "admin"],
				label: "Workspace access",
				suggestedReplies: [
					"What can each role do?",
					"I cannot access my workspace",
				],
			},
		];

		const message = input.message.trim().slice(0, 800);
		const normalized = message.toLowerCase();
		const article = articles.find((candidate) =>
			candidate.keywords.some((keyword) => normalized.includes(keyword))
		) ?? {
			answer:
				"I can help with billing, reports, exports, and workspace access. Tell me what you are trying to do and I will point you to the right answer.",
			excerpt:
				"ResolveDesk currently covers billing, reports, and workspace access.",
			keywords: [],
			label: "ResolveDesk help center",
			suggestedReplies: ["How do refunds work?", "How do I export a report?"],
		};

		let answer = article.answer;
		let mode: SupportPayload["mode"] = "grounded";
		const host = context as unknown as {
			log?: (...args: unknown[]) => void;
			sideModel?: (args: {
				model_pref_key?: string;
				prompt: string;
				system?: string;
			}) => Promise<string>;
		};
		const gatewayContext = context as unknown as {
			gateway?: {
				chat: (
					messages: Array<{
						content: string;
						role: "system" | "user";
					}>
				) => Promise<{ content: string }>;
			};
		};

		if (host.sideModel) {
			try {
				const generated = await host.sideModel({
					model_pref_key: "resolvedesk-support-model",
					prompt: [
						"Verified help-center excerpt:",
						article.excerpt,
						"Customer question:",
						message,
						"Reply in two concise sentences. Do not invent policy outside the excerpt.",
					].join("\n"),
					system:
						"You are a careful customer-support agent. Use only the verified help-center excerpt.",
				});
				if (generated.trim()) {
					answer = generated.trim();
					mode = "ai";
				}
			} catch (error) {
				host.log?.(
					"ResolveDesk side model unavailable; using grounded answer",
					error
				);
			}
		} else if (gatewayContext.gateway) {
			try {
				const generated = await gatewayContext.gateway.chat([
					{
						content:
							"You are a careful customer-support agent. Use only the verified help-center excerpt.",
						role: "system",
					},
					{
						content: [
							"Verified help-center excerpt:",
							article.excerpt,
							"Customer question:",
							message,
							"Reply in two concise sentences. Do not invent policy outside the excerpt.",
						].join("\n"),
						role: "user",
					},
				]);
				if (generated.content.trim()) {
					answer = generated.content.trim();
					mode = "ai";
				}
			} catch {
				// The local preview gateway intentionally throws; the grounded answer
				// keeps the sample useful without provider credentials.
			}
		}

		const payload: SupportPayload = {
			answer,
			handoff: true,
			mode,
			sources: [{ excerpt: article.excerpt, label: article.label }],
			suggestedReplies: article.suggestedReplies,
		};

		return {
			content: [{ type: "text", text: answer }],
			isError: false,
			structuredContent: payload,
		};
	},
});

const handoffTool = defineTool<
	{ message: string },
	{ content: Array<{ text: string; type: "text" }>; isError: false }
>({
	id: "resolvedesk.handoff",
	name: "ResolveDesk human handoff",
	schema: {
		type: "object",
		properties: { message: { type: "string" } },
		required: ["message"],
	},
	async run(input) {
		return {
			content: [
				{
					text: `Handoff requested: ${input.message.trim().slice(0, 500)}`,
					type: "text",
				},
			],
			isError: false,
		};
	},
});

const app = defineApp({
	id: "com.example.resolvedesk",
	title: "ResolveDesk",
	version: "0.1.0",
	slug: "resolvedesk",
	uiEntry: "src/widget.html",
	grants: ["hook:side-model"],
	tools: [
		{
			name: "render",
			description:
				"Answer a customer support question from the verified ResolveDesk help center and render the response widget.",
			inputSchema: SUPPORT_INPUT_SCHEMA as unknown as Record<string, unknown>,
			invoking: "Checking the help center…",
			invoked: "Answer ready",
			runnable: supportRenderTool,
		},
		{
			accessible: true,
			name: "handoff",
			description:
				"Create a human-support handoff from the ResolveDesk widget.",
			inputSchema: {
				type: "object",
				properties: { message: { type: "string" } },
				required: ["message"],
			},
			runnable: handoffTool,
		},
	],
});

export const manifest: PluginManifest = {
	...app,
	description:
		"A production-shaped customer-support widget built with the Ryu SDK. It grounds answers in verified help-center excerpts, routes model work through the Ryu Gateway, and keeps a human handoff available.",
	tagline: "Grounded support answers, running on Ryu.",
	category: "Customer Support",
	tags: ["example", "customer-support", "widget", "sdk"],
	keywords: ["support", "help center", "tickets", "customer service"],
	examplePrompts: [
		"How do refunds work?",
		"Can I export a report as CSV?",
		"I need help inviting a teammate",
	],
};

if (import.meta.main) {
	writeFileSync(
		new URL("../manifest.json", import.meta.url),
		`${JSON.stringify(manifest, null, 2)}\n`,
		"utf8"
	);
	process.stdout.write("wrote examples/support-widget/manifest.json\n");
}
