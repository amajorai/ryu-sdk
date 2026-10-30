/**
 * A2A v1 client for the Ryu SDK, speaking the same protocol as Ryu Core's
 * peer client (`crates/core/a2a/src/client.rs`).
 *
 * - Discovery fetches `/.well-known/agent-card.json` (or an explicit `.json`
 *   card URL), validates the card, and checks its JWS signatures against a
 *   JWKS served from the card's own origin. A card with an invalid signature
 *   is always rejected; `requireVerifiedSignature` also rejects unsigned and
 *   unverifiable cards.
 * - Calls use the JSON-RPC 2.0 binding (`POST <url>` with `SendMessage`, …)
 *   or the HTTP+JSON binding (`POST <url>/message:send`, `GET <url>/tasks/{id}`,
 *   …), preferring JSON-RPC like Core. Streaming methods read Server-Sent
 *   Events.
 * - Every request sends `A2A-Version: 1.0`, follows at most three same-origin
 *   redirects (each re-validated against the endpoint policy), and bounds the
 *   response size.
 *
 * Pass `fetch` to supply a custom transport (tests use an in-memory one).
 */

import { z } from "zod";
import type { AgentToolRunnable } from "../agent/network.ts";
import {
	type PrimitiveJsonValue,
	primitiveJsonSchema,
} from "../runnable/primitive-contracts.ts";
import {
	type CardSignatureStatus,
	type CardVerificationKey,
	cardSignatures,
	decodeProtectedHeader,
	ed25519KeysFromJwks,
	MAX_CARD_SIGNATURES,
	verifyAgentCardSignatures,
} from "./card-signing.ts";
import { type EndpointPolicy, validateEndpoint } from "./endpoint.ts";
import { A2AError, truncateDetail } from "./errors.ts";
import { SseDecoder } from "./sse.ts";
import { type A2AToolOptions, a2aAgentTool } from "./tool.ts";
import {
	A2A_BINDING_HTTP_JSON,
	A2A_BINDING_JSONRPC,
	A2A_METHODS,
	A2A_PROTOCOL_VERSION,
	type A2AAgentCard,
	type A2AListPushConfigsResponse,
	type A2AListTasksParams,
	type A2AListTasksResponse,
	type A2AMessage,
	type A2AMessageInput,
	type A2ASendMessageParams,
	type A2ASendMessageResponse,
	type A2AStreamResponse,
	type A2ATask,
	type A2ATaskPushNotificationConfig,
	a2aAgentCardSchema,
	a2aListPushConfigsResponseSchema,
	a2aListTasksResponseSchema,
	a2aMessageInputSchema,
	a2aPushConfigSchema,
	a2aSendMessageResponseSchema,
	a2aStreamResponseSchema,
	a2aTaskSchema,
	jsonRpcResponseSchema,
} from "./types.ts";

const A2A_MEDIA_TYPE = "application/a2a+json";
const SSE_MEDIA_TYPE = "text/event-stream";
const JWKS_ACCEPT = "application/jwk-set+json, application/json";
const MAX_AGENT_CARD_BYTES = 512 * 1024;
const MAX_CARD_JWKS_FETCHES = 2;
const MAX_JWKS_BYTES = 64 * 1024;
const MAX_ERROR_DETAIL_BYTES = 4096;
const WELL_KNOWN_CARD_PATH = "/.well-known/agent-card.json";
const FORBIDDEN_API_KEY_HEADERS = new Set([
	"host",
	"content-length",
	"transfer-encoding",
]);
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const DEFAULT_LIMITS: Required<A2ALimits> = {
	maxRedirects: 3,
	maxResponseBytes: 4 * 1024 * 1024,
	maxSseEventBytes: 4 * 1024 * 1024,
	requestTimeoutMs: 300_000,
};
const oauthTokenSchema = z.looseObject({
	access_token: z.string(),
	token_type: z.string().nullish(),
});
const deleteResultSchema = primitiveJsonSchema;

// ── Options ───────────────────────────────────────────────────────────────────

/** A transport binding from an Agent Card's `supportedInterfaces`. */
export type A2ATransportBinding =
	| typeof A2A_BINDING_HTTP_JSON
	| typeof A2A_BINDING_JSONRPC;

/** How the client authenticates to the peer (same kinds as Core's peers). */
export type A2ACredential =
	| { kind: "none" }
	| { kind: "bearer"; token: string }
	| { header: string; kind: "api_key"; value: string }
	| { kind: "basic"; password: string; username: string }
	| {
			clientId: string;
			clientSecret: string;
			kind: "oauth2_client_credentials";
			scopes?: string[];
			tokenUrl: string;
	  };

