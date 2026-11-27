// Reference Ryu auth bridge: a `kind: "node"` sidecar that serves a user's ChatGPT
// (Codex) subscription as an OpenAI-compatible endpoint.
//
// This is the template third parties copy to build a bridge for any provider. The
// provider-specific parts are isolated behind three seams, marked SEAM below:
//
//   1. loadCredential()  - where the credential comes from
//   2. refresh()         - how an expired credential is renewed
//   3. translate*()      - how OpenAI chat/completions maps to the upstream wire format
//
// Everything else (activation, routing, refresh-on-expiry scheduling) is provider
// agnostic and can be reused verbatim.
//
// Posture: this bridge RIDES a credential the user already minted via `codex login`.
// It does not perform its own authorize flow. See README.md ("Two postures").

import { Buffer } from "node:buffer";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Config (nothing hardcoded: every value is env-overridable) ────────────────

const env = process.env;

/** Where the vendor CLI stores the credential this bridge rides. */
const AUTH_PATH =
	env.RYU_BRIDGE_AUTH_PATH || join(homedir(), ".codex", "auth.json");

/** OAuth token endpoint used for the refresh_token grant. */
const TOKEN_URL =
	env.RYU_BRIDGE_TOKEN_URL || "https://auth.openai.com/oauth/token";

/** Public PKCE client id the refresh grant is issued against. */
const CLIENT_ID = env.RYU_BRIDGE_CLIENT_ID || "app_EMoamEEZ73f0CkXaXp7hrann";

/** Upstream that serves subscription traffic. */
const UPSTREAM =
	env.RYU_BRIDGE_UPSTREAM || "https://chatgpt.com/backend-api/codex";

/** Refresh this many seconds before actual expiry. */
const REFRESH_SKEW_SECS = Number(env.RYU_BRIDGE_REFRESH_SKEW_SECS || 300);

/** Models advertised on /v1/models. Discovery is per-provider; a static list is fine. */
const MODELS = (env.RYU_BRIDGE_MODELS || "gpt-5,gpt-5-codex")
	.split(",")
	.map((m) => m.trim())
	.filter(Boolean);

// Native field admission keeps this copyable sidecar dependency-free. Intrinsic
// valueOf accepts its primitive field without coercing foreign objects or running
// conversion hooks; boxed values are not JSON wire strings or numbers.
function parseWireText(value) {
	try {
		const text = String.prototype.valueOf.call(value);
		return value === text ? text : null;
	} catch {
		return null;
	}
}

function parseCredentialExpiry(value) {
	if (value == null) {
		return { kind: "absent" };
	}
	try {
		const seconds = Number.prototype.valueOf.call(value);
		if (Object.is(value, seconds)) {
			return { kind: "epoch", seconds };
		}
	} catch {
		// The vendor also persists ISO timestamps. Preserve its date parsing.
	}
	return { kind: "date", date: String(value) };
}

// This is the local completion projection, not a claim that every optional
// Responses output variant has the same shape. Keep provider shape drift and
// ignore non-text output chunks exactly as the forwarding contract requires.
function parseCompletionText(resp) {
	const directText = parseWireText(resp.output_text);
	if (directText !== null) {
		return directText;
	}
	const parts = [];
	for (const item of resp.output || []) {
		for (const chunk of item.content || []) {
			const text = parseWireText(chunk.text);
			if (text !== null) {
				parts.push(text);
			}
		}
	}
	return parts.join("");
}

function parseChatRequest(chat) {
	return {
		...chat,
		messages: (chat.messages || []).map((message) => ({
			role: message.role,
			text: parseWireText(message.content) ?? JSON.stringify(message.content),
		})),
	};
}

// ── Credential handling (SEAM 1 + 2) ─────────────────────────────────────────

/** In-memory copy so a burst of requests does not re-read/refresh concurrently. */
let cached = null;
/** Single-flight guard: concurrent requests await one refresh, not N. */
let inflightRefresh = null;

