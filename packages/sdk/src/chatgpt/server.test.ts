import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import {
	createChatGPTPluginServer,
	listenChatGPTPluginHttp,
	RESOURCE_MIME_TYPE,
	registerChatGPTAppResource,
	registerChatGPTAppTool,
} from "./index.ts";

const temporaryRoots: string[] = [];
const AUTHORIZATION = "Bearer local-test-credential";

afterEach(() => {
	for (const directory of temporaryRoots.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

function createSkillDirectory(): string {
	const root = join(tmpdir(), `ryu-chatgpt-server-${randomUUID()}`);
	mkdirSync(join(root, "research", "references"), { recursive: true });
	temporaryRoots.push(root);
	writeFileSync(
		join(root, "research", "SKILL.md"),
		"---\nname: Research\ndescription: Write a sourced research brief.\n---\nUse search, then cite each source.\n",
		"utf8"
	);
	writeFileSync(
		join(root, "research", "references", "source-check.md"),
		"Confirm that every source supports the claim.\n",
		"utf8"
	);
	return root;
}

async function connectClient(url: string): Promise<{
	client: Client;
	transport: StreamableHTTPClientTransport;
}> {
	const client = new Client({ name: "ryu-chatgpt-test", version: "1.0.0" });
	const transport = new StreamableHTTPClientTransport(new URL(url), {
		requestInit: { headers: { authorization: AUTHORIZATION } },
	});
	await client.connect(transport);
	return { client, transport };
}

function postInitialize(url: string): Promise<Response> {
	return fetch(url, {
		method: "POST",
		headers: {
			accept: "application/json, text/event-stream",
			authorization: AUTHORIZATION,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "ryu-chatgpt-test", version: "1.0.0" },
			},
		}),
	});
}