/** Size, redirect, and time bounds (defaults match Core). */
export interface A2ALimits {
	/** Same-origin redirects followed per request (default 3). */
	maxRedirects?: number;
	/** Largest JSON response body accepted (default 4 MiB). */
	maxResponseBytes?: number;
	/** Largest single SSE event accepted (default 4 MiB). */
	maxSseEventBytes?: number;
	/** Timeout for non-streaming requests (default 300 s). */
	requestTimeoutMs?: number;
}

/** Transport options shared by discovery and calls. */
export interface A2ATransportOptions {
	/** Custom `fetch` implementation; defaults to `globalThis.fetch`. */
	fetch?: typeof globalThis.fetch;
	limits?: A2ALimits;
	/** Outbound endpoint policy (HTTPS and public hosts only by default). */
	policy?: EndpointPolicy;
}

/** Options for `discoverAgentCard`. */
export interface DiscoverAgentCardOptions extends A2ATransportOptions {
	/** Reject cards whose signature is missing or could not be verified. */
	requireVerifiedSignature?: boolean;
	signal?: AbortSignal;
}

/** A discovered Agent Card plus the outcome of checking its signatures. */
export interface DiscoveredAgentCard {
	card: A2AAgentCard;
	/** The card JSON exactly as received (signatures are verified over it). */
	raw: PrimitiveJsonValue;
	signature: CardSignatureStatus;
}

/** The interface a client talks to. */
export interface A2AEndpoint {
	binding: A2ATransportBinding;
	tenant?: string;
	url: URL;
}

/** Options for `new A2AClient(endpoint, options)`. */
export interface A2AClientOptions extends A2ATransportOptions {
	/** The card the endpoint came from, when known. */
	card?: A2AAgentCard;
	credential?: A2ACredential;
	/** Extension URIs sent in `A2A-Extensions`. */
	extensions?: string[];
	/** Signature status of `card`, when known. */
	signature?: CardSignatureStatus;
}

/** Options for `A2AClient.connect`. */
export interface A2AConnectOptions
	extends Omit<A2AClientOptions, "card" | "signature"> {
	/** Binding preference (default JSON-RPC, then HTTP+JSON). */
	preference?: A2ATransportBinding[];
	requireVerifiedSignature?: boolean;
	signal?: AbortSignal;
}

// ── HTTP plumbing ─────────────────────────────────────────────────────────────

interface SendOptions {
	accept: string;
	body?: string;
	headers?: Headers;
	signal?: AbortSignal;
}

class HttpTransport {
	readonly limits: Required<A2ALimits>;
	readonly policy: EndpointPolicy;
	private readonly fetchImpl: typeof globalThis.fetch;

	constructor(options: A2ATransportOptions) {
		this.fetchImpl = options.fetch ?? globalThis.fetch;
		this.policy = options.policy ?? {};
		this.limits = { ...DEFAULT_LIMITS, ...options.limits };
	}

	/** Send one request, following same-origin redirects only. */
	async send(method: string, url: URL, options: SendOptions) {
		let current = validateEndpoint(url.href, this.policy);
		const origin = current.origin;
		for (let redirects = 0; ; redirects++) {
			const headers = new Headers(options.headers);
			headers.set("A2A-Version", A2A_PROTOCOL_VERSION);
			headers.set("accept", options.accept);
			if (options.body !== undefined) {
				headers.set("content-type", A2A_MEDIA_TYPE);
			}
			const response = await this.fetchOnce(current, {
				method,
				headers,
				body: options.body,
				signal: options.signal,
			});
			if (response.type === "opaqueredirect") {
				// Browser `fetch` hides a manual redirect's target, so it cannot be
				// re-checked against the policy and origin; refuse it.
				throw new A2AError(
					"invalid_protocol",
					"redirect target cannot be inspected by this fetch implementation"
				);
			}
			if (response.status < 300 || response.status > 399) {
				return response;
			}
			if (redirects >= this.limits.maxRedirects) {
				throw new A2AError(
					"too_many_redirects",
					"A2A peer returned too many redirects"
				);
			}
			const location = response.headers.get("location");
			if (!location) {
				throw new A2AError("invalid_protocol", "redirect location is missing");
			}
			let next: URL;
			try {
				next = new URL(location, current);
			} catch {
				throw new A2AError("invalid_protocol", "redirect URL is invalid");
			}
			next = validateEndpoint(next.href, this.policy);
			if (next.origin !== origin) {
				throw new A2AError(
					"cross_origin_redirect",
					"A2A redirect crossed origins"
				);
			}
			current = next;
		}
	}

	/** One request with redirects left to the caller; network failures map to `transport`. */
	async fetchOnce(
		url: URL,
		init: {
			body?: string;
			headers: Headers;
			method: string;
			signal?: AbortSignal;
		}
	): Promise<Response> {
		try {
			return await this.fetchImpl(url.href, { ...init, redirect: "manual" });
		} catch (error) {
			if (init.signal?.aborted) {
				throw error;
			}
			throw new A2AError("transport", "A2A request failed");
		}
	}