/**
 * SEAM 1. Load the credential this bridge serves.
 *
 * Riding the vendor CLI's auth.json is what makes this posture honest: the user
 * logged in with the vendor's own client, and the bridge reuses that result. A
 * bridge for a provider with its own login would replace this with an authorize
 * flow (see README).
 */
async function loadCredential() {
	const raw = await readFile(AUTH_PATH, "utf8");
	const parsed = JSON.parse(raw);
	const tokens = parsed.tokens || parsed;
	return {
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token,
		accountId: tokens.account_id || parsed.account_id || null,
		// auth.json stores an ISO timestamp on some versions and epoch secs on others.
		expiresAt: normalizeExpiry(
			parseCredentialExpiry(tokens.expires_at ?? tokens.expires)
		),
		raw: parsed,
	};
}

/** Accept ISO-8601, epoch seconds, or epoch millis. Returns epoch seconds, or 0. */
function normalizeExpiry(value) {
	if (value.kind === "absent") {
		return 0;
	}
	if (value.kind === "epoch") {
		// Heuristic: anything past year 33658 in seconds is really millis.
		return value.seconds > 1e12
			? Math.floor(value.seconds / 1000)
			: Math.floor(value.seconds);
	}
	const parsed = Date.parse(value.date);
	return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
}

function nowSecs() {
	return Math.floor(Date.now() / 1000);
}

/**
 * The `exp` claim (epoch seconds) of a JWT access token, or 0. Codex's
 * auth.json records no expiry field, so the token itself is the only source.
 */
function jwtExpiry(token) {
	const text = parseWireText(token);
	const payload = text?.split(".")[1];
	if (!payload) {
		return 0;
	}
	try {
		const claims = JSON.parse(
			Buffer.from(payload, "base64url").toString("utf8")
		);
		const exp = parseCredentialExpiry(claims?.exp);
		return exp.kind === "epoch" && Number.isFinite(exp.seconds)
			? normalizeExpiry(exp)
			: 0;
	} catch {
		return 0;
	}
}

/** Recorded expiry, else the access token's own `exp`, else 0 (unknown). */
function effectiveExpiry(cred) {
	return cred.expiresAt > 0 ? cred.expiresAt : jwtExpiry(cred.accessToken);
}

function isExpired(cred) {
	// No known expiry means we cannot reason about it; treat as live and let a
	// 401 from upstream drive the refresh instead of refreshing on every request.
	const expiresAt = effectiveExpiry(cred);
	return expiresAt > 0 && expiresAt - REFRESH_SKEW_SECS <= nowSecs();
}

/**
 * SEAM 2. Renew an expired credential via the standard refresh_token grant.
 *
 * A failed refresh deliberately does NOT clear the cached credential: the refresh
 * token may be single-use, and a transient network failure must degrade to "try
 * again next request" rather than to a logout.
 */
async function refresh(cred) {
	if (!cred.refreshToken) {
		throw new Error(
			"no refresh_token in credential; re-run the provider login"
		);
	}
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			grant_type: "refresh_token",
			refresh_token: cred.refreshToken,
			client_id: CLIENT_ID,
		}),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(
			`token refresh failed (${res.status}): ${text.slice(0, 200)}`
		);
	}
	const body = await res.json();
	const next = {
		...cred,
		accessToken: body.access_token || cred.accessToken,
		refreshToken: body.refresh_token || cred.refreshToken,
		expiresAt: body.expires_in ? nowSecs() + Number(body.expires_in) : 0,
	};
	await persist(next);
	return next;
}

/**
 * Write the refreshed credential back so the vendor CLI and this bridge stay in
 * sync. Best-effort: a read-only auth.json is not a reason to fail the request we
 * already have a valid token for.
 */
