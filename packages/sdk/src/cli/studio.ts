/**
 * `ryu dev --studio [entry]` — serve a project with the browser studio.
 *
 * Loads the project entry (default `src/ryu.ts`), wraps it in
 * `createRyuServer({ studio: true })`, and serves it on loopback. The studio
 * lists the project's agents, workflows, and tools, chats with agents
 * (tool calls, results, and approvals), runs workflows against their step
 * graph with live state, and shows local run traces.
 *
 * Listing and running workflows and tools works offline; agent chat needs the
 * node's gateway (`RYU_GATEWAY_URL`), so an unreachable gateway is a warning
 * here rather than the hard stop the terminal playground uses.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveGatewayUrl } from "../model/gateway.ts";
import { errorResponse } from "../server/http.ts";
import { type FetchHandler, type ServedApp, serve } from "../server/node.ts";
import { resolveRyuServer } from "../server/server.ts";
import { DEFAULT_ENTRY, readOption } from "./build.ts";
import { probeGateway } from "./dev.ts";

/** Default studio port. */
export const DEFAULT_STUDIO_PORT = 4111;

const PORT_PATTERN = /^\d{1,5}$/;

/** Parsed `ryu dev --studio` arguments. */
export interface StudioArgs {
	entry: string;
	host: string;
	port: number;
}

/** Parse `ryu dev --studio [entry] [--port <n>] [--host <h>]`. */
export function parseStudioArgs(args: string[]): StudioArgs {
	const port = readOption(
		args.filter((arg) => arg !== "--studio"),
		"--port"
	);
	const host = readOption(port.rest, "--host");
	const unknown = host.rest.filter((arg) => arg.startsWith("--"));
	if (unknown.length > 0) {
		throw new Error(`unknown option ${unknown[0]}`);
	}
	if (host.rest.length > 1) {
		throw new Error("ryu dev --studio takes at most one entry argument");
	}
	const portValue = port.value ?? String(DEFAULT_STUDIO_PORT);
	const portNumber = Number(portValue);
	if (!PORT_PATTERN.test(portValue) || portNumber > 65_535) {
		throw new Error(
			`--port must be a number from 0 to 65535, got "${portValue}"`
		);
	}
	return {
		entry: host.rest[0] ?? DEFAULT_ENTRY,
		host: host.value ?? "127.0.0.1",
		port: portNumber,
	};
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** True for a hostname that only ever names this machine. */
export function isLoopbackHostname(hostname: string): boolean {
	const name = hostname.toLowerCase();
	return (
		LOOPBACK_HOSTNAMES.has(name) ||
		name.endsWith(".localhost") ||
		/^127(?:\.\d{1,3}){3}$/.test(name)
	);
}

/**
 * Wrap the studio's handler so a web page the developer happens to have open
 * cannot drive it. A loopback-bound studio only answers requests addressed to
 * a loopback name (a DNS-rebound hostname is refused), and requests that
 * change anything must come from the studio's own origin.
 */
export function guardStudio(
	handler: FetchHandler,
	options: { loopbackOnly: boolean }
): FetchHandler {
	return (request) => {
		const url = new URL(request.url);
		if (options.loopbackOnly && !isLoopbackHostname(url.hostname)) {
			return errorResponse(
				403,
				"host_not_allowed",
				`the studio only answers requests for localhost, not "${url.hostname}"`
			);
		}
		const origin = request.headers.get("origin");
		if (
			!SAFE_METHODS.has(request.method.toUpperCase()) &&
			origin !== null &&
			origin !== url.origin
		) {
			return errorResponse(
				403,
				"cross_origin",
				"the studio only accepts changes from its own page"
			);
		}
		return handler(request);
	};
}

/** Load the project entry and serve it with the studio enabled. */
export async function startStudio(
	options: StudioArgs & { cwd?: string }
): Promise<{ app: ServedApp; basePath: string }> {
	const entry = resolve(options.cwd ?? process.cwd(), options.entry);
	const mod: unknown = await import(pathToFileURL(entry).href);
	const server = resolveRyuServer(mod, { studio: true });
	const app = await serve({
		fetch: guardStudio(server.fetch, {
			loopbackOnly: isLoopbackHostname(options.host),
		}),
		port: options.port,
		hostname: options.host,
	});
	return { app, basePath: server.basePath };
}

/** `ryu dev --studio` entry point; runs until interrupted. */
export async function commandStudio(args: string[]): Promise<void> {
	const parsed = parseStudioArgs(args);
	const { app, basePath } = await startStudio(parsed);
	const gatewayUrl = resolveGatewayUrl();
	const gatewayUp = await probeGateway(gatewayUrl);
	process.stdout.write(
		[
			"",
			`ryu studio  ${app.url}/`,
			`api         ${app.url}${basePath}  (OpenAPI: ${basePath}/openapi.json)`,
			`gateway     ${gatewayUrl}${gatewayUp ? "" : "  (not reachable: agent chat will fail until it is up)"}`,
			...(isLoopbackHostname(parsed.host)
				? []
				: [
						"",
						`warning     --host ${parsed.host} exposes the studio beyond this machine: anyone who can reach it can run your agents, workflows, and tools unless your server sets \`auth\``,
					]),
			"",
			"Ctrl+C to stop",
			"",
		].join("\n")
	);
	await new Promise<void>((done) => {
		const stop = () => {
			app.close().finally(done);
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
	});
}
