/**
 * Outbound HTTP for document loaders: an SSRF guard, manual redirect handling,
 * bounded bodies, timeouts, and credential resolution.
 *
 * Every loader that fetches a URL goes through {@link fetchGuarded}. By default
 * it refuses non-HTTP(S) schemes, URLs with embedded credentials, local host
 * names, and any host whose DNS answer includes a loopback, private, link-local,
 * CGNAT, multicast, or reserved address. Redirects are followed by hand so each
 * hop is re-checked, and an `Authorization` header is dropped when a redirect
 * leaves the original origin.
 *
 * `fetch` cannot pin the address it connects to, so a hostile DNS server can
 * still answer differently between the check and the connection (DNS
 * rebinding). Import untrusted URLs through a Ryu node (Space imports) when
 * that is part of your threat model: Core pins the checked addresses.
 */

import { type CoreUrlOptions, requireCoreUrl } from "../core-env.ts";
import { LoaderError } from "./types.ts";

/** The HTTP call loaders make (global `fetch` satisfies it). */
export type LoaderFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Resolve a host name to its IP addresses. */
export type HostLookup = (hostname: string) => Promise<string[]>;

/** Network options every fetching loader accepts. */
export interface NetworkOptions {
	/**
	 * Hosts (`example.internal`) or host:port pairs (`127.0.0.1:8080`) exempt
	 * from the private-address block. Prefer the narrow host:port form.
	 */
	allowedHosts?: readonly string[];
	/** Allow private, loopback, and link-local targets. Default `false`. */
	allowPrivateNetwork?: boolean;
	/** Fetch implementation (defaults to global `fetch`). */
	fetch?: LoaderFetch;
	/** DNS resolver used by the SSRF guard (defaults to `node:dns`). */
	lookup?: HostLookup;
	/** Largest response body read, in bytes. Default 10 MiB. */
	maxBytes?: number;
	/** Redirect hops followed before failing. Default 5. */
	maxRedirects?: number;
	/** Cancels in-flight requests. */
	signal?: AbortSignal;
	/** Per-request timeout in milliseconds. Default 30 000. */
	timeoutMs?: number;
	/** `User-Agent` sent with every request. */
	userAgent?: string;
}

/** A token, or a function that produces one when the loader runs. */
export type CredentialSource = string | (() => string | Promise<string>);

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 5;
/** The `User-Agent` loaders send unless the caller sets one. */
export const DEFAULT_USER_AGENT = "RyuDocumentLoader/1.0 (+https://ryu.run)";

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const METADATA_HOSTS = new Set([
	"metadata",
	"metadata.google.internal",
	"metadata.goog",
]);

function parseIpv4(value: string): number[] | undefined {
	const match = IPV4_PATTERN.exec(value);
	if (!match) {
		return;
	}
	const octets = match.slice(1).map(Number);
	return octets.every((octet) => octet <= 255) ? octets : undefined;
}

