/**
 * `@ryuhq/sdk/server/node` — run a Web-standard fetch handler on `node:http`.
 *
 * `toNodeListener` adapts `fetch(request) => Response` into a Node
 * `(req, res)` listener (used by the standalone, Docker, and Vercel builds);
 * `serve` starts a listening server around it (used by `ryu dev --studio` and
 * the standalone build's entry). Both work under Node and Bun.
 */

import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

/** A Web-standard request handler. */
export type FetchHandler = (request: Request) => Promise<Response> | Response;

/** A Node `http` request listener. */
export type NodeListener = (req: IncomingMessage, res: ServerResponse) => void;

function requestOrigin(req: IncomingMessage): string {
	const host = req.headers.host ?? "localhost";
	const encrypted = "encrypted" in req.socket && req.socket.encrypted === true;
	return `${encrypted ? "https" : "http"}://${host}`;
}

/** Convert a Node request into a Web `Request` that aborts when the client goes. */
export function toWebRequest(
	req: IncomingMessage,
	signal: AbortSignal
): Request {
	const url = new URL(req.url ?? "/", requestOrigin(req));
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				headers.append(name, item);
			}
		} else if (value !== undefined) {
			headers.set(name, value);
		}
	}
	const method = req.method ?? "GET";
	const hasBody = method !== "GET" && method !== "HEAD";
	const init: RequestInit & { duplex?: "half" } = {
		method,
		headers,
		signal,
	};
	if (hasBody) {
		// SAFETY: Node's web stream type differs from the DOM lib's only nominally.
		init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
		init.duplex = "half";
	}
	return new Request(url, init);
}

async function writeWebResponse(
	response: Response,
	res: ServerResponse,
	signal: AbortSignal
): Promise<void> {
	res.statusCode = response.status;
	response.headers.forEach((value, name) => {
		res.appendHeader(name, value);
	});
	if (!response.body) {
		res.end();
		return;
	}
	res.flushHeaders();
	const reader = response.body.getReader();
	const onAbort = () => {
		reader.cancel().catch(() => undefined);
	};
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (!res.write(value)) {
				await new Promise<void>((resolve) => {
					const resume = () => {
						res.off("close", resume);
						res.off("drain", resume);
						resolve();
					};
					res.once("drain", resume);
					res.once("close", resume);
				});
			}
			if (signal.aborted) {
				break;
			}
		}
	} finally {
		signal.removeEventListener("abort", onAbort);
		res.end();
	}
}

/** Adapt a fetch handler into a Node `http` listener. */
export function toNodeListener(handler: FetchHandler): NodeListener {
	return (req, res) => {
		const abort = new AbortController();
		res.on("close", () => {
			if (!res.writableFinished) {
				abort.abort();
			}
		});
		(async () => {
			const response = await handler(toWebRequest(req, abort.signal));
			await writeWebResponse(response, res, abort.signal);
		})().catch((error: unknown) => {
			if (res.headersSent) {
				res.end();
				return;
			}
			res.statusCode = 500;
			res.setHeader("content-type", "application/json; charset=utf-8");
			res.end(
				JSON.stringify({
					error: {
						code: "internal_error",
						message: error instanceof Error ? error.message : String(error),
					},
				})
			);
		});
	};
}

/** Options for {@link serve}. */
export interface ServeOptions {
	fetch: FetchHandler;
	/** Interface to bind (default `127.0.0.1`). */
	hostname?: string;
	/** Port to bind; `0` picks a free one (default 3000). */
	port?: number;
}

/** A started server. */
export interface ServedApp {
	close(): Promise<void>;
	readonly port: number;
	readonly server: Server;
	/** The base URL, e.g. `http://127.0.0.1:3000`. */
	readonly url: string;
}

/** Start an HTTP server around a fetch handler. */
export function serve(options: ServeOptions): Promise<ServedApp> {
	const hostname = options.hostname ?? "127.0.0.1";
	const server = createServer(toNodeListener(options.fetch));
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 3000, hostname, () => {
			server.off("error", reject);
			const { port } = server.address() as AddressInfo;
			const host = hostname.includes(":") ? `[${hostname}]` : hostname;
			resolve({
				server,
				port,
				url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`,
				close: () =>
					new Promise<void>((done, fail) => {
						server.close((error) => (error ? fail(error) : done()));
						server.closeAllConnections();
					}),
			});
		});
	});
}
