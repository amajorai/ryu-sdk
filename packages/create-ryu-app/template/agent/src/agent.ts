#!/usr/bin/env bun
/**
 * Starter Agent — a declarative, loop-owning Ryu agent with one local tool.
 *
 * Run with:
 *   bun dev            (or: bun run src/agent.ts "your question")
 *
 * Zero setup beyond a running Ryu node: no third-party API key, no account
 * connection, no Core agent to create. The agent OWNS its tool-calling loop —
 * you declare instructions, a model and tools, then call `generate()`.
 *
 * Every model call goes through the Ryu gateway of your local node. Set
 * RYU_GATEWAY_URL (default http://127.0.0.1:7981) and, if your gateway requires
 * auth, RYU_GATEWAY_TOKEN. Set RYU_MODEL to any model id your gateway can route.
 * No provider key belongs in this file — credentials live in the gateway config.
 *
 * Want to call an existing Ryu tool (Gmail, GitHub, …) instead of a local one?
 * Scaffold the `expense-agent` template: `bunx create-ryu-app my-agent
 * --template expense-agent`.
 */

import { defineTool } from "@ryuhq/sdk";
import { Agent } from "@ryuhq/sdk/agent";

const MODEL_ID = process.env.RYU_MODEL ?? "gpt-4o-mini";
const WHITESPACE = /\s+/;

/**
 * A local tool runs in this process — no Core round-trip, no grants. Its JSON
 * Schema is what the model sees; `run` receives the validated arguments.
 */
const wordCount = defineTool<
	{ text: string },
	{ characters: number; words: number }
>({
	id: "word-count",
	name: "Word Count",
	description: "Count the words and characters in a piece of text.",
	schema: {
		type: "object",
		properties: {
			text: { type: "string", description: "The text to measure" },
		},
		required: ["text"],
	},
	run({ text }) {
		const words = text.trim().split(WHITESPACE).filter(Boolean).length;
		return Promise.resolve({ words, characters: text.length });
	},
});

const agent = new Agent({
	name: "__APP_NAME__",
	model: MODEL_ID,
	instructions:
		"You are a concise writing assistant running inside Ryu. When the user " +
		"asks about the length of some text, call the wordCount tool instead of " +
		"guessing, then answer in one or two sentences.",
	tools: { wordCount },
});

const prompt =
	process.argv.slice(2).join(" ") ||
	'How many words are in "Ryu routes every model call through its gateway"?';

const result = await agent.generate(prompt);

process.stdout.write(`\n${result.text}\n`);
process.stdout.write(`\n(${result.steps} step(s) via ${MODEL_ID})\n`);