	timeoutSignal(signal?: AbortSignal): AbortSignal {
		const timeout = AbortSignal.timeout(this.limits.requestTimeoutMs);
		return signal ? AbortSignal.any([signal, timeout]) : timeout;
	}
}

async function readBounded(
	response: Response,
	maxBytes: number
): Promise<Uint8Array> {
	const declared = Number(response.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > maxBytes) {
		await response.body?.cancel().catch(() => undefined);
		throw new A2AError(
			"response_too_large",
			"A2A response exceeded the configured size limit"
		);
	}
	if (!response.body) {
		return new Uint8Array(0);
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		total += value.length;
		if (total > maxBytes) {
			await reader.cancel().catch(() => undefined);
			throw new A2AError(
				"response_too_large",
				"A2A response exceeded the configured size limit"
			);
		}
		chunks.push(value);
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.length;
	}
	return body;
}

async function httpError(response: Response, limit: number) {
	let detail = "request failed";
	try {
		const bytes = await readBounded(
			response,
			Math.min(limit, MAX_ERROR_DETAIL_BYTES)
		);
		detail = truncateDetail(
			new TextDecoder("utf-8", { fatal: true }).decode(bytes)
		);
	} catch {
		// Keep the generic detail when the body is unreadable or too large.
	}
	return new A2AError(
		"http_status",
		`A2A peer returned HTTP status ${response.status}: ${detail}`,
		{ status: response.status }
	);
}

async function ensureSuccess(
	response: Response,
	maxBytes: number
): Promise<Uint8Array> {
	if (!response.ok) {
		throw await httpError(response, maxBytes);
	}
	return readBounded(response, maxBytes);
}

function parseJsonBytes(bytes: Uint8Array): PrimitiveJsonValue {
	try {
		return primitiveJsonSchema.parse(
			JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
		);
	} catch (error) {
		throw protocolError(error);
	}
}

function protocolError(error: Parameters<typeof describeError>[0]) {
	return new A2AError(
		"invalid_protocol",
		`A2A protocol response is invalid: ${truncateDetail(describeError(error))}`
	);
}

const errorSchema = z.instanceof(Error);
function describeError(
	error: Parameters<typeof errorSchema.safeParse>[0]
): string {
	const parsed = errorSchema.safeParse(error);
	return parsed.success ? parsed.data.message : String(error);
}

function parseWith<T>(schema: z.ZodType<T>, value: PrimitiveJsonValue): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		throw protocolError(parsed.error);
	}
	return parsed.data;
}

// ── Agent Card discovery ──────────────────────────────────────────────────────

function utf8Length(text: string): number {
	return new TextEncoder().encode(text).length;
}

/** Validate a card's limits and the endpoints of its v1 HTTP interfaces. */
export function validateAgentCard(
	card: A2AAgentCard,
	policy: EndpointPolicy = {}
): void {
	if (card.name.trim() === "" || utf8Length(card.name) > 160) {
		throw new A2AError(
			"invalid_agent_card",
			"agent card is invalid: name must contain 1 to 160 bytes"
		);
	}
	if (utf8Length(card.description) > 4000) {
		throw new A2AError(
			"invalid_agent_card",
			"agent card is invalid: description exceeds 4000 bytes"
		);
	}
	const interfaces = card.supportedInterfaces;
	if (interfaces.length === 0 || interfaces.length > 16) {
		throw new A2AError(
			"invalid_agent_card",
			"agent card is invalid: supportedInterfaces must contain 1 to 16 entries"
		);
	}
	if (card.skills.length > 256) {
		throw new A2AError(
			"invalid_agent_card",
			"agent card is invalid: agent card advertises too many skills"
		);
	}
	for (const entry of interfaces) {
		const http =
			entry.protocolBinding === A2A_BINDING_JSONRPC ||
			entry.protocolBinding === A2A_BINDING_HTTP_JSON;
		if (http && entry.protocolVersion === A2A_PROTOCOL_VERSION) {
			validateEndpoint(entry.url, policy);
		}
	}
}

