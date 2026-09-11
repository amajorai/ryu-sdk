// Loopback control server for the __APP_DISPLAY_NAME__ sidecar.
//
// Ryu spawns this as a `local` manifest sidecar (see `../../../../manifest.json`,
// `SidecarProcess::Local`). It exposes a small HTTP control surface bound to
// loopback so Core — and, through Core's generic ext-proxy
// (`/api/ext/com.example.__APP_NAME__/*`), every Ryu client — can drive the app.
// Nothing in Core or the Gateway knows this app exists: the manifest's
// `sidecars[]` + `provides[]` are the entire integration.
//
// SECURITY
// --------
// * Bound to 127.0.0.1 only. Never bind 0.0.0.0 — the ext-proxy is the only
//   intended caller and it dials loopback.
// * Every route except `GET /health` requires `Authorization: Bearer <token>` —
//   the per-plugin secret Core mints and injects at spawn (`RYU_EXT_TOKEN`);
//   `__APP_TOKEN_ENV__` overrides it for standalone/dev runs. Neither set ⇒
//   FAIL-CLOSED (every protected route 401s). A sidecar that skips this check is
//   an unauthenticated RCE surface for anything else running on the machine —
//   loopback is not a trust boundary on a multi-user or agent-laden host.
//
// The router (`handleRequest`) is a pure function over an injected `ItemStore`,
// so it unit-tests with a fake — no sockets, no process.

import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

/** Default loopback port. There is NO port registry: picking a free one is the
 *  app author's job. Stay clear of Core (:7980), the Gateway (:7981), the
 *  built-in sidecar band (:7990–:8003), and the local engines (:8080–:8087). */
const CONTROL_BASE_PORT = 8342;

/** A Core running under `RYU_PROFILE=dev` shifts every port by this much so a dev
 *  node and a release node coexist. Core injects the shifted value through
 *  `__APP_PORT_ENV__`; this fallback only matters when the sidecar is run by hand. */
const DEV_PORT_OFFSET = 1000;

const PACKAGE_VERSION = "0.1.0";

/** The capability this sidecar serves — must equal `provides[].capability` in the
 *  manifest, which is what a consuming app names in its `requires.capabilities`. */
export const CAPABILITY = "__APP_NAME__.control";

/** One `/items` row. Replace this with whatever your app actually owns. */
export interface Item {
	createdAt: string;
	id: string;
	text: string;
}

/** The domain the router drives. Injected so the router can be tested against a
 *  fake without touching the real backing store. */
export interface ItemStore {
	create(text: string): Item;
	get(id: string): Item | null;
	list(): Item[];
	remove(id: string): boolean;
}

/** The default store — in-memory, so the scaffold runs with zero setup. Swap it
 *  for a real one (SQLite, a file, a vendor SDK) without touching the router. */
export class MemoryItemStore implements ItemStore {
	private readonly items = new Map<string, Item>();

	list(): Item[] {
		return [...this.items.values()];
	}

	get(id: string): Item | null {
		return this.items.get(id) ?? null;
	}

	create(text: string): Item {
		const item: Item = {
			id: randomUUID(),
			text,
			createdAt: new Date().toISOString(),
		};
		this.items.set(item.id, item);
		return item;
	}

	remove(id: string): boolean {
		return this.items.delete(id);
	}
}

/** The bind port: whatever Core injected, else the profile-aware default. */
export function resolveControlPort(
	env: NodeJS.ProcessEnv = process.env
): number {
	const explicit = Number.parseInt(env.__APP_PORT_ENV__ ?? "", 10);
	if (Number.isInteger(explicit) && explicit > 0) {
		return explicit;
	}
	const isDev = (env.RYU_PROFILE ?? "").trim().toLowerCase() === "dev";
	return isDev ? CONTROL_BASE_PORT + DEV_PORT_OFFSET : CONTROL_BASE_PORT;
}

/** The expected bearer, or `null` when unset — which fails every protected route
 *  closed rather than serving the surface unauthenticated. */
