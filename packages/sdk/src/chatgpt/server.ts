import { randomUUID } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { isIP } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { OpenAIExtensions } from "@openai/mcp-extensions/server";
import { z } from "zod";
import {
	type ChatGPTSkillBundle,
	loadChatGPTSkills,
	type RegisterChatGPTSkillsOptions,
	registerChatGPTSkillBundle,
} from "./skills.ts";

const MCP_UI_EXTENSION_ID = "io.modelcontextprotocol/ui";
const ALLOWED_HTTP_METHODS = new Set(["GET", "POST", "DELETE"]);
const DEFAULT_SESSION_LIMIT = 100;
const DEFAULT_SESSION_IDLE_MS = 15 * 60 * 1000;

export interface ChatGPTPluginSession {
	openai: OpenAIExtensions;
	server: McpServer;
}

export interface ChatGPTPluginServerOptions {
	/** Register the same tool/UI surface for each authenticated MCP client session. */
	configure?: (
		server: McpServer,
		openai: OpenAIExtensions
	) => void | Promise<void>;
	instructions?: string;
	name: string;
	skills?: RegisterChatGPTSkillsOptions;
	version: string;
}

export interface ChatGPTPluginBuilder {
	createSession: () => Promise<ChatGPTPluginSession>;
	listen: (
		options: Omit<ChatGPTPluginHttpOptions, "createSession">
	) => Promise<ChatGPTPluginHttpServer>;
}

/** Create a reusable MCP server definition; each HTTP client receives its own session. */
export async function createChatGPTPluginServer(
	options: ChatGPTPluginServerOptions
): Promise<ChatGPTPluginBuilder> {
	if (!(options.name.trim() && options.version.trim())) {
		throw new Error("ChatGPT plugin servers need a name and version");
	}
	const skillBundle: ChatGPTSkillBundle | undefined = options.skills
		? await loadChatGPTSkills(options.skills)
		: undefined;
	if (options.skills && skillBundle?.skills.length === 0) {
		throw new Error("no skills found for the ChatGPT plugin server");
	}

	const createSession = async (): Promise<ChatGPTPluginSession> => {
		const serverOptions: NonNullable<
			ConstructorParameters<typeof McpServer>[1]
		> = {
			capabilities: {
				extensions: { [MCP_UI_EXTENSION_ID]: {} },
				resources: {},
				tools: {},
			},
		};
		if (options.instructions) {
			serverOptions.instructions = options.instructions;
		}
		const server = new McpServer(
			{ name: options.name, version: options.version },
			serverOptions
		);
		const openai = new OpenAIExtensions(server);
		if (skillBundle) {
			registerChatGPTSkillBundle(server, skillBundle, options.skills);
		}
		await options.configure?.(server, openai);
		return { openai, server };
	};

	return {
		createSession,
		listen: (listenOptions) =>
			listenChatGPTPluginHttp({ ...listenOptions, createSession }),
	};
}

export interface ChatGPTPluginHttpOptions {
	/** Exact DNS names or IP addresses accepted in the HTTP Host header. */
	allowedHosts: readonly string[];
	/** Exact browser origins allowed to call the endpoint. Requests without Origin are still authorized. */
	allowedOrigins?: readonly string[];
	/** A server-side authorization check. It runs on every MCP request. */
	authorize: (request: IncomingMessage) => boolean | Promise<boolean>;
	createSession: () => Promise<ChatGPTPluginSession>;
	host?: string;
	maxSessions?: number;
	onRequest?: (event: ChatGPTPluginRequestEvent) => void;
	path?: string;
	port: number;
	sessionIdleTimeoutMs?: number;
}

export interface ChatGPTPluginRequestEvent {
	durationMs: number;
	method: string;
	statusCode: number;
}

export interface ChatGPTPluginHttpServer {
	close: () => Promise<void>;
	url: string;
}

interface PluginSessionRecord extends ChatGPTPluginSession {
	idleTimer: ReturnType<typeof setTimeout>;
	transport: StreamableHTTPServerTransport;
}

function normalizeHost(value: string): string {
	const host = value
		.trim()
		.replace(/^\[|\]$/g, "")
		.toLowerCase()
		.replace(/\.$/, "");
	if (!host || host.includes("/") || host.includes("@")) {
		throw new Error(`invalid allowed host '${value}'`);
	}
	if (isIP(host) !== 0) {
		return host;
	}
	if (
		host.length > 253 ||
		!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
			host
		)
	) {
		throw new Error(`invalid allowed host '${value}'`);
	}
	return host;
}