/** Pick the first interface matching `preference` (JSON-RPC first by default). */
export function selectEndpoint(
	card: A2AAgentCard,
	policy: EndpointPolicy = {},
	preference: A2ATransportBinding[] = []
): A2AEndpoint {
	validateAgentCard(card, policy);
	const order: A2ATransportBinding[] =
		preference.length > 0
			? preference
			: [A2A_BINDING_JSONRPC, A2A_BINDING_HTTP_JSON];
	for (const binding of order) {
		const match = card.supportedInterfaces.find(
			(entry) =>
				entry.protocolBinding.toUpperCase() === binding &&
				entry.protocolVersion === A2A_PROTOCOL_VERSION
		);
		if (match) {
			const endpoint: A2AEndpoint = {
				url: validateEndpoint(match.url, policy),
				binding,
			};
			if (match.tenant) {
				endpoint.tenant = match.tenant;
			}
			return endpoint;
		}
	}
	throw new A2AError(
		"no_compatible_interface",
		"agent card has no compatible A2A v1 HTTP interface"
	);
}

type KeySet =
	| { keys: CardVerificationKey[]; ok: true }
	| { ok: false; reason: string };

async function fetchCardJwks(
	jku: string,
	cardOrigin: string,
	http: HttpTransport,
	signal?: AbortSignal
): Promise<KeySet> {
	let url: URL;
	try {
		url = validateEndpoint(jku, http.policy);
	} catch {
		return { ok: false, reason: "signature jku is not an allowed URL" };
	}
	if (url.origin !== cardOrigin) {
		return {
			ok: false,
			reason: "signature jku is not on the Agent Card's origin",
		};
	}
	const unavailable: KeySet = {
		ok: false,
		reason: "signature key set could not be fetched",
	};
	let bytes: Uint8Array;
	try {
		// Like Core, the key fetch follows no redirects: the JWKS must live at
		// `jku` itself, and a 3xx answer is not a success.
		const response = await http.fetchOnce(url, {
			method: "GET",
			headers: new Headers({ accept: JWKS_ACCEPT }),
			signal: http.timeoutSignal(signal),
		});
		if (!response.ok) {
			return unavailable;
		}
		bytes = await readBounded(response, MAX_JWKS_BYTES);
	} catch {
		return unavailable;
	}
	let jwks: PrimitiveJsonValue;
	try {
		jwks = parseJsonBytes(bytes);
	} catch {
		return { ok: false, reason: "signature key set is not JSON" };
	}
	return { ok: true, keys: await ed25519KeysFromJwks(jwks) };
}

/**
 * Resolve each signature's `jku` and verify the card. A `jku` is honoured only
 * on the card's own origin, so a signature cannot borrow trust from a key set
 * hosted elsewhere.
 */
async function checkCardSignatures(
	raw: PrimitiveJsonValue,
	cardOrigin: string,
	http: HttpTransport,
	signal?: AbortSignal
): Promise<CardSignatureStatus> {
	const signatures = cardSignatures(raw);
	const keySets = new Map<string, KeySet>();
	if (signatures.ok) {
		for (const entry of signatures.entries.slice(0, MAX_CARD_SIGNATURES)) {
			const jku = decodeProtectedHeader(entry.protected)?.jku;
			if (
				jku === undefined ||
				keySets.has(jku) ||
				keySets.size >= MAX_CARD_JWKS_FETCHES
			) {
				continue;
			}
			keySets.set(jku, await fetchCardJwks(jku, cardOrigin, http, signal));
		}
	}
	return verifyAgentCardSignatures(raw, (header) => {
		if (header.jku === undefined) {
			return {
				kind: "unavailable",
				reason: "signature names no jku and no trusted key is configured",
			};
		}
		const set = keySets.get(header.jku);
		if (!set) {
			return {
				kind: "unavailable",
				reason: "signature key set was not fetched",
			};
		}
		if (!set.ok) {
			return { kind: "unavailable", reason: set.reason };
		}
		const match = set.keys.find((candidate) => candidate.kid === header.kid);
		return match
			? { kind: "found", key: match.key }
			: { kind: "not_published" };
	});
}

/**
 * Fetch, validate, and signature-check a remote Agent Card. A base URL is
 * resolved to `/.well-known/agent-card.json`; a URL ending in `.json` is used
 * as-is.
 */
export async function discoverAgentCard(
	cardOrBaseUrl: string,
	options: DiscoverAgentCardOptions = {}
): Promise<DiscoveredAgentCard> {
	const http = new HttpTransport(options);
	const url = validateEndpoint(cardOrBaseUrl, http.policy);
	if (!url.pathname.endsWith(".json")) {
		url.pathname = WELL_KNOWN_CARD_PATH;
		url.search = "";
		url.hash = "";
	}
	const response = await http.send("GET", url, {
		accept: A2A_MEDIA_TYPE,
		signal: http.timeoutSignal(options.signal),
	});
	const bytes = await ensureSuccess(
		response,
		Math.min(http.limits.maxResponseBytes, MAX_AGENT_CARD_BYTES)
	);
	const raw = parseJsonBytes(bytes);
	const card = parseWith(a2aAgentCardSchema, raw);
	validateAgentCard(card, http.policy);
	const signature = await checkCardSignatures(
		raw,
		url.origin,
		http,
		options.signal
	);
	if (signature.status === "invalid") {
		throw new A2AError(
			"invalid_agent_card",
			`agent card is invalid: signature verification failed: ${signature.reason}`
		);
	}
	if (options.requireVerifiedSignature && signature.status !== "verified") {
		throw new A2AError(
			"invalid_agent_card",
			"agent card is invalid: a verified Agent Card signature is required"
		);
	}
	return { card, raw, signature };
}

