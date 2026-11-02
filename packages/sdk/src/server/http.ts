/**
 * Web-standard HTTP helpers for the Ryu developer server: JSON responses, a
 * size-bounded JSON body reader, Server-Sent Events, and a small method+path
 * router. Everything here uses only `Request`/`Response`/`ReadableStream`, so
 * the server runs unchanged on Node, Bun, Deno, Cloudflare Workers, Vercel, and
 * Netlify.
 */

/** Largest request body the server reads (1 MiB). */
export const MAX_BODY_BYTES = 1024 * 1024;

/** How often an idle SSE stream sends a keep-alive comment. */
export const SSE_HEARTBEAT_MS = 15_000;

/** A typed HTTP failure that the router turns into a JSON error response. */
export class HttpError extends Error {
	readonly code: string;
	readonly status: number;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = "HttpError";
		this.status = status;
		this.code = code;
	}
}

/** A JSON response. */
export function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

/** The JSON error envelope every failed route returns. */
export function errorResponse(
	status: number,
	code: string,
	message: string
): Response {
	return json({ error: { code, message } }, status);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const JSON_CONTENT_TYPE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;

/**
 * Refuse a state-changing request that is not declared `application/json`,
 * even when its body is empty. A page on another site can send a body-less
 * `no-cors` POST without a preflight, but it cannot set this content type, so
 * the check closes the cross-site gap that `readJsonBody` alone leaves for
 * empty bodies.
 */
export function requireJsonContentType(request: Request): void {
	if (SAFE_METHODS.has(request.method)) {
		return;
	}
	if (!JSON_CONTENT_TYPE.test(request.headers.get("content-type") ?? "")) {
		throw new HttpError(
			415,
			"unsupported_media_type",
			"send the request as application/json"
		);
	}
}

/**
 * Read and parse a JSON request body. An empty body reads as `{}`. Bodies over
 * {@link MAX_BODY_BYTES} are refused with 413 before they are fully buffered,
 * and a non-empty body must be sent as `application/json` (415 otherwise). The
 * content-type rule means a browser on another site cannot post a body without
 * a CORS preflight, which the server never grants.
 */
export async function readJsonBody(request: Request): Promise<unknown> {
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared > MAX_BODY_BYTES) {
		throw new HttpError(413, "payload_too_large", "request body is too large");
	}
	if (!request.body) {
		return {};
	}
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		total += value.byteLength;
		if (total > MAX_BODY_BYTES) {
			await reader.cancel().catch(() => undefined);
			throw new HttpError(
				413,
				"payload_too_large",
				"request body is too large"
			);
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const text = new TextDecoder().decode(bytes).trim();
	if (text === "") {
		return {};
	}
	if (!JSON_CONTENT_TYPE.test(request.headers.get("content-type") ?? "")) {
		throw new HttpError(
			415,
			"unsupported_media_type",
			"send the request body as application/json"
		);
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new HttpError(400, "invalid_json", "request body is not valid JSON");
	}
}

/** Encode one SSE frame. `data` is JSON-encoded on a single line. */
export function sseFrame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data ?? null)}\n\n`;
}

/** A sink an SSE producer writes frames into. */
export interface SseSink {
	/** True once the client disconnected or the stream closed. */
	readonly closed: boolean;
	send(event: string, data: unknown): void;
}

/**
 * Build a streaming `text/event-stream` response. `produce` writes frames into
 * the sink; the stream closes when it settles. `signal` aborts when the client
 * disconnects, so producers can stop work they no longer need to do.
 */
export function sseResponse(
	produce: (sink: SseSink, signal: AbortSignal) => Promise<void>,
	upstream?: AbortSignal
): Response {
	const encoder = new TextEncoder();
	const abort = new AbortController();
	const onUpstreamAbort = () => abort.abort();
	upstream?.addEventListener("abort", onUpstreamAbort, { once: true });
	let closed = false;
	let heartbeat: ReturnType<typeof setInterval> | undefined;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const sink: SseSink = {
				get closed() {
					return closed;
				},
				send(event, data) {
					if (closed) {
						return;
					}
					controller.enqueue(encoder.encode(sseFrame(event, data)));
				},
			};
			const finish = () => {
				if (heartbeat) {
					clearInterval(heartbeat);
				}
				upstream?.removeEventListener("abort", onUpstreamAbort);
				if (!closed) {
					closed = true;
					controller.close();
				}
			};
			heartbeat = setInterval(() => {
				if (!closed) {
					controller.enqueue(encoder.encode(": keep-alive\n\n"));
				}
			}, SSE_HEARTBEAT_MS);
			produce(sink, abort.signal)
				.catch((error: unknown) => {
					sink.send("error", { message: describe(error) });
				})
				.finally(finish);
		},
		cancel() {
			closed = true;
			if (heartbeat) {
				clearInterval(heartbeat);
			}
			abort.abort();
		},
	});

	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			"x-accel-buffering": "no",
		},
	});
}

/** Render any thrown value as a message. */
export function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ── Router ────────────────────────────────────────────────────────────────────

/** Path parameters captured by a route pattern (`/agents/:id`). */
export type RouteParams = Readonly<Record<string, string>>;

/** A route handler. */
export type RouteHandler = (
	request: Request,
	params: RouteParams,
	url: URL
) => Promise<Response> | Response;

interface Route {
	handler: RouteHandler;
	method: string;
	segments: string[];
}

/** A minimal method + path router with `:param` segments. */
export class Router {
	readonly #routes: Route[] = [];

	/** Register a route. `pattern` is relative to the server's base path. */
	add(method: string, pattern: string, handler: RouteHandler): this {
		this.#routes.push({
			method: method.toUpperCase(),
			segments: splitPath(pattern),
			handler,
		});
		return this;
	}

	/**
	 * Find the handler for `method` + `path`. Returns `"method_not_allowed"`
	 * when the path exists under another method, `undefined` when it does not.
	 */
	match(
		method: string,
		path: string
	):
		| { handler: RouteHandler; params: RouteParams }
		| "method_not_allowed"
		| undefined {
		const segments = splitPath(path);
		let pathMatched = false;
		for (const route of this.#routes) {
			const params = matchSegments(route.segments, segments);
			if (!params) {
				continue;
			}
			if (route.method === method.toUpperCase()) {
				return { handler: route.handler, params };
			}
			pathMatched = true;
		}
		return pathMatched ? "method_not_allowed" : undefined;
	}
}

function splitPath(path: string): string[] {
	return path.split("/").filter((segment) => segment !== "");
}

function matchSegments(
	pattern: string[],
	segments: string[]
): Record<string, string> | undefined {
	if (pattern.length !== segments.length) {
		return;
	}
	const params: Record<string, string> = {};
	for (const [index, part] of pattern.entries()) {
		const segment = segments[index] ?? "";
		if (part.startsWith(":")) {
			try {
				params[part.slice(1)] = decodeURIComponent(segment);
			} catch {
				return;
			}
		} else if (part !== segment) {
			return;
		}
	}
	return params;
}