function parseIpv6(value: string): number[] | undefined {
	const inner = value.replace(/^\[/, "").replace(/\]$/, "").split("%")[0];
	if (!inner?.includes(":")) {
		return;
	}
	let text = inner;
	const tailV4 = parseIpv4(text.slice(text.lastIndexOf(":") + 1));
	if (tailV4) {
		const [a = 0, b = 0, c = 0, d = 0] = tailV4;
		text = `${text.slice(0, text.lastIndexOf(":") + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const [head = "", tail] = text.split("::");
	const left = head === "" ? [] : head.split(":");
	const right = tail === undefined || tail === "" ? [] : tail.split(":");
	const missing = 8 - left.length - right.length;
	if (missing < 0 || (tail === undefined && missing !== 0)) {
		return;
	}
	const segments = [
		...left,
		...Array.from({ length: missing }, () => "0"),
		...right,
	].map((segment) => Number.parseInt(segment, 16));
	return segments.length === 8 &&
		segments.every((segment) => Number.isInteger(segment) && segment >= 0)
		? segments
		: undefined;
}

function ipv4IsBlocked(octets: readonly number[]): boolean {
	const [a = 0, b = 0, c = 0] = octets;
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 0 && (c === 0 || c === 2)) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) ||
		(a === 198 && b === 51 && c === 100) ||
		(a === 203 && b === 0 && c === 113) ||
		a >= 224
	);
}

function embeddedIpv4(segments: readonly number[]): number[] | undefined {
	const high = segments[6] ?? 0;
	const low = segments[7] ?? 0;
	const v4 = [high >> 8, high & 0xff, low >> 8, low & 0xff];
	const zeroPrefix = segments.slice(0, 5).every((segment) => segment === 0);
	// ::ffff:a.b.c.d (mapped) and ::a.b.c.d (deprecated compatible form).
	if (zeroPrefix && (segments[5] === 0xff_ff || segments[5] === 0)) {
		return v4;
	}
	// 64:ff9b::/96 NAT64 carries the IPv4 target in the low 32 bits.
	if (
		segments[0] === 0x64 &&
		segments[1] === 0xff_9b &&
		segments.slice(2, 6).every((segment) => segment === 0)
	) {
		return v4;
	}
	return;
}

function ipv6IsBlocked(segments: readonly number[]): boolean {
	const first = segments[0] ?? 0;
	if (segments.every((segment) => segment === 0)) {
		return true;
	}
	const v4 = embeddedIpv4(segments);
	if (v4) {
		return ipv4IsBlocked(v4);
	}
	return (
		(first & 0xfe_00) === 0xfc_00 ||
		(first & 0xff_c0) === 0xfe_80 ||
		(first & 0xff_c0) === 0xfe_c0 ||
		(first & 0xff_00) === 0xff_00 ||
		(first === 0x20_01 && segments[1] === 0x0d_b8)
	);
}

/**
 * Whether `address` (an IPv4 or IPv6 literal) is loopback, private,
 * link-local, CGNAT, multicast, documentation, or otherwise non-public.
 * Unparseable input counts as blocked.
 */
export function isPrivateAddress(address: string): boolean {
	const v4 = parseIpv4(address);
	if (v4) {
		return ipv4IsBlocked(v4);
	}
	const v6 = parseIpv6(address);
	return v6 ? ipv6IsBlocked(v6) : true;
}

function isIpLiteral(hostname: string): boolean {
	return parseIpv4(hostname) !== undefined || parseIpv6(hostname) !== undefined;
}

function isLocalName(hostname: string): boolean {
	const name = hostname.toLowerCase().replace(/\.$/, "");
	return (
		name === "localhost" ||
		name.endsWith(".localhost") ||
		name.endsWith(".local") ||
		name.endsWith(".internal") ||
		METADATA_HOSTS.has(name)
	);
}

function hostAllowed(url: URL, allowed: readonly string[] | undefined) {
	if (!allowed?.length) {
		return false;
	}
	const host = url.hostname.toLowerCase();
	const port = url.port || (url.protocol === "https:" ? "443" : "80");
	return allowed.some((entry) => {
		const normalized = entry.trim().toLowerCase();
		return normalized === host || normalized === `${host}:${port}`;
	});
}

async function defaultLookup(hostname: string): Promise<string[]> {
	const dns = await import("node:dns/promises");
	const answers = await dns.lookup(hostname, { all: true, verbatim: true });
	return answers.map((answer) => answer.address);
}

/**
 * Check `url` against the SSRF policy. Throws {@link LoaderError} when the URL
 * is refused; resolves when it may be fetched.
 */
export async function assertFetchableUrl(
	url: URL,
	options: NetworkOptions = {}
): Promise<void> {
	if (!(url.protocol === "https:" || url.protocol === "http:")) {
		throw new LoaderError(
			`refused ${url.protocol} URL: only http(s) is allowed`
		);
	}
	if (url.username || url.password) {
		throw new LoaderError("refused a URL with embedded credentials");
	}
	if (options.allowPrivateNetwork || hostAllowed(url, options.allowedHosts)) {
		return;
	}
	const hostname = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
	if (isLocalName(hostname)) {
		throw new LoaderError(`refused local host ${url.hostname}`);
	}
	if (isIpLiteral(hostname)) {
		if (isPrivateAddress(hostname)) {
			throw new LoaderError(`refused private address ${url.hostname}`);
		}
		return;
	}
	const lookup = options.lookup ?? defaultLookup;
	let addresses: string[];
	try {
		addresses = await lookup(hostname);
	} catch (error) {
		throw new LoaderError(
			`cannot resolve ${hostname}: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	if (addresses.length === 0) {
		throw new LoaderError(`${hostname} did not resolve`);
	}
	if (addresses.some(isPrivateAddress)) {
		throw new LoaderError(
			`refused ${hostname}: it resolves to a private address`
		);
	}
}

function requestSignal(options: NetworkOptions): AbortSignal {
	const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}

/** Fetch `input` under the SSRF policy, following redirects hop by hop. */
export async function fetchGuarded(
	input: string | URL,
	init: RequestInit = {},
	options: NetworkOptions = {}
): Promise<Response> {
	const doFetch: LoaderFetch =
		options.fetch ?? ((url, request) => fetch(url, request));
	const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
	let url = new URL(input);
	const origin = url.origin;
	let headers = new Headers(init.headers);
	if (!headers.has("user-agent")) {
		headers.set("user-agent", options.userAgent ?? DEFAULT_USER_AGENT);
	}
	let method = init.method ?? "GET";
	let body = init.body;
	for (let hop = 0; hop <= maxRedirects; hop += 1) {
		await assertFetchableUrl(url, options);
		const response = await doFetch(url.toString(), {
			...init,
			method,
			body,
			headers,
			redirect: "manual",
			signal: requestSignal(options),
		});
		const location = response.headers.get("location");
		if (!(REDIRECT_STATUSES.has(response.status) && location)) {
			return response;
		}
		await response.body?.cancel();
		url = new URL(location, url);
		if (url.origin !== origin) {
			headers = new Headers(headers);
			headers.delete("authorization");
			headers.delete("cookie");
		}
		if (
			response.status === 303 ||
			(response.status !== 307 && response.status !== 308 && method === "POST")
		) {
			method = "GET";
			body = undefined;
		}
	}
	throw new LoaderError(
		`too many redirects fetching ${new URL(input).toString()}`
	);
}

/** Read a response body, refusing more than `maxBytes`. */
export async function readBodyCapped(
	response: Response,
	maxBytes: number = DEFAULT_MAX_BYTES
): Promise<Uint8Array> {
	const declared = Number(response.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > maxBytes) {
		await response.body?.cancel();
		throw new LoaderError(
			`response is ${declared} bytes; the limit is ${maxBytes}`
		);
	}
	if (!response.body) {
		return new Uint8Array();
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new LoaderError(`response exceeded the ${maxBytes}-byte limit`);
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/** A guarded GET/POST that fails on non-2xx and returns the capped body. */
export async function fetchBytes(
	url: string | URL,
	init: RequestInit,
	options: NetworkOptions
): Promise<{ bytes: Uint8Array; contentType: string; url: string }> {
	const response = await fetchGuarded(url, init, options);
	if (!response.ok) {
		const detail = new TextDecoder()
			.decode(
				await readBodyCapped(response, 4096).catch(() => new Uint8Array())
			)
			.slice(0, 300);
		throw new LoaderError(
			`${new URL(url).host} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
			response.status
		);
	}
	const bytes = await readBodyCapped(response, options.maxBytes);
	return {
		bytes,
		contentType: response.headers.get("content-type") ?? "",
		url: response.url || new URL(url).toString(),
	};
}

/** {@link fetchBytes}, decoded as UTF-8 text. */
export async function fetchText(
	url: string | URL,
	init: RequestInit,
	options: NetworkOptions
): Promise<{ contentType: string; text: string; url: string }> {
	const {
		bytes,
		contentType,
		url: finalUrl,
	} = await fetchBytes(url, init, options);
	return { contentType, text: new TextDecoder().decode(bytes), url: finalUrl };
}

/** {@link fetchBytes}, parsed as JSON. */
export async function fetchJson(
	url: string | URL,
	init: RequestInit,
	options: NetworkOptions
): Promise<unknown> {
	const { text } = await fetchText(url, init, options);
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new LoaderError(`${new URL(url).host} returned invalid JSON`);
	}
}

/** Resolve a {@link CredentialSource} to a non-empty token. */
export async function resolveCredential(
	source: CredentialSource | undefined,
	label: string
): Promise<string | undefined> {
	if (source === undefined) {
		return;
	}
	const value = typeof source === "function" ? await source() : source;
	const token = value.trim();
	if (!token) {
		throw new LoaderError(`${label} credential is empty`);
	}
	return token;
}

/**
 * Where a Ryu Core node is and how to authenticate to it. The node URL goes in
 * `baseUrl` (or the deprecated `nodeUrl`), e.g. `http://127.0.0.1:7980`. One
 * of the two is required; a missing URL throws when the target is used.
 */
export interface CoreTarget extends CoreUrlOptions {
	/** Fetch implementation (defaults to global `fetch`). */
	fetch?: LoaderFetch;
	/** Node bearer token. */
	token?: string;
	/** Verified end-user JWT for an org-bound Core. */
	userJwt?: string;
}

/** Headers for a request to Core. */
export function coreHeaders(target: CoreTarget): Record<string, string> {
	const headers: Record<string, string> = {};
	const bearer = target.token ?? target.userJwt;
	if (bearer) {
		headers.authorization = `Bearer ${bearer}`;
	}
	if (target.userJwt) {
		headers["x-ryu-user-jwt"] = target.userJwt;
	}
	return headers;
}

/** Normalized Core base URL (no trailing slash). */
export function coreBase(target: CoreTarget): string {
	return requireCoreUrl(target);
}

/** Options for {@link ryuVaultSecret}. */
export interface RyuVaultSecretOptions extends CoreTarget {
	/** Vault environment; defaults to the node's active one. */
	environment?: string;
	/** Secret name, e.g. `NOTION_TOKEN`. */
	name: string;
	/** Folder path, e.g. `/connectors`. Defaults to the root. */
	path?: string;
}

/**
 * A credential read from a Ryu node's vault when the loader runs.
 *
 * Calls `POST /api/vault/secrets/:name/reveal`, so the caller's token needs read
 * access to that secret. The value is never cached by the SDK.
 */
export function ryuVaultSecret(
	options: RyuVaultSecretOptions
): () => Promise<string> {
	return async () => {
		const doFetch: LoaderFetch =
			options.fetch ?? ((url, request) => fetch(url, request));
		const body: Record<string, string> = {};
		if (options.environment) {
			body.environment = options.environment;
		}
		if (options.path) {
			body.path = options.path;
		}
		const response = await doFetch(
			`${coreBase(options)}/api/vault/secrets/${encodeURIComponent(options.name)}/reveal`,
			{
				method: "POST",
				headers: {
					...coreHeaders(options),
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			}
		);
		const payload: unknown = await response.json().catch(() => null);
		const value =
			payload && typeof payload === "object" && "value" in payload
				? payload.value
				: undefined;
		if (!response.ok || typeof value !== "string") {
			throw new LoaderError(
				`cannot read vault secret ${options.name} (HTTP ${response.status})`,
				response.status
			);
		}
		return value;
	};
}