// ── Client ────────────────────────────────────────────────────────────────────

/** JSON-RPC `params` / HTTP+JSON body for one call. */
interface RpcRequest {
	tenant?: string;
}

interface RestCall {
	body?: string;
	method: "DELETE" | "GET" | "POST";
	query?: [string, string][];
	segments: string[];
}

function encodeSegment(segment: string): string {
	return encodeURIComponent(segment).replaceAll("%3A", ":");
}

function restUrl(base: URL, call: RestCall): URL {
	// URL parsing resolves `.` and `..` as dot segments, so an id like `..`
	// would move the request off the intended resource path.
	if (call.segments.some((segment) => segment === "." || segment === "..")) {
		throw new A2AError(
			"invalid_protocol",
			"A2A resource id must not be a . or .. path segment"
		);
	}
	const url = new URL(base.href);
	const path = url.pathname.endsWith("/")
		? url.pathname.slice(0, -1)
		: url.pathname;
	url.pathname = `${path}/${call.segments.join("/")}`;
	if (call.query && call.query.length > 0) {
		url.search = new URLSearchParams(call.query).toString();
	}
	return url;
}

function basicAuthorization(username: string, password: string): string {
	let binary = "";
	for (const byte of new TextEncoder().encode(`${username}:${password}`)) {
		binary += String.fromCharCode(byte);
	}
	return `Basic ${btoa(binary)}`;
}

function setHeader(headers: Headers, name: string, value: string) {
	try {
		headers.set(name, value);
	} catch {
		throw new A2AError(
			"invalid_credential",
			"A2A authentication configuration is invalid"
		);
	}
}

const sendParamsSchema = z.union([
	z.string().transform((message): A2ASendMessageParams => ({ message })),
	z.custom<A2ASendMessageParams>(
		(value) =>
			z.looseObject({ message: a2aMessageInputSchema }).safeParse(value).success
	),
]);

/** Build a wire message from a string or a partial message. */
export function buildA2AMessage(input: A2AMessageInput | string): A2AMessage {
	const message = a2aMessageInputSchema.parse(input);
	return {
		...message,
		messageId: message.messageId ?? crypto.randomUUID(),
		role: message.role ?? "ROLE_USER",
	};
}

/** A connection to one remote A2A agent endpoint. */
export class A2AClient {
	/** The Agent Card the endpoint was selected from, when discovered. */
	readonly card?: A2AAgentCard;
	readonly endpoint: A2AEndpoint;
	/** Signature status of `card`, when discovered. */
	readonly signature?: CardSignatureStatus;
	private readonly credential: A2ACredential;
	private readonly extensions: string[];
	private readonly http: HttpTransport;

	constructor(endpoint: A2AEndpoint, options: A2AClientOptions = {}) {
		this.http = new HttpTransport(options);
		this.endpoint = {
			...endpoint,
			url: validateEndpoint(endpoint.url.href, this.http.policy),
		};
		this.credential = options.credential ?? { kind: "none" };
		this.extensions = options.extensions ?? [];
		this.card = options.card;
		this.signature = options.signature;
	}

	/** Discover a peer's Agent Card and connect to its preferred interface. */
	static async connect(
		cardOrBaseUrl: string,
		options: A2AConnectOptions = {}
	): Promise<A2AClient> {
		const discovered = await discoverAgentCard(cardOrBaseUrl, options);
		const endpoint = selectEndpoint(
			discovered.card,
			options.policy,
			options.preference
		);
		return new A2AClient(endpoint, {
			...options,
			card: discovered.card,
			signature: discovered.signature,
		});
	}

	/** `SendMessage`: returns the created task or a direct reply message. */
	sendMessage(
		params: A2ASendMessageParams | string,
		signal?: AbortSignal
	): Promise<A2ASendMessageResponse> {
		const request = this.sendRequest(params);
		return this.callJson(
			A2A_METHODS.sendMessage,
			{
				method: "POST",
				segments: ["message:send"],
				body: JSON.stringify(request),
			},
			request,
			a2aSendMessageResponseSchema,
			signal
		);
	}