function normalizeOrigin(value: string): string {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`invalid allowed origin '${value}'`);
	}
	if (
		(parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
		parsed.origin !== value ||
		parsed.username ||
		parsed.password
	) {
		throw new Error(`invalid allowed origin '${value}'`);
	}
	return parsed.origin;
}

function normalizePath(value: string): string {
	if (
		!value.startsWith("/") ||
		value.startsWith("//") ||
		/[?#\\]/.test(value)
	) {
		throw new Error(
			"MCP path must be an absolute path without query, fragment, or backslash"
		);
	}
	if (value.split("/").some((segment) => segment === "." || segment === "..")) {
		throw new Error("MCP path must not contain dot segments");
	}
	return value;
}

function hostHeaderName(value: string | undefined): string | undefined {
	if (!value) {
		return;
	}
	try {
		const parsed = new URL(`http://${value}`);
		if (parsed.username || parsed.password || parsed.pathname !== "/") {
			return;
		}
		return normalizeHost(parsed.hostname);
	} catch {
		return;
	}
}

function setCorsHeaders(response: ServerResponse, origin: string): void {
	response.setHeader("Access-Control-Allow-Origin", origin);
	response.setHeader(
		"Access-Control-Allow-Methods",
		"GET, POST, DELETE, OPTIONS"
	);
	response.setHeader(
		"Access-Control-Allow-Headers",
		"Authorization, Content-Type, Last-Event-ID, Mcp-Session-Id, MCP-Protocol-Version"
	);
	response.setHeader(
		"Access-Control-Expose-Headers",
		"Mcp-Session-Id, MCP-Protocol-Version"
	);
	response.setHeader("Vary", "Origin");
}

function writeStatus(response: ServerResponse, status: number): void {
	if (!response.headersSent) {
		response.writeHead(status).end();
	}
}

/**
 * Serve ChatGPT's Streamable HTTP transport at `/mcp`.
 *
 * The listener validates Host, Origin, and authorization before dispatch. It
 * creates one MCP server and transport for each initialized client session.
 */
export async function listenChatGPTPluginHttp(
	options: ChatGPTPluginHttpOptions
): Promise<ChatGPTPluginHttpServer> {
	if (
		!Number.isInteger(options.port) ||
		options.port < 0 ||
		options.port > 65_535
	) {
		throw new Error("port must be an integer from 0 to 65535");
	}
	if (options.allowedHosts.length === 0) {
		throw new Error(
			"allowedHosts must list at least one DNS name or IP address"
		);
	}
	const path = normalizePath(options.path ?? "/mcp");
	const allowedHosts = new Set(options.allowedHosts.map(normalizeHost));
	const allowedOrigins = new Set(
		(options.allowedOrigins ?? []).map(normalizeOrigin)
	);
	const host = options.host ?? "127.0.0.1";
	const maxSessions = options.maxSessions ?? DEFAULT_SESSION_LIMIT;
	const sessionIdleTimeoutMs =
		options.sessionIdleTimeoutMs ?? DEFAULT_SESSION_IDLE_MS;
	if (!Number.isInteger(maxSessions) || maxSessions < 1) {
		throw new Error("maxSessions must be a positive integer");
	}
	if (!Number.isInteger(sessionIdleTimeoutMs) || sessionIdleTimeoutMs < 1000) {
		throw new Error("sessionIdleTimeoutMs must be at least 1000 milliseconds");
	}

	const sessions = new Map<string, PluginSessionRecord>();
	/** Initializations admitted under `maxSessions` that have not inserted a record yet. */
	let pendingSessions = 0;
	let closing = false;
	const closeSession = async (sessionId: string): Promise<void> => {
		const session = sessions.get(sessionId);
		if (!session) {
			return;
		}
		sessions.delete(sessionId);
		clearTimeout(session.idleTimer);
		await session.server.close();
	};

	const initializeSession = async (
		request: IncomingMessage,
		response: ServerResponse,
		hostHeader: string
	): Promise<void> => {
		let session: ChatGPTPluginSession;
		try {
			session = await options.createSession();
		} catch {
			writeStatus(response, 500);
			return;
		}
		const transportOptions: ConstructorParameters<
			typeof StreamableHTTPServerTransport
		>[0] = {
			allowedHosts: [hostHeader],
			enableDnsRebindingProtection: true,
			sessionIdGenerator: randomUUID,
		};
		if (allowedOrigins.size > 0) {
			transportOptions.allowedOrigins = [...allowedOrigins];
		}
		const transport = new StreamableHTTPServerTransport(transportOptions);
		try {
			await session.server.connect(transport);
			await transport.handleRequest(request, response);
			const sessionId = transport.sessionId;
			// close() only drains sessions inserted before it ran; a late
			// initialization must not leave one behind.
			if (!sessionId || closing) {
				await session.server.close();
				return;
			}
			const record: PluginSessionRecord = {
				...session,
				idleTimer: setTimeout(() => {
					void closeSession(sessionId).catch(() => {});
				}, sessionIdleTimeoutMs),
				transport,
			};
			record.idleTimer.unref();
			sessions.set(sessionId, record);
			transport.onclose = () => {
				void closeSession(sessionId).catch(() => {});
			};
		} catch {
			await session.server.close();
			writeStatus(response, 500);
		}
	};

	const httpServer = createServer((request, response) => {
		const startedAt = Date.now();
		response.once("finish", () => {
			try {
				options.onRequest?.({
					durationMs: Math.max(0, Date.now() - startedAt),
					method: request.method ?? "UNKNOWN",
					statusCode: response.statusCode,
				});
			} catch {
				// Metrics callbacks are observational and cannot disrupt a response.
			}
		});

		void (async () => {
			const hostHeader = request.headers.host;
			const requestHost = hostHeaderName(hostHeader);
			if (!(hostHeader && requestHost && allowedHosts.has(requestHost))) {
				writeStatus(response, 421);
				return;
			}
			let pathname: string;
			try {
				pathname = new URL(request.url ?? "/", `http://${hostHeader}`).pathname;
			} catch {
				writeStatus(response, 400);
				return;
			}
			if (pathname !== path) {
				writeStatus(response, 404);
				return;
			}

			const origin = request.headers.origin;
			if (origin && !allowedOrigins.has(origin)) {
				writeStatus(response, 403);
				return;
			}
			if (origin) {
				setCorsHeaders(response, origin);
			}
			if (request.method === "OPTIONS") {
				writeStatus(response, 204);
				return;
			}
			if (!ALLOWED_HTTP_METHODS.has(request.method ?? "")) {
				response.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
				writeStatus(response, 405);
				return;
			}

			let authorized = false;
			try {
				authorized = await options.authorize(request);
			} catch {
				authorized = false;
			}
			if (!authorized) {
				writeStatus(response, 401);
				return;
			}

			const sessionHeader = request.headers["mcp-session-id"];
			if (Array.isArray(sessionHeader)) {
				writeStatus(response, 400);
				return;
			}
			if (sessionHeader) {
				const session = sessions.get(sessionHeader);
				if (!session) {
					writeStatus(response, 404);
					return;
				}
				clearTimeout(session.idleTimer);
				session.idleTimer = setTimeout(() => {
					void closeSession(sessionHeader).catch(() => {});
				}, sessionIdleTimeoutMs);
				session.idleTimer.unref();
				try {
					await session.transport.handleRequest(request, response);
				} catch {
					writeStatus(response, 500);
				}
				return;
			}
			if (request.method !== "POST") {
				writeStatus(response, 400);
				return;
			}
			// Reserve the slot in the same synchronous step as the cap check so a
			// burst of initializations cannot all pass it before any is inserted.
			if (sessions.size + pendingSessions >= maxSessions) {
				writeStatus(response, 503);
				return;
			}
			pendingSessions += 1;
			try {
				await initializeSession(request, response, hostHeader);
			} finally {
				pendingSessions -= 1;
			}
		})();
	});

	let boundPort: number;
	try {
		boundPort = await new Promise<number>((resolvePort, reject) => {
			const onError = (error: Error) => {
				httpServer.off("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				httpServer.off("error", onError);
				const address = z
					.object({ port: z.number().int() })
					.safeParse(httpServer.address());
				if (!address.success) {
					reject(new Error("MCP server did not bind to a TCP port"));
					return;
				}
				resolvePort(address.data.port);
			};
			httpServer.once("error", onError);
			httpServer.once("listening", onListening);
			httpServer.listen(options.port, host);
		});
	} catch (error) {
		await Promise.allSettled(
			[...sessions.keys()].map((sessionId) => closeSession(sessionId))
		);
		throw error;
	}

	const displayHost = host.includes(":") ? `[${host}]` : host;
	let closeOperation: Promise<void> | undefined;
	return {
		url: `http://${displayHost}:${boundPort}${path}`,
		close: () => {
			if (closeOperation) {
				return closeOperation;
			}
			closing = true;
			closeOperation = (async () => {
				const serverClosed = new Promise<void>((resolveClose, rejectClose) => {
					httpServer.close((error) => {
						if (error) {
							rejectClose(error);
							return;
						}
						resolveClose();
					});
				});
				httpServer.closeAllConnections?.();
				await Promise.allSettled(
					[...sessions.keys()].map((sessionId) => closeSession(sessionId))
				);
				await serverClosed;
			})();
			return closeOperation;
		},
	};
}