describe("ChatGPT MCP server", () => {
	test("serves MCP App UI metadata and requires authorization over Streamable HTTP", async () => {
		const plugin = await createChatGPTPluginServer({
			name: "ryu-demo",
			version: "1.0.0",
			instructions: "Use the viewer tool to open the plugin panel.",
			configure: (server) => {
				registerChatGPTAppResource(
					server,
					"Demo viewer",
					"ui://demo/viewer.html",
					{},
					async (uri) => ({
						contents: [
							{
								uri: uri.href,
								mimeType: RESOURCE_MIME_TYPE,
								text: "<!doctype html><html><body>Ryu ChatGPT plugin</body></html>",
							},
						],
					})
				);
				registerChatGPTAppTool(
					server,
					"open_viewer",
					{
						description: "Open the demo viewer in ChatGPT.",
						inputSchema: {},
						_meta: {
							ui: { resourceUri: "ui://demo/viewer.html" },
							"openai/ui": { entrypoints: [{ type: "global" }] },
						},
					},
					async () => ({
						content: [{ type: "text", text: "Viewer opened." }],
					})
				);
			},
		});

		const endpoint = await plugin.listen({
			allowedHosts: ["127.0.0.1"],
			authorize: (request) => request.headers.authorization === AUTHORIZATION,
			port: 0,
		});
		const unauthorized = await fetch(endpoint.url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {},
			}),
		});
		expect(unauthorized.status).toBe(401);

		const { client } = await connectClient(endpoint.url);
		try {
			const tools = await client.listTools();
			const appTool = tools.tools.find((tool) => tool.name === "open_viewer");
			expect(appTool?._meta).toMatchObject({
				ui: { resourceUri: "ui://demo/viewer.html" },
				"openai/ui": { entrypoints: [{ type: "global" }] },
			});
			const resource = await client.readResource({
				uri: "ui://demo/viewer.html",
			});
			expect(resource.contents[0]).toMatchObject({
				mimeType: RESOURCE_MIME_TYPE,
				text: expect.stringContaining("Ryu ChatGPT plugin"),
			});
			const second = await connectClient(endpoint.url);
			try {
				expect(
					(await second.client.listTools()).tools.some(
						(tool) => tool.name === "open_viewer"
					)
				).toBe(true);
			} finally {
				await second.client.close();
			}
		} finally {
			await client.close();
			await endpoint.close();
		}
	});

	test("publishes skills/list and skills/get snapshots with verifiable resources", async () => {
		const plugin = await createChatGPTPluginServer({
			name: "ryu-research",
			version: "1.0.0",
			skills: {
				directory: createSkillDirectory(),
				pluginName: "ryu.research",
			},
		});
		const endpoint = await plugin.listen({
			allowedHosts: ["127.0.0.1"],
			authorize: (request) => request.headers.authorization === AUTHORIZATION,
			port: 0,
		});
		const { client } = await connectClient(endpoint.url);
		try {
			const list = await client.request(
				{ method: "skills/list", params: {} },
				z.object({
					skills: z.array(
						z.object({
							uri: z.string(),
							frontmatter: z.record(z.string(), z.unknown()),
							resources: z.array(
								z.object({ uri: z.string(), digest: z.string() })
							),
						})
					),
					nextCursor: z.string().optional(),
				})
			);
			const skill = list.skills[0];
			if (!skill) {
				throw new Error("skills/list returned no skills");
			}
			expect(skill.frontmatter).toMatchObject({ name: "research" });
			expect(skill.resources).toHaveLength(2);
			const resource = await client.readResource({ uri: skill.uri });
			const markdown = resource.contents[0];
			if (!(markdown && "text" in markdown)) {
				throw new Error("SKILL.md was not returned as text");
			}
			expect(
				skill.resources.find((entry) => entry.uri === skill.uri)?.digest
			).toBe(
				`sha256:${createHash("sha256").update(markdown.text, "utf8").digest("hex")}`
			);
			const get = await client.request(
				{ method: "skills/get", params: { uri: skill.uri } },
				z.object({
					skill: z.object({ uri: z.string(), name: z.string() }).passthrough(),
				})
			);
			expect(get.skill).toMatchObject({ uri: skill.uri, name: "research" });
		} finally {
			await client.close();
			await endpoint.close();
		}
	});

	test("counts pending initializations against maxSessions", async () => {
		const plugin = await createChatGPTPluginServer({
			name: "ryu-capped",
			version: "1.0.0",
		});
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		let createCalls = 0;
		const endpoint = await listenChatGPTPluginHttp({
			allowedHosts: ["127.0.0.1"],
			authorize: (request) => request.headers.authorization === AUTHORIZATION,
			createSession: async () => {
				createCalls += 1;
				if (createCalls === 1) {
					firstStarted.resolve();
					await releaseFirst.promise;
				}
				return plugin.createSession();
			},
			maxSessions: 1,
			port: 0,
		});
		try {
			const pending = postInitialize(endpoint.url);
			await firstStarted.promise;

			const overCap = await postInitialize(endpoint.url);
			await overCap.text();
			expect(overCap.status).toBe(503);

			releaseFirst.resolve();
			const accepted = await pending;
			await accepted.text();
			expect(accepted.status).toBe(200);
			const sessionId = accepted.headers.get("mcp-session-id");
			expect(sessionId).toBeTruthy();

			const stillFull = await postInitialize(endpoint.url);
			await stillFull.text();
			expect(stillFull.status).toBe(503);

			const deleted = await fetch(endpoint.url, {
				method: "DELETE",
				headers: {
					authorization: AUTHORIZATION,
					"mcp-session-id": sessionId ?? "",
				},
			});
			await deleted.text();
			expect(deleted.status).toBe(200);

			const reopened = await postInitialize(endpoint.url);
			await reopened.text();
			expect(reopened.status).toBe(200);
			expect(createCalls).toBe(2);
		} finally {
			releaseFirst.resolve();
			await endpoint.close();
		}
	});

	test("releases the reserved session slot when an initialization fails", async () => {
		const plugin = await createChatGPTPluginServer({
			name: "ryu-capped-failure",
			version: "1.0.0",
		});
		let createCalls = 0;
		const endpoint = await listenChatGPTPluginHttp({
			allowedHosts: ["127.0.0.1"],
			authorize: (request) => request.headers.authorization === AUTHORIZATION,
			createSession: () => {
				createCalls += 1;
				if (createCalls === 1) {
					return Promise.reject(new Error("session setup failed"));
				}
				return plugin.createSession();
			},
			maxSessions: 1,
			port: 0,
		});
		try {
			const failed = await postInitialize(endpoint.url);
			await failed.text();
			expect(failed.status).toBe(500);

			// A sessionless POST that is not `initialize` never yields a session id.
			const rejected = await fetch(endpoint.url, {
				method: "POST",
				headers: {
					accept: "application/json, text/event-stream",
					authorization: AUTHORIZATION,
					"content-type": "application/json",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
			});
			await rejected.text();
			expect(rejected.status).toBe(400);

			const accepted = await postInitialize(endpoint.url);
			await accepted.text();
			expect(accepted.status).toBe(200);
			expect(accepted.headers.get("mcp-session-id")).toBeTruthy();
			expect(createCalls).toBe(3);
		} finally {
			await endpoint.close();
		}
	});
});