	/** `SendStreamingMessage`: stream task, status, and artifact updates. */
	sendStreamingMessage(
		params: A2ASendMessageParams | string,
		signal?: AbortSignal
	): AsyncGenerator<A2AStreamResponse> {
		const request = this.sendRequest(params);
		return this.callStream(
			A2A_METHODS.sendStreamingMessage,
			{
				method: "POST",
				segments: ["message:stream"],
				body: JSON.stringify(request),
			},
			request,
			signal
		);
	}

	/** `GetTask`. */
	getTask(
		id: string,
		options: { historyLength?: number; signal?: AbortSignal } = {}
	): Promise<A2ATask> {
		const request = this.withTenant({
			id,
			historyLength: options.historyLength,
		});
		const query: [string, string][] = [];
		if (options.historyLength !== undefined) {
			query.push(["historyLength", String(options.historyLength)]);
		}
		return this.callJson(
			A2A_METHODS.getTask,
			{ method: "GET", segments: ["tasks", encodeSegment(id)], query },
			request,
			a2aTaskSchema,
			options.signal
		);
	}

	/** `ListTasks`. */
	listTasks(
		params: A2AListTasksParams = {},
		signal?: AbortSignal
	): Promise<A2AListTasksResponse> {
		const request = this.withTenant({ ...params });
		const query: [string, string][] = [];
		const keys = [
			"contextId",
			"status",
			"pageSize",
			"pageToken",
			"historyLength",
			"statusTimestampAfter",
			"includeArtifacts",
		] as const;
		for (const key of keys) {
			const value = params[key];
			if (value !== undefined) {
				query.push([key, String(value)]);
			}
		}
		return this.callJson(
			A2A_METHODS.listTasks,
			{ method: "GET", segments: ["tasks"], query },
			request,
			a2aListTasksResponseSchema,
			signal
		);
	}

	/** `CancelTask`. */
	cancelTask(id: string, signal?: AbortSignal): Promise<A2ATask> {
		return this.callJson(
			A2A_METHODS.cancelTask,
			{ method: "POST", segments: ["tasks", `${encodeSegment(id)}:cancel`] },
			this.withTenant({ id }),
			a2aTaskSchema,
			signal
		);
	}

	/** `SubscribeToTask`: resume streaming updates for an existing task. */
	subscribeToTask(
		id: string,
		signal?: AbortSignal
	): AsyncGenerator<A2AStreamResponse> {
		return this.callStream(
			A2A_METHODS.subscribeToTask,
			{
				method: "POST",
				segments: ["tasks", `${encodeSegment(id)}:subscribe`],
			},
			this.withTenant({ id }),
			signal
		);
	}

	/** `CreateTaskPushNotificationConfig`. */
	createPushConfig(
		config: A2ATaskPushNotificationConfig,
		signal?: AbortSignal
	): Promise<A2ATaskPushNotificationConfig> {
		const request = this.withTenant({ ...config });
		return this.callJson(
			A2A_METHODS.createPushConfig,
			{
				method: "POST",
				segments: [
					"tasks",
					encodeSegment(config.taskId),
					"pushNotificationConfigs",
				],
				body: JSON.stringify(request),
			},
			request,
			a2aPushConfigSchema,
			signal
		);
	}

	/** `GetTaskPushNotificationConfig`. */
	getPushConfig(
		taskId: string,
		id: string,
		signal?: AbortSignal
	): Promise<A2ATaskPushNotificationConfig> {
		return this.callJson(
			A2A_METHODS.getPushConfig,
			{
				method: "GET",
				segments: [
					"tasks",
					encodeSegment(taskId),
					"pushNotificationConfigs",
					encodeSegment(id),
				],
			},
			this.withTenant({ taskId, id }),
			a2aPushConfigSchema,
			signal
		);
	}

	/** `ListTaskPushNotificationConfigs`. */
	listPushConfigs(
		taskId: string,
		options: {
			pageSize?: number;
			pageToken?: string;
			signal?: AbortSignal;
		} = {}
	): Promise<A2AListPushConfigsResponse> {
		const query: [string, string][] = [];
		if (options.pageSize !== undefined) {
			query.push(["pageSize", String(options.pageSize)]);
		}
		if (options.pageToken !== undefined) {
			query.push(["pageToken", options.pageToken]);
		}
		return this.callJson(
			A2A_METHODS.listPushConfigs,
			{
				method: "GET",
				segments: ["tasks", encodeSegment(taskId), "pushNotificationConfigs"],
				query,
			},
			this.withTenant({
				taskId,
				pageSize: options.pageSize,
				pageToken: options.pageToken,
			}),
			a2aListPushConfigsResponseSchema,
			options.signal
		);
	}