async function persist(cred) {
	try {
		const next = { ...cred.raw };
		const target = next.tokens ? next.tokens : next;
		target.access_token = cred.accessToken;
		target.refresh_token = cred.refreshToken;
		if (cred.expiresAt > 0) {
			target.expires_at = new Date(cred.expiresAt * 1000).toISOString();
		}
		await writeFile(AUTH_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
		cred.raw = next;
	} catch (err) {
		log(`warn: could not persist refreshed credential: ${err.message}`);
	}
}

/** Refresh the cached credential, sharing one in-flight refresh across callers. */
function refreshCached() {
	if (!inflightRefresh) {
		inflightRefresh = refresh(cached)
			.then((next) => {
				cached = next;
				return next;
			})
			.finally(() => {
				inflightRefresh = null;
			});
	}
	return inflightRefresh;
}

/** Current valid credential, refreshing at most once concurrently. */
async function credential() {
	if (!cached) {
		cached = await loadCredential();
	}
	if (!isExpired(cached)) {
		return cached;
	}
	return refreshCached();
}

/**
 * Upstream rejected `rejected` with a 401: refresh regardless of the recorded
 * expiry, unless a concurrent request already replaced that token.
 */
function credentialAfterRejection(rejected) {
	if (cached && cached.accessToken !== rejected.accessToken) {
		return cached;
	}
	return refreshCached();
}

// ── Wire translation (SEAM 3) ────────────────────────────────────────────────

// The Codex backend speaks OpenAI's *Responses* API, while Pi (and every
// OpenAI-compatible client) speaks chat/completions. A bridge for an upstream that
// is already chat/completions-shaped deletes this whole section and forwards as-is.

/** chat/completions request → Responses request. */
function translateRequest(chat, stream = false) {
	const input = (chat.messages || []).map((m) => ({
		role: m.role,
		content: [
			{
				type: m.role === "assistant" ? "output_text" : "input_text",
				text: m.text,
			},
		],
	}));
	const out = { model: chat.model, input, stream };
	if (chat.temperature != null) {
		out.temperature = chat.temperature;
	}
	if (chat.max_tokens != null) {
		out.max_output_tokens = chat.max_tokens;
	}
	return out;
}

/** Responses response → chat/completions response. */
function translateResponse(model, resp) {
	const text = resp.assistantText;
	const usage = resp.usage || {};
	return {
		id: resp.id || `chatcmpl-${Date.now()}`,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: text },
				finish_reason: resp.status === "incomplete" ? "length" : "stop",
			},
		],
		usage: {
			prompt_tokens: usage.input_tokens ?? 0,
			completion_tokens: usage.output_tokens ?? 0,
			total_tokens: usage.total_tokens ?? 0,
		},
	};
}

// ── Upstream call ────────────────────────────────────────────────────────────

function postResponses(cred, payload) {
	const headers = {
		authorization: `Bearer ${cred.accessToken}`,
		"content-type": "application/json",
	};
	if (cred.accountId) {
		headers["chatgpt-account-id"] = cred.accountId;
	}
	return fetch(`${UPSTREAM}/responses`, {
		method: "POST",
		headers,
		body: JSON.stringify(payload),
	});
}

/**
 * POST to the upstream with the current credential. A 401 means the token is
 * dead even if no expiry said so: refresh once and retry once.
 */
async function fetchUpstream(payload) {
	const cred = await credential();
	const res = await postResponses(cred, payload);
	if (res.status !== 401) {
		return res;
	}
	await res.body?.cancel().catch(() => undefined);
	return postResponses(await credentialAfterRejection(cred), payload);
}

async function callUpstream(payload) {
	const res = await fetchUpstream(payload);
	const text = await res.text();
	if (!res.ok) {
		throw new Error(`upstream ${res.status}: ${text.slice(0, 300)}`);
	}
	const response = JSON.parse(text);
	return { ...response, assistantText: parseCompletionText(response) };
}

/**
 * Forward Responses SSE events as OpenAI chat/completions chunks. The bootstrap
 * owns the actual socket writes; this generator only translates provider events
 * as they arrive.
 */
