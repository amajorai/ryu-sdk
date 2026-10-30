/**
 * Outbound endpoint policy for the A2A client.
 *
 * Mirrors Core's `EndpointPolicy` (`crates/core/a2a/src/security.rs`): only
 * HTTPS, no embedded credentials or fragments, and no local or non-public
 * hosts. Plain HTTP is allowed only for loopback hosts when the caller opts in
 * with `allowLoopbackHttp` (local development and tests).
 *
 * Core also re-checks every DNS answer immediately before connecting. `fetch`
 * gives the SDK no way to pin resolved addresses, so this check covers the URL
 * and IP-literal hosts only; route untrusted peers through a Ryu node when DNS
 * rebinding is part of your threat model.
 */

/** Options that relax the default HTTPS-only, public-only policy. */
export interface EndpointPolicy {
	/** Permit `http://` for loopback hosts (`localhost`, `127.0.0.0/8`, `::1`). */
	allowLoopbackHttp?: boolean;
}

/** Why an endpoint was refused. */
export type EndpointErrorCode =
	| "embedded_credentials"
	| "fragment"
	| "insecure_transport"
	| "invalid_url"
	| "missing_host"
	| "non_public_address";

/** An endpoint failed the outbound policy. */
export class A2AEndpointError extends Error {
	readonly code: EndpointErrorCode;

	constructor(code: EndpointErrorCode) {
		super(`[ryu-sdk] A2A endpoint refused: ${code.replaceAll("_", " ")}`);
		this.name = "A2AEndpointError";
		this.code = code;
	}
}

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseIpv4(host: string): number[] | undefined {
	const match = IPV4_PATTERN.exec(host);
	if (!match) {
		return;
	}
	const octets = match.slice(1).map(Number);
	return octets.every((octet) => octet <= 255) ? octets : undefined;
}

/** Expand a (WHATWG-normalized) IPv6 literal into eight 16-bit segments. */
function parseIpv6(host: string): number[] | undefined {
	if (!(host.startsWith("[") && host.endsWith("]"))) {
		return;
	}
	const inner = host.slice(1, -1);
	const [head = "", tail] = inner.split("::");
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
		segments.every((value) => Number.isInteger(value))
		? segments
		: undefined;
}

function ipv4IsLoopback([a]: number[]): boolean {
	return a === 127;
}

function ipv4IsPublic(octets: number[]): boolean {
	const [a = 0, b = 0, c = 0, d = 0] = octets;
	const blocked =
		a === 10 ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a >= 224 && a <= 239) ||
		a === 0 ||
		(a === 255 && b === 255 && c === 255 && d === 255) ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 192 && b === 0 && c === 0) ||
		(a === 192 && b === 0 && c === 2) ||
		(a === 198 && (b === 18 || b === 19)) ||
		(a === 198 && b === 51 && c === 100) ||
		(a === 203 && b === 0 && c === 113) ||
		a >= 240;
	return !blocked;
}

function ipv6MappedIpv4(segments: number[]): number[] | undefined {
	const prefix = segments.slice(0, 6);
	if (
		prefix.slice(0, 5).every((value) => value === 0) &&
		prefix[5] === 0xff_ff
	) {
		const high = segments[6] ?? 0;
		const low = segments[7] ?? 0;
		return [high >> 8, high & 0xff, low >> 8, low & 0xff];
	}
	return;
}

function ipv6IsLoopback(segments: number[]): boolean {
	return (
		segments.slice(0, 7).every((value) => value === 0) && segments[7] === 1
	);
}

function ipv6IsPublic(segments: number[]): boolean {
	const mapped = ipv6MappedIpv4(segments);
	if (mapped) {
		return ipv4IsPublic(mapped);
	}
	const first = segments[0] ?? 0;
	const unspecified = segments.every((value) => value === 0);
	return !(
		ipv6IsLoopback(segments) ||
		unspecified ||
		(first & 0xff_00) === 0xff_00 ||
		(first & 0xfe_00) === 0xfc_00 ||
		(first & 0xff_c0) === 0xfe_80 ||
		(first & 0xff_c0) === 0xfe_c0 ||
		(first === 0x20_01 && segments[1] === 0x0d_b8)
	);
}

function isLocalDomain(domain: string): boolean {
	const normalized = domain.toLowerCase();
	return (
		normalized === "localhost" ||
		normalized.endsWith(".localhost") ||
		normalized.endsWith(".local") ||
		normalized.endsWith(".internal")
	);
}

/** Validate a peer URL against the outbound policy and return it parsed. */
export function validateEndpoint(
	value: string,
	policy: EndpointPolicy = {}
): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new A2AEndpointError("invalid_url");
	}
	if (url.username !== "" || url.password !== "") {
		throw new A2AEndpointError("embedded_credentials");
	}
	if (url.hash !== "" || value.includes("#")) {
		throw new A2AEndpointError("fragment");
	}
	const host = url.hostname;
	if (host === "") {
		throw new A2AEndpointError("missing_host");
	}
	const ipv4 = parseIpv4(host);
	const ipv6 = ipv4 ? undefined : parseIpv6(host);
	const domain = ipv4 || ipv6 ? undefined : host;
	let loopback = false;
	if (ipv4) {
		loopback = ipv4IsLoopback(ipv4);
	} else if (ipv6) {
		loopback = ipv6IsLoopback(ipv6);
	} else if (domain) {
		const lower = domain.toLowerCase();
		loopback = lower === "localhost" || lower.endsWith(".localhost");
	}
	const allowLoopback = policy.allowLoopbackHttp === true;
	const loopbackHttp = url.protocol === "http:" && allowLoopback && loopback;
	if (!(url.protocol === "https:" || loopbackHttp)) {
		throw new A2AEndpointError("insecure_transport");
	}
	const addressAllowed = (isPublic: boolean) =>
		(allowLoopback && loopback) || isPublic;
	if (ipv4 && !addressAllowed(ipv4IsPublic(ipv4))) {
		throw new A2AEndpointError("non_public_address");
	}
	if (ipv6 && !addressAllowed(ipv6IsPublic(ipv6))) {
		throw new A2AEndpointError("non_public_address");
	}
	if (domain && isLocalDomain(domain) && !loopbackHttp) {
		throw new A2AEndpointError("non_public_address");
	}
	return url;
}