	/** `DeleteTaskPushNotificationConfig`. */
	async deletePushConfig(
		taskId: string,
		id: string,
		signal?: AbortSignal
	): Promise<void> {
		const rest: RestCall = {
			method: "DELETE",
			segments: [
				"tasks",
				encodeSegment(taskId),
				"pushNotificationConfigs",
				encodeSegment(id),
			],
		};
		if (this.endpoint.binding === A2A_BINDING_JSONRPC) {
			await this.callJson(
				A2A_METHODS.deletePushConfig,
				rest,
				this.withTenant({ taskId, id }),
				deleteResultSchema,
				signal
			);
			return;
		}
		const response = await this.restSend(
			rest,
			A2A_MEDIA_TYPE,
			this.http.timeoutSignal(signal)
		);
		await ensureSuccess(response, this.http.limits.maxResponseBytes);
	}

	/** Expose this remote agent as a tool of an SDK `Agent`. */
	asTool(options: A2AToolOptions = {}): AgentToolRunnable {
		return a2aAgentTool(this, options);
	}

	/** `GetExtendedAgentCard` (requires authentication on most peers). */
	getExtendedAgentCard(signal?: AbortSignal): Promise<A2AAgentCard> {
		return this.callJson(
			A2A_METHODS.getExtendedAgentCard,
			{ method: "GET", segments: ["extendedAgentCard"] },
			this.withTenant({}),
			a2aAgentCardSchema,
			signal
		);
	}

	private sendRequest(params: A2ASendMessageParams | string) {
		const input = sendParamsSchema.parse(params);
		return this.withTenant({
			message: buildA2AMessage(input.message),
			configuration: input.configuration,
			metadata: input.metadata,
		});
	}

	/** Name the endpoint's tenant on a request when the card declared one. */
	private withTenant<T>(request: T): T & RpcRequest {
		// An undefined tenant is dropped when the request is JSON-encoded.
		return { ...request, tenant: this.endpoint.tenant };
	}

	private async authHeaders(signal?: AbortSignal): Promise<Headers> {
		const headers = new Headers();
		if (this.extensions.length > 0) {
			headers.set("A2A-Extensions", this.extensions.join(","));
		}
		const credential = this.credential;
		switch (credential.kind) {
			case "none":
				return headers;
			case "bearer":
				setHeader(headers, "authorization", `Bearer ${credential.token}`);
				return headers;
			case "api_key": {
				const name = credential.header.trim();
				if (
					!HEADER_NAME_PATTERN.test(name) ||
					FORBIDDEN_API_KEY_HEADERS.has(name.toLowerCase())
				) {
					throw new A2AError(
						"invalid_credential",
						"A2A authentication configuration is invalid"
					);
				}
				setHeader(headers, name, credential.value);
				return headers;
			}
			case "basic":
				setHeader(
					headers,
					"authorization",
					basicAuthorization(credential.username, credential.password)
				);
				return headers;
			case "oauth2_client_credentials": {
				const token = await this.oauthToken(credential, signal);
				setHeader(headers, "authorization", `Bearer ${token}`);
				return headers;
			}
			default:
				return headers;
		}
	}

	private async oauthToken(
		credential: Extract<A2ACredential, { kind: "oauth2_client_credentials" }>,
		signal?: AbortSignal
	): Promise<string> {
		const tokenUrl = validateEndpoint(credential.tokenUrl, this.http.policy);
		const form = new URLSearchParams({ grant_type: "client_credentials" });
		if (credential.scopes && credential.scopes.length > 0) {
			form.set("scope", credential.scopes.join(" "));
		}
		const headers = new Headers({
			authorization: basicAuthorization(
				credential.clientId,
				credential.clientSecret
			),
			"content-type": "application/x-www-form-urlencoded",
			accept: "application/json",
		});
		const response = await this.http.fetchOnce(tokenUrl, {
			method: "POST",
			headers,
			body: form.toString(),
			signal: this.http.timeoutSignal(signal),
		});
		const token = parseWith(
			oauthTokenSchema,
			parseJsonBytes(
				await ensureSuccess(response, this.http.limits.maxResponseBytes)
			)
		);
		const type = token.token_type?.toLowerCase();
		if (token.access_token === "" || (type && type !== "bearer")) {
			throw new A2AError(
				"invalid_credential",
				"A2A authentication configuration is invalid"
			);
		}
		return token.access_token;
	}

	/** Send an HTTP+JSON binding call. */
	private async restSend(
		rest: RestCall,
		accept: string,
		signal: AbortSignal | undefined
	): Promise<Response> {
		return this.http.send(rest.method, restUrl(this.endpoint.url, rest), {
			accept,
			body: rest.body,
			headers: await this.authHeaders(signal),
			signal,
		});
	}