async function* streamUpstream(model, payload) {
	const res = await fetchUpstream(payload);
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`upstream ${res.status}: ${text.slice(0, 300)}`);
	}

	const decoder = new TextDecoder();
	let buffer = "";
	let responseId = `chatcmpl-${Date.now()}`;
	let sentDone = false;
	for await (const bytes of res.body ?? []) {
		buffer += decoder.decode(bytes, { stream: true });
		const frames = buffer.split(/\r?\n\r?\n/);
		buffer = frames.pop() ?? "";
		for (const frame of frames) {
			const data = frame
				.split(/\r?\n/)
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n");
			if (!data || data === "[DONE]") {
				continue;
			}
			const event = JSON.parse(data);
			responseId = event.response?.id || responseId;
			if (event.type === "response.output_text.delta") {
				yield `data: ${JSON.stringify({
					id: responseId,
					object: "chat.completion.chunk",
					created: Math.floor(Date.now() / 1000),
					model,
					choices: [
						{ index: 0, delta: { content: event.delta }, finish_reason: null },
					],
				})}\n\n`;
			}
			if (event.type === "response.completed") {
				const finishReason =
					event.response?.status === "incomplete" ? "length" : "stop";
				yield `data: ${JSON.stringify({
					id: responseId,
					object: "chat.completion.chunk",
					created: Math.floor(Date.now() / 1000),
					model,
					choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
				})}\n\n`;
				sentDone = true;
			}
		}
	}
	if (buffer.trim()) {
		const data = buffer
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n");
		if (data && data !== "[DONE]") {
			const event = JSON.parse(data);
			if (event.type === "response.completed") {
				sentDone = true;
			}
		}
	}
	if (sentDone) {
		yield "data: [DONE]\n\n";
	} else {
		yield "data: [DONE]\n\n";
	}
}

// ── Routes ───────────────────────────────────────────────────────────────────

function log(message) {
	process.stderr.write(`[auth-bridge] ${message}\n`);
}

function listModels() {
	return {
		object: "list",
		data: MODELS.map((id) => ({
			id,
			object: "model",
			created: 0,
			owned_by: "chatgpt-subscription",
		})),
	};
}

async function chatCompletions(body) {
	let chat;
	try {
		chat = JSON.parse(body || "{}");
	} catch {
		return { status: 400, json: { error: { message: "invalid JSON body" } } };
	}
	if (!Array.isArray(chat.messages) || chat.messages.length === 0) {
		return {
			status: 400,
			json: { error: { message: "messages is required" } },
		};
	}

	chat = parseChatRequest(chat);
	const model = chat.model || MODELS[0];
	if (chat.stream) {
		return {
			status: 200,
			headers: { "content-type": "text/event-stream" },
			stream: streamUpstream(model, translateRequest(chat, true)),
		};
	}

	const upstream = await callUpstream(translateRequest(chat));
	const completion = translateResponse(model, upstream);

	return { status: 200, json: completion };
}

async function status() {
	try {
		const cred = await credential();
		return {
			json: {
				ok: true,
				upstream: UPSTREAM,
				expires_at: effectiveExpiry(cred) || null,
				expired: isExpired(cred),
				has_account_id: Boolean(cred.accountId),
			},
		};
	} catch (err) {
		return { status: 503, json: { ok: false, error: err.message } };
	}
}

// ── Activation ───────────────────────────────────────────────────────────────

export async function activate(ctx) {
	// Fail fast at activation if the credential is unreadable: the health endpoint
	// only reports healthy once activate() resolves, so Core will not route traffic
	// to a bridge that cannot serve it.
	await loadCredential();
	log(`activated for ${ctx.manifest.id}, upstream ${UPSTREAM}`);

	ctx.http.onRequest(async (req) => {
		try {
			if (req.method === "GET" && req.path === "/v1/models") {
				return { json: listModels() };
			}
			if (req.method === "POST" && req.path === "/v1/chat/completions") {
				return await chatCompletions(req.body);
			}
			if (req.method === "GET" && req.path === "/status") {
				return await status();
			}
			return null; // → 404
		} catch (err) {
			log(`error: ${err.message}`);
			return { status: 502, json: { error: { message: err.message } } };
		}
	});
}