export function resolveControlToken(
	env: NodeJS.ProcessEnv = process.env
): string | null {
	const raw = env.RYU_EXT_TOKEN ?? env.__APP_TOKEN_ENV__ ?? "";
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/** Constant-time bearer check. `null`/empty `expected` ⇒ fail-closed (reject all).
 *  Compared with `timingSafeEqual`, not `===`: a byte-at-a-time comparison leaks
 *  the token one character per request to a caller that can time the loopback. */
export function bearerOk(
	authHeader: string | undefined,
	expected: string | null
): boolean {
	if (!expected) {
		return false;
	}
	const presented = authHeader?.startsWith("Bearer ")
		? authHeader.slice("Bearer ".length)
		: null;
	if (!presented) {
		return false;
	}
	const a = Buffer.from(presented, "utf8");
	const b = Buffer.from(expected, "utf8");
	if (a.length !== b.length) {
		return false;
	}
	return timingSafeEqual(a, b);
}

export interface ControlResponse {
	json?: unknown;
	status: number;
}

export interface RequestDeps {
	store: ItemStore;
	token: string | null;
}

/** `/items/<id>` — a top-level literal (lint/performance/useTopLevelRegex). */
const RE_ITEM_ID = /^\/items\/([^/]+)$/;

function notFound(): ControlResponse {
	return { status: 404, json: { ok: false, error: "not found" } };
}

function badRequest(error: string): ControlResponse {
	return { status: 400, json: { ok: false, error } };
}

/** Parse a JSON body. `""` (no body) is an empty object; malformed is `null`. */
function parseJsonBody(raw: string): Record<string, unknown> | null {
	if (!raw) {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function handleItemsCollection(
	method: string,
	body: string,
	store: ItemStore
): ControlResponse {
	if (method === "GET") {
		return { status: 200, json: { ok: true, items: store.list() } };
	}
	if (method !== "POST") {
		return notFound();
	}
	const payload = parseJsonBody(body);
	if (!payload) {
		return badRequest("body must be a JSON object");
	}
	const text = typeof payload.text === "string" ? payload.text.trim() : "";
	if (!text) {
		return badRequest("missing text");
	}
	return { status: 201, json: { ok: true, item: store.create(text) } };
}

function handleItem(
	method: string,
	id: string,
	store: ItemStore
): ControlResponse {
	if (method === "GET") {
		const item = store.get(id);
		return item
			? { status: 200, json: { ok: true, item } }
			: { status: 404, json: { ok: false, error: "unknown item" } };
	}
	if (method === "DELETE") {
		return store.remove(id)
			? { status: 200, json: { ok: true } }
			: { status: 404, json: { ok: false, error: "unknown item" } };
	}
	return notFound();
}

/**
 * Pure request router. `path` carries no query string; `body` is the raw request
 * body. Every route except `GET /health` is bearer-gated.
 *
 * The paths handled here MUST stay in sync with `sidecars[].http.routes[]` in the
 * manifest: Core 404s any sub-path the manifest does not declare (undeclared paths
 * are never forwarded), so a route added here but not there is simply unreachable
 * through the ext-proxy — and one declared there but missing here 404s from the
 * sidecar instead.
 */
export function handleRequest(
	method: string,
	path: string,
	authHeader: string | undefined,
	body: string,
	deps: RequestDeps
): ControlResponse {
	// Unauthenticated on purpose: Core's health monitor probes this before the
	// plugin's token is in play, and it reveals nothing but liveness.
	if (path === "/health") {
		return { status: 200, json: { ok: true, version: PACKAGE_VERSION } };
	}

	if (!bearerOk(authHeader, deps.token)) {
		return { status: 401, json: { ok: false, error: "unauthorized" } };
	}

	// The capability root — `provides[].route` points here, so the broker hits it
	// to describe the capability.
	if (path === "/" && method === "GET") {
		return {
			status: 200,
			json: {
				ok: true,
				capability: CAPABILITY,
				version: PACKAGE_VERSION,
				routes: ["/health", "/items", "/items/:id"],
			},
		};
	}

	if (path === "/items") {
		return handleItemsCollection(method, body, deps.store);
	}

	const match = RE_ITEM_ID.exec(path);
	if (match?.[1]) {
		return handleItem(method, decodeURIComponent(match[1]), deps.store);
	}

	return notFound();
}

/** Start the loopback control server. A bind failure logs and leaves the process
 *  up so Core's health probe reports it unhealthy instead of racing a respawn. */
export function startControlServer(deps: RequestDeps, port: number): Server {
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c as Buffer));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			const path = (req.url ?? "/").split("?")[0] ?? "/";
			const resp = handleRequest(
				req.method ?? "GET",
				path,
				req.headers.authorization,
				body,
				deps
			);
			res.writeHead(resp.status, { "Content-Type": "application/json" });
			res.end(JSON.stringify(resp.json ?? {}));
		});
	});
	server.on("error", (err) => {
		// biome-ignore lint/suspicious/noConsole: main-process diagnostic, no renderer.
		console.warn(
			`[ryu-__APP_NAME__] control server unavailable: ${err.message}`
		);
	});
	server.listen(port, "127.0.0.1");
	return server;
}