	/** Send a JSON-RPC binding call with a fresh request id. */
	private async rpcSend(
		rpcMethod: string,
		request: RpcRequest,
		accept: string,
		signal: AbortSignal | undefined
	): Promise<{ id: string; response: Response }> {
		const id = crypto.randomUUID();
		const response = await this.http.send("POST", this.endpoint.url, {
			accept,
			body: JSON.stringify({
				jsonrpc: "2.0",
				id,
				method: rpcMethod,
				params: request,
			}),
			headers: await this.authHeaders(signal),
			signal,
		});
		return { id, response };
	}

	private async callJson<T>(
		rpcMethod: string,
		rest: RestCall,
		request: RpcRequest,
		schema: z.ZodType<T>,
		signal?: AbortSignal
	): Promise<T> {
		const timed = this.http.timeoutSignal(signal);
		const maxBytes = this.http.limits.maxResponseBytes;
		if (this.endpoint.binding === A2A_BINDING_JSONRPC) {
			const { id, response } = await this.rpcSend(
				rpcMethod,
				request,
				A2A_MEDIA_TYPE,
				timed
			);
			const envelope = parseWith(
				jsonRpcResponseSchema,
				parseJsonBytes(await ensureSuccess(response, maxBytes))
			);
			if (envelope.jsonrpc !== "2.0" || envelope.id !== id) {
				throw new A2AError(
					"invalid_protocol",
					"A2A protocol response is invalid: JSON-RPC version or response ID mismatch"
				);
			}
			if (envelope.error) {
				throw new A2AError(
					"json_rpc",
					`A2A JSON-RPC error ${envelope.error.code}: ${truncateDetail(envelope.error.message)}`,
					{ rpcCode: envelope.error.code }
				);
			}
			if (envelope.result === undefined) {
				throw new A2AError(
					"invalid_protocol",
					"A2A protocol response is invalid: JSON-RPC result is missing"
				);
			}
			return parseWith(schema, primitiveJsonSchema.parse(envelope.result));
		}
		const response = await this.restSend(rest, A2A_MEDIA_TYPE, timed);
		return parseWith(
			schema,
			parseJsonBytes(await ensureSuccess(response, maxBytes))
		);
	}

	private async *callStream(
		rpcMethod: string,
		rest: RestCall,
		request: RpcRequest,
		signal?: AbortSignal
	): AsyncGenerator<A2AStreamResponse> {
		const jsonRpc = this.endpoint.binding === A2A_BINDING_JSONRPC;
		const response = jsonRpc
			? (await this.rpcSend(rpcMethod, request, SSE_MEDIA_TYPE, signal))
					.response
			: await this.restSend(rest, SSE_MEDIA_TYPE, signal);
		if (!response.ok) {
			throw await httpError(response, this.http.limits.maxResponseBytes);
		}
		const contentType = response.headers.get("content-type") ?? "";
		if (!contentType.toLowerCase().startsWith(SSE_MEDIA_TYPE)) {
			await response.body?.cancel().catch(() => undefined);
			throw new A2AError(
				"invalid_content_type",
				"A2A peer returned an unsupported content type"
			);
		}
		if (!response.body) {
			return;
		}
		const decoder = new SseDecoder(this.http.limits.maxSseEventBytes);
		const reader = response.body.getReader();
		try {
			for (;;) {
				let chunk: Awaited<ReturnType<typeof reader.read>>;
				try {
					chunk = await reader.read();
				} catch (error) {
					if (signal?.aborted) {
						throw error;
					}
					throw new A2AError("transport", "A2A request failed");
				}
				const events = chunk.done
					? decoder.finish()
					: decoder.push(chunk.value);
				for (const data of events) {
					yield parseStreamEvent(data, jsonRpc);
				}
				if (chunk.done) {
					return;
				}
			}
		} finally {
			await reader.cancel().catch(() => undefined);
		}
	}
}

function parseStreamEvent(data: string, jsonRpc: boolean): A2AStreamResponse {
	const bytes = new TextEncoder().encode(data);
	const value = parseJsonBytes(bytes);
	if (!jsonRpc) {
		return parseWith(a2aStreamResponseSchema, value);
	}
	const envelope = parseWith(jsonRpcResponseSchema, value);
	if (envelope.jsonrpc !== "2.0") {
		throw new A2AError(
			"invalid_protocol",
			"A2A protocol response is invalid: invalid JSON-RPC version in stream"
		);
	}
	if (envelope.error) {
		throw new A2AError(
			"json_rpc",
			`A2A JSON-RPC error ${envelope.error.code}: ${truncateDetail(envelope.error.message)}`,
			{ rpcCode: envelope.error.code }
		);
	}
	if (envelope.result === undefined) {
		throw new A2AError(
			"invalid_protocol",
			"A2A protocol response is invalid: JSON-RPC stream result is missing"
		);
	}
	return parseWith(
		a2aStreamResponseSchema,
		primitiveJsonSchema.parse(envelope.result)
	);
}
