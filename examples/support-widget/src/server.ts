#!/usr/bin/env bun

/**
 * A tiny local host for the ResolveDesk sample.
 *
 * `RYU_SUPPORT_LIVE=1 bun run dev` uses the same `defineModel` gateway client
 * the SDK examples use. The default preview intentionally stays credential-free:
 * it exercises the exact Runnable and structured widget result with a grounded
 * fallback, so the UI is always runnable in a fresh checkout.
 */

import { readFileSync } from "node:fs";
import { defineModel, type GatewayClient } from "@ryuhq/sdk";
import { manifest, supportRenderTool } from "./app.ts";

const PORT = Number(process.env.PORT ?? 4173);
const LIVE_GATEWAY = process.env.RYU_SUPPORT_LIVE === "1";
const INDEX_HTML = readFileSync(
	new URL("./index.html", import.meta.url),
	"utf8"
);
const WIDGET_HTML = readFileSync(
	new URL("./widget.html", import.meta.url),
	"utf8"
);

function log(event: string, detail: string): void {
	process.stdout.write(`[ryu-support-widget] ${event} ${detail}\n`);
}

function demoGateway(): GatewayClient {
	return {
		async chat() {
			throw new Error("preview mode uses the grounded answer path");
		},
		async *stream() {
			yield { content: null, finishReason: null };
			throw new Error("preview mode uses the grounded answer path");
		},
	};
}

function gateway(): GatewayClient {
	if (!LIVE_GATEWAY) {
		return demoGateway();
	}
	const model = defineModel(process.env.RYU_MODEL ?? "default");
	return {
		chat: (messages) => model.chat(messages),
		stream: (messages) => model.stream(messages),
	};
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

async function readMessage(request: Request): Promise<string> {
	const body = (await request.json()) as { message?: unknown };
	if (typeof body.message !== "string" || !body.message.trim()) {
		throw new Error("message must be a non-empty string");
	}
	return body.message;
}

const server = Bun.serve({
	port: PORT,
	async fetch(request) {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/") {
			return new Response(INDEX_HTML, {
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		}
		if (request.method === "GET" && url.pathname === "/widget.html") {
			return new Response(WIDGET_HTML, {
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		}
		if (request.method === "GET" && url.pathname === "/api/health") {
			return json({
				app: manifest.id,
				runtimeMode: LIVE_GATEWAY ? "gateway" : "preview",
				status: "ok",
			});
		}
		if (request.method === "GET" && url.pathname === "/api/manifest") {
			return json(manifest);
		}
		if (
			request.method === "POST" &&
			(url.pathname === "/api/chat" || url.pathname === "/api/handoff")
		) {
			try {
				const message = await readMessage(request);
				if (url.pathname === "/api/handoff") {
					log("handoff", `queued message_length=${message.length}`);
					return json({
						structuredContent: {
							answer:
								"A human-support handoff is queued. Someone will follow up shortly.",
							handoff: true,
							mode: "grounded",
							sources: [],
							suggestedReplies: [],
						},
						runtimeMode: LIVE_GATEWAY ? "gateway" : "preview",
					});
				}

				log(
					"runnable",
					`resolved id=${supportRenderTool.id} message_length=${message.length}`
				);
				const result = await supportRenderTool.run(
					{ message },
					{ gateway: gateway() }
				);
				log(
					"result",
					`structured_content=true mode=${result.structuredContent.mode}`
				);
				const gatewayConnected = result.structuredContent.mode === "ai";
				return json({
					structuredContent: result.structuredContent,
					gatewayConnected,
					runtimeMode: gatewayConnected ? "gateway" : "preview",
				});
			} catch (error) {
				log("error", String(error));
				return json({ error: String(error) }, 400);
			}
		}

		return new Response("Not found", { status: 404 });
	},
});

log(
	"listening",
	`http://localhost:${server.port} runtime=${LIVE_GATEWAY ? "gateway" : "preview"}`
);
