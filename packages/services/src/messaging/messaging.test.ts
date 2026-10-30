import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MessagingError } from "@ryuhq/client";
import {
	isRyuError,
	RyuAuthenticationError,
	RyuConfigurationError,
	type RyuError,
	RyuPaymentRequiredError,
	RyuPermissionError,
	RyuRateLimitError,
	RyuRedirectError,
	RyuServerError,
	toRyuError,
} from "../errors.ts";
import { Ryu } from "../ryu.ts";
import {
	MESSAGING_CANONICAL_METHODS,
	MESSAGING_DOCS,
	messagingErrorRecord,
} from "./namespace.ts";
import { MESSAGING_ROUTES } from "./routes.ts";

// Error bodies are built exactly as #777's `messagingErrorResponse`
// (packages/api/src/lib/messaging-auth.ts) renders them:
// `{ ...details, error: code, message }`, plus `retry-after` and
// `cache-control: no-store`. The source test at the bottom pins that shape.

const ORG = "64a0000000000000000000a1";
const BASE = `https://api.ryuhq.com/api/messaging/orgs/${ORG}`;
const ENV = { RYU_API_KEY: "ryu_messaging_secret", RYU_ORGANIZATION_ID: ORG };
const NOW = "2026-10-21T12:00:00.000Z";
const ROUTER = resolve(
	import.meta.dir,
	"../../../api/src/routers/messaging.ts"
);
const AUTH = resolve(import.meta.dir, "../../../api/src/lib/messaging-auth.ts");

const MESSAGE = {
	id: "msg_1",
	organizationId: ORG,
	channel: "sms",
	direction: "outbound",
	status: "accepted",
	from: "+15555550100",
	to: "+6591234567",
	isoCountryCode: "SG",
	numberId: "num_1",
	whatsappSenderId: null,
	body: "Shipped",
	bodyType: "text",
	encoding: "GSM",
	segments: 1,
	template: null,
	hasMedia: false,
	providerMessageId: "aws-1",
	providerStatus: null,
	providerStatusDescription: null,
	heldMicroUsd: 9000,
	priceMicroUsd: null,
	chargedMicroUsd: 0,
	absorbedMicroUsd: 0,
	chargeState: "held",
	estimated: false,
	ttlSeconds: null,
	metadata: {},
	error: null,
	createdAt: NOW,
	updatedAt: NOW,
};

interface Recorded {
	body: string | null;
	headers: Headers;
	method: string;
	url: string;
}

function stubFetch(respond: (request: Recorded, index: number) => Response) {
	const calls: Recorded[] = [];
	const fetch = async (
		input: RequestInfo | URL,
		init?: RequestInit
	): Promise<Response> => {
		const request = new Request(input, init);
		const recorded: Recorded = {
			body: request.body === null ? null : await request.text(),
			headers: request.headers,
			method: request.method,
			url: request.url,
		};
		calls.push(recorded);
		return respond(recorded, calls.length - 1);
	};
	return { calls, fetch };
}

/** A refusal exactly as `messagingErrorResponse` renders a MessagingHttpError. */
function refusal(
	status: number,
	code: string,
	message: string,
	options: {
		details?: Record<string, unknown>;
		headers?: Record<string, string>;
		retryAfterSeconds?: number;
	} = {}
): Response {
	const headers = new Headers({
		"cache-control": "no-store",
		"x-request-id": `req_${code}`,
		...options.headers,
	});
	if (options.retryAfterSeconds !== undefined) {
		headers.set("retry-after", String(options.retryAfterSeconds));
	}
	return Response.json(
		{ ...options.details, error: code, message },
		{ headers, status }
	);
}

function ryuWith(fetch: ReturnType<typeof stubFetch>["fetch"]) {
	return new Ryu({ env: ENV, fetch });
}

function ryuObject(fetch: ReturnType<typeof stubFetch>["fetch"]) {
	return new Ryu({ env: ENV, fetch, result: "object" });
}

async function caught(promise: Promise<unknown>): Promise<RyuError> {
	try {
		await promise;
	} catch (error) {
		if (isRyuError(error)) {
			return error;
		}
		throw error;
	}
	throw new Error("expected the call to fail");
}

const SMS = { from: "num_1", to: "+6591234567", body: "Shipped" };
const STATUS = {
	apiVersion: "2026-10-01",
	configured: true,
	channels: { mms: true, sms: true, voice: true, whatsapp: false },
};

describe("ryu.messaging configuration", () => {
	test("needs RYU_API_KEY and RYU_ORGANIZATION_ID, and names both", async () => {
		const { calls, fetch } = stubFetch(() => Response.json({}));
		const ryu = new Ryu({ env: {}, fetch });
		const error = await caught(ryu.messaging.sms.send(SMS));
		expect(error).toBeInstanceOf(RyuConfigurationError);
		expect(error.details).toEqual({
			missing: ["RYU_API_KEY", "RYU_ORGANIZATION_ID"],
		});
		expect(error.hint).toContain("apiKey and organizationId");
		const keyOnly = new Ryu({ env: { RYU_API_KEY: "ryu_k" }, fetch });
		expect(
			(await caught(keyOnly.messaging.settings.get())).details as unknown
		).toEqual({ missing: ["RYU_ORGANIZATION_ID"] });
		expect(calls).toHaveLength(0);
	});

	test("status() needs no credentials and sends none without the full pair", async () => {
		const { calls, fetch } = stubFetch(() => Response.json(STATUS));
		const anonymous = new Ryu({ env: {}, fetch });
		const status = await anonymous.messaging.status();
		expect(status.configured).toBe(true);
		expect(calls[0]?.method).toBe("GET");
		expect(calls[0]?.url).toBe("https://api.ryuhq.com/api/messaging/status");
		expect(calls[0]?.headers.has("x-api-key")).toBe(false);
		expect(calls[0]?.headers.has("authorization")).toBe(false);
		expect(calls[0]?.headers.has("x-ryu-organization")).toBe(false);
		// A key without an organization is still incomplete: status() sends neither.
		const keyOnly = new Ryu({ env: { RYU_API_KEY: "ryu_k" }, fetch });
		await keyOnly.messaging.status();
		expect(calls[1]?.headers.has("x-api-key")).toBe(false);
		// RYU_API_URL still applies.
		await new Ryu({
			env: { RYU_API_URL: "https://cp.example.com" },
			fetch,
		}).messaging.status();
		expect(calls[2]?.url).toBe("https://cp.example.com/api/messaging/status");
		// Configured clients keep sending their credentials, as before.
		await ryuWith(fetch).messaging.status();
		expect(calls[3]?.headers.get("x-api-key")).toBe(ENV.RYU_API_KEY);
		expect(calls[3]?.headers.get("x-ryu-organization")).toBe(ORG);
		// Object mode and the safe view take the same path.
		const safe = await anonymous.safe.messaging.status();
		expect(safe.error).toBeNull();
	});

	test("credential-free status() does not weaken any other method", async () => {
		const { calls, fetch } = stubFetch(() => Response.json(STATUS));
		const ryu = new Ryu({ env: {}, fetch });
		await ryu.messaging.status();
		for (const call of [
			() => ryu.messaging.settings.get(),
			() => ryu.messaging.quote({ channel: "sms", to: "+6591234567" } as never),
			() => ryu.messaging.sms.send(SMS),
			() => ryu.messaging.messages.list(),
		]) {
			const error = await caught(call());
			expect(error).toBeInstanceOf(RyuConfigurationError);
			expect(error.details).toEqual({
				missing: ["RYU_API_KEY", "RYU_ORGANIZATION_ID"],
			});
		}
		expect(calls).toHaveLength(1);
		expect(ryu.isConfigured("messaging")).toBe(false);
		// An invalid URL is still a configuration error, also for status().
		const badUrl = new Ryu({ env: { RYU_API_URL: "not a url" }, fetch });
		expect(await caught(badUrl.messaging.status())).toBeInstanceOf(
			RyuConfigurationError
		);
		expect(calls).toHaveLength(1);
	});

	test("messaging options win over the shared control-plane options and env", async () => {
		const { calls, fetch } = stubFetch(() =>
			Response.json({ settings: SETTINGS })
		);
		const ryu = new Ryu({
			env: ENV,
			fetch,
			apiKey: "ryu_shared",
			messaging: {
				apiKey: "ryu_messaging_only",
				baseUrl: "https://cp.example.com",
				organizationId: "64a0000000000000000000b2",
			},
		});
		await ryu.messaging.settings.get();
		expect(calls[0]?.url).toBe(
			"https://cp.example.com/api/messaging/orgs/64a0000000000000000000b2/settings"
		);
		expect(calls[0]?.headers.get("x-api-key")).toBe("ryu_messaging_only");
		expect(calls[0]?.headers.get("x-ryu-organization")).toBe(
			"64a0000000000000000000b2"
		);
		expect(ryu.isConfigured("messaging")).toBe(true);
		expect(
			new Ryu({ env: { RYU_API_KEY: "k" } }).isConfigured("messaging")
		).toBe(false);
		// The same ryu_ key alone selects hosted Mail on the control plane.
		expect(new Ryu({ env: { RYU_API_KEY: "k" } }).isConfigured("mail")).toBe(
			true
		);
		expect(new Ryu({ env: {} }).isConfigured("mail")).toBe(false);
	});
});

const SETTINGS = {
	organizationId: ORG,
	webhookUrl: null,
	webhookSecretSet: false,
	allowedCountries: [],
	dailySendLimit: null,
	defaultDailySendLimit: 1000,
};

describe("ryu.messaging sends", () => {
	test("sms.send posts to the org route with x-api-key, the organization and an auto key", async () => {
		const { calls, fetch } = stubFetch(() =>
			Response.json({ message: MESSAGE }, { status: 202 })
		);
		const message = await ryuWith(fetch).messaging.sms.send(SMS);
		expect(message.id).toBe("msg_1");
		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call?.method).toBe("POST");
		expect(call?.url).toBe(`${BASE}/sms`);
		expect(call?.headers.get("x-api-key")).toBe("ryu_messaging_secret");
		expect(call?.headers.get("authorization")).toBeNull();
		expect(call?.headers.get("x-ryu-organization")).toBe(ORG);
		expect(call?.headers.get("idempotency-key")).toMatch(/\S{8,}/);
		expect(JSON.parse(call?.body ?? "{}")).toEqual(SMS);
	});

	test("the key is stable across a retry", async () => {
		const { calls, fetch } = stubFetch((_request, index) =>
			index === 0
				? refusal(500, "internal_error", "Internal Server Error", {
						retryAfterSeconds: 0,
					})
				: Response.json({ message: MESSAGE }, { status: 202 })
		);
		const result = await ryuObject(fetch).messaging.sms.send(SMS);
		expect(result.error).toBeNull();
		expect(calls).toHaveLength(2);
		const first = calls[0]?.headers.get("idempotency-key");
		expect(first).toBeTruthy();
		expect(calls[1]?.headers.get("idempotency-key")).toBe(first ?? "");
		expect(result.meta?.attempts).toBe(2);
		expect(result.meta?.idempotencyKey).toBe(first ?? "");
	});

	test("the client's own key option and .with({ idempotencyKey }) are both sent", async () => {
		const { calls, fetch } = stubFetch(() =>
			Response.json({ message: MESSAGE }, { status: 202 })
		);
		const ryu = ryuWith(fetch);
		await ryu.messaging.sms.send(SMS, { idempotencyKey: "order-1842-shipped" });
		await ryu.messaging
			.with({ idempotencyKey: "order-1843-shipped" })
			.voice.send({ from: "num_1", to: "+6591234567", text: "Hi" });
		expect(calls.map((call) => call.headers.get("idempotency-key"))).toEqual([
			"order-1842-shipped",
			"order-1843-shipped",
		]);
		expect(calls[1]?.url).toBe(`${BASE}/voice`);
	});

	test("numbers.buy carries a key; reads and label updates carry none", async () => {
		const NUMBER = {
			id: "num_1",
			organizationId: ORG,
			phoneNumber: null,
			isoCountryCode: "US",
			numberType: "TOLL_FREE",
			capabilities: ["SMS"],
			messageType: "TRANSACTIONAL",
			status: "pending",
			label: null,
			twoWayEnabled: false,
			registrationId: null,
			monthlyLeaseMicroUsd: 2_000_000,
			leasePeriod: 1,
			currentPeriodEndsAt: null,
			suspendedAt: null,
			graceEndsAt: null,
			releasedAt: null,
			error: null,
			createdAt: NOW,
			updatedAt: NOW,
		};
		const { calls, fetch } = stubFetch((request) =>
			request.method === "GET"
				? Response.json({ numbers: [NUMBER] })
				: Response.json({ number: NUMBER }, { status: 201 })
		);
		const ryu = ryuWith(fetch);
		await ryu.messaging.numbers.buy({
			capabilities: ["SMS"],
			isoCountryCode: "US",
			numberType: "TOLL_FREE",
		});
		await ryu.messaging.numbers.list({ status: "all" });
		await ryu.messaging.numbers.update("num_1", { label: "Support" });
		expect(calls.map((call) => [call.method, call.url])).toEqual([
			["POST", `${BASE}/numbers`],
			["GET", `${BASE}/numbers?status=all`],
			["PATCH", `${BASE}/numbers/num_1`],
		]);
		expect(calls[0]?.headers.get("idempotency-key")).toBeTruthy();
		expect(calls[1]?.headers.get("idempotency-key")).toBeNull();
		expect(calls[2]?.headers.get("idempotency-key")).toBeNull();
	});
});

describe("MessagingError becomes RyuError", () => {
	test("402 insufficient_credits keeps code, details, request id and the client error as cause", async () => {
		const { calls, fetch } = stubFetch(() =>
			refusal(
				402,
				"insufficient_credits",
				"This organization's available credit does not cover this charge. Add credits and retry.",
				{ details: { availableMicroUsd: 1200, requiredMicroUsd: 8400 } }
			)
		);
		const error = await caught(ryuWith(fetch).messaging.sms.send(SMS));
		expect(error).toBeInstanceOf(RyuPaymentRequiredError);
		expect(error.service).toBe("messaging");
		expect(error.code).toBe("insufficient_credits");
		expect(error.envelope).toBe("messaging");
		expect(error.details).toEqual({
			availableMicroUsd: 1200,
			requiredMicroUsd: 8400,
		});
		expect(error.requestId).toBe("req_insufficient_credits");
		expect(error.retryable).toBe(false);
		expect(error.cause).toBeInstanceOf(MessagingError);
		expect(error.method).toBe("POST");
		expect(error.url).toBe(`${BASE}/sms`);
		expect(error.idempotencyKey).toBe(
			calls[0]?.headers.get("idempotency-key") ?? ""
		);
		expect(calls).toHaveLength(1);
	});

	test("502 outcome_unknown is never retried and carries the stored message", async () => {
		const { calls, fetch } = stubFetch(() =>
			refusal(
				502,
				"outcome_unknown",
				"AWS End User Messaging did not confirm this send, so it may have been sent; check this message before sending it again",
				{ details: { messageRecord: { ...MESSAGE, status: "unresolved" } } }
			)
		);
		const error = await caught(ryuWith(fetch).messaging.sms.send(SMS));
		expect(calls).toHaveLength(1);
		expect(error).toBeInstanceOf(RyuServerError);
		expect(error.code).toBe("outcome_unknown");
		expect(error.retryable).toBe(false);
		expect(error.attempts).toBe(1);
		expect(messagingErrorRecord(error)?.status).toBe("unresolved");
		expect(messagingErrorRecord(new Error("x"))).toBeNull();
	});

	test("502 provider_refused is sent once, is not retryable, and keeps the first record", async () => {
		// The server releases the key's claim on a refusal, so a same-key retry
		// would run a whole new send (another row, another send-rate unit).
		const { calls, fetch } = stubFetch((_request, index) =>
			refusal(
				502,
				"provider_refused",
				"AWS End User Messaging refused this send; nothing was charged",
				{
					details: {
						messageRecord: {
							...MESSAGE,
							id: `msg_${index}`,
							status: "refused",
						},
					},
				}
			)
		);
		const error = await caught(
			ryuWith(fetch).messaging.sms.send(SMS, { idempotencyKey: "k1" })
		);
		expect(calls).toHaveLength(1);
		expect(error).toBeInstanceOf(RyuServerError);
		expect(error.code).toBe("provider_refused");
		expect(error.retryable).toBe(false);
		expect(error.attempts).toBe(1);
		expect(messagingErrorRecord(error)?.id).toBe("msg_0");
		expect(messagingErrorRecord(error)?.status).toBe("refused");
	});

	test("502 media_upload_failed is retried with the same key as a fresh attempt", async () => {
		const { calls, fetch } = stubFetch((_request, index) =>
			index === 0
				? refusal(
						502,
						"media_upload_failed",
						"the media could not be staged for sending; nothing was sent or charged"
					)
				: Response.json({ message: MESSAGE }, { status: 202 })
		);
		const ryu = new Ryu({ env: ENV, fetch, maxRetries: 1 });
		const message = await ryu.messaging.mms.send(
			{
				from: "num_1",
				to: "+6591234567",
				media: { base64: "AAAA", contentType: "image/png" },
			},
			{ idempotencyKey: "k2" }
		);
		expect(message.id).toBe("msg_1");
		expect(calls.map((call) => call.headers.get("idempotency-key"))).toEqual([
			"k2",
			"k2",
		]);
	});

	test("settings.update (PUT) is never replayed after a 5xx, so a created secret is not lost", async () => {
		// The first PUT may have created the secret before its reply was lost (a
		// 502 from a proxy). A replay would answer without the secret, so the
		// route table lists the PUT as non-replay-safe and the error surfaces.
		const { calls, fetch } = stubFetch(() =>
			refusal(502, "bad_gateway", "Bad Gateway", { retryAfterSeconds: 0 })
		);
		const ryu = new Ryu({ env: ENV, fetch, maxRetries: 2 });
		const error = await caught(
			ryu.messaging.settings.update({
				webhookUrl: "https://example.com/hooks/messaging",
			})
		);
		expect(error).toBeInstanceOf(RyuServerError);
		expect(calls.map((call) => call.method)).toEqual(["PUT"]);
		expect(calls[0]?.headers.get("idempotency-key")).toBeNull();
	});

	test("settings.update (PUT) is not replayed after a network error either", async () => {
		const { calls, fetch } = stubFetch(() => {
			throw new TypeError("fetch failed");
		});
		const ryu = new Ryu({
			env: ENV,
			fetch,
			maxRetries: 2,
			maxRetryDelayMs: 5000,
		});
		const error = await caught(
			ryu.messaging.settings.update({
				webhookUrl: "https://example.com/hooks/messaging",
			})
		);
		expect(error.code).toBe("connection_error");
		expect(calls).toHaveLength(1);
	});

	test("settings.update (PUT) is still retried on a 429 that names a wait", async () => {
		const { calls, fetch } = stubFetch((_request, index) =>
			index === 0
				? refusal(429, "rate_limited", "Slow down", { retryAfterSeconds: 0 })
				: Response.json({
						settings: {
							...SETTINGS,
							webhookUrl: "https://example.com/hooks/messaging",
							webhookSecretSet: true,
						},
						webhookSecret: "whsec_once",
					})
		);
		const ryu = new Ryu({ env: ENV, fetch, maxRetries: 1 });
		const reply = await ryu.messaging.settings.update({
			webhookUrl: "https://example.com/hooks/messaging",
		});
		expect(calls.map((call) => call.method)).toEqual(["PUT", "PUT"]);
		expect(reply.webhookSecret).toBe("whsec_once");
	});

	test("settings.get (GET) on the same path is still retried", async () => {
		const { calls, fetch } = stubFetch((_request, index) =>
			index === 0
				? refusal(502, "bad_gateway", "Bad Gateway")
				: Response.json({ settings: SETTINGS })
		);
		const ryu = new Ryu({
			env: ENV,
			fetch,
			maxRetries: 1,
			maxRetryDelayMs: 5000,
		});
		await ryu.messaging.settings.get();
		expect(calls.map((call) => call.method)).toEqual(["GET", "GET"]);
	});

	test("the non-replay-safe list names the settings PUT the router serves", () => {
		expect(
			MESSAGING_ROUTES.nonReplaySafe?.map((r) => `${r.method} ${r.path}`)
		).toEqual(["PUT /orgs/{orgId}/settings"]);
		const router = readFileSync(ROUTER, "utf8");
		expect(router).toMatch(
			/messagingRouter\.put\(\s*"\/orgs\/:orgId\/settings"/u
		);
	});

	test("optOuts.remove (DELETE) is retried on a 502", async () => {
		const { calls, fetch } = stubFetch((_request, index) =>
			index === 0
				? refusal(
						502,
						"provider_error",
						"AWS End User Messaging did not answer; retry later"
					)
				: Response.json({ deleted: true })
		);
		const ryu = new Ryu({ env: ENV, fetch, maxRetries: 1 });
		await ryu.messaging.optOuts.remove("+15555550101");
		expect(calls.map((call) => call.method)).toEqual(["DELETE", "DELETE"]);
		expect(calls[1]?.url).toBe(`${BASE}/opt-outs/%2B15555550101`);
	});

	test("409 outcome_unknown on a replayed key is not retried either", async () => {
		const { calls, fetch } = stubFetch(() =>
			refusal(409, "outcome_unknown", "the first request's outcome is unknown")
		);
		const error = await caught(
			ryuWith(fetch).messaging.mms.send({
				from: "num_1",
				to: "+6591234567",
				media: { base64: "AAAA", contentType: "image/png" },
			})
		);
		expect(error.code).toBe("outcome_unknown");
		expect(calls).toHaveLength(1);
	});

	test("a 429 puts limit and window in details and surfaces a wait longer than maxRetryDelayMs", async () => {
		const { calls, fetch } = stubFetch(() =>
			refusal(
				429,
				"send_rate_limited",
				"this organization reached its 1000 sends per hour limit",
				{ details: { limit: 1000, window: "hour" }, retryAfterSeconds: 1800 }
			)
		);
		const error = await caught(ryuWith(fetch).messaging.sms.send(SMS));
		expect(calls).toHaveLength(1);
		expect(error).toBeInstanceOf(RyuRateLimitError);
		expect(error.code).toBe("send_rate_limited");
		expect(error.details).toEqual({ limit: 1000, window: "hour" });
		expect(error.retryAfterSeconds).toBe(1800);
	});

	test("a short 429 wait is retried with the same key", async () => {
		const { calls, fetch } = stubFetch((_request, index) =>
			index === 0
				? refusal(429, "send_rate_limited", "per minute", {
						details: { limit: 60, window: "minute" },
						retryAfterSeconds: 0,
					})
				: Response.json({ message: MESSAGE }, { status: 202 })
		);
		await ryuWith(fetch).messaging.sms.send(SMS);
		expect(calls).toHaveLength(2);
		expect(calls[1]?.headers.get("idempotency-key")).toBe(
			calls[0]?.headers.get("idempotency-key") ?? ""
		);
	});

	test("403 feature_disabled and the 404 rollout gate get the early-access hint", async () => {
		const disabled = stubFetch(() =>
			refusal(
				403,
				"feature_disabled",
				"Ryu Messaging is disabled for this organization"
			)
		);
		const featureError = await caught(
			ryuWith(disabled.fetch).messaging.numbers.list()
		);
		expect(featureError).toBeInstanceOf(RyuPermissionError);
		expect(featureError.hint).toContain("Ryu Messaging feature is off");
		expect(featureError.docs).toBe(MESSAGING_DOCS);

		const gated = stubFetch(() =>
			refusal(
				404,
				"not_found",
				"Ryu Messaging is not available for this organization"
			)
		);
		const gateError = await caught(ryuWith(gated.fetch).messaging.status());
		expect(gateError.hint).toContain("early access");

		const missing = stubFetch(() =>
			refusal(404, "not_found", "message not found")
		);
		const missingError = await caught(
			ryuWith(missing.fetch).messaging.messages.get("nope")
		);
		expect(missingError.hint).toBeNull();
	});

	test("a 401 keeps WWW-Authenticate and names both credential env vars", async () => {
		const { fetch } = stubFetch(() =>
			refusal(401, "unauthenticated", "invalid API key", {
				headers: { "www-authenticate": 'Bearer realm="ryu"' },
			})
		);
		const error = await caught(ryuWith(fetch).messaging.settings.get());
		expect(error).toBeInstanceOf(RyuAuthenticationError);
		expect(error.authChallenge).toBe('Bearer realm="ryu"');
		expect(error.hint).toContain("RYU_API_KEY and RYU_ORGANIZATION_ID");
	});

	test("a reply without the {error, message} body maps by status", async () => {
		const { fetch } = stubFetch(
			() => new Response("upstream down", { status: 503 })
		);
		const error = await caught(ryuWith(fetch).messaging.settings.get());
		expect(error.code).toBe("service_unavailable");
		expect(error.envelope).toBe("text");
	});

	test("a redirect is refused and never followed", async () => {
		const { calls, fetch } = stubFetch(() =>
			Response.redirect("https://evil.example.com/steal?k=1", 302)
		);
		const error = await caught(ryuWith(fetch).messaging.settings.get());
		expect(error).toBeInstanceOf(RyuRedirectError);
		expect(error.code).toBe("redirect_refused");
		expect(calls).toHaveLength(1);
	});

	test("toRyuError converts a bare MessagingError", () => {
		const error = toRyuError(
			new MessagingError({
				code: "price_changed",
				details: { actualMicroUsd: 2_500_000 },
				message: "AWS quoted a higher monthly price",
				retryAfterSeconds: null,
				status: 409,
			}),
			"messaging"
		);
		expect(error.code).toBe("price_changed");
		expect(error.status).toBe(409);
		expect(error.details).toEqual({ actualMicroUsd: 2_500_000 });
	});

	test("object mode resolves to { data, error, meta }", async () => {
		const { fetch } = stubFetch(() =>
			refusal(422, "recipient_opted_out", "the recipient opted out")
		);
		const result = await ryuObject(fetch).messaging.sms.send(SMS);
		expect(result.data).toBeNull();
		expect(result.error?.code).toBe("recipient_opted_out");
		expect(result.meta?.status).toBe(422);
		expect(result.meta?.requestId).toBe("req_recipient_opted_out");
	});
});

describe("ryu.messaging iterators and reads", () => {
	test("messages.iterate sends nextCursor back as cursor and keeps the filters", async () => {
		const { calls, fetch } = stubFetch((request) => {
			const cursor = new URL(request.url).searchParams.get("cursor");
			return cursor === null
				? Response.json({
						messages: [MESSAGE, { ...MESSAGE, id: "msg_2" }],
						nextCursor: "c2",
					})
				: Response.json({
						messages: [{ ...MESSAGE, id: "msg_3" }],
						nextCursor: null,
					});
		});
		const ids: string[] = [];
		for await (const message of ryuWith(fetch).messaging.messages.iterate({
			channel: "sms",
			limit: 2,
		})) {
			ids.push(message.id);
		}
		expect(ids).toEqual(["msg_1", "msg_2", "msg_3"]);
		expect(calls.map((call) => call.url)).toEqual([
			`${BASE}/messages?channel=sms&limit=2`,
			`${BASE}/messages?channel=sms&cursor=c2&limit=2`,
		]);
	});

	test("optOuts.iterate pages by nextToken and stops at maxItems", async () => {
		const { calls, fetch } = stubFetch((request) => {
			const token = new URL(request.url).searchParams.get("nextToken");
			return Response.json({
				optOuts: [
					{
						phoneNumber: token === null ? "+15555550101" : "+15555550102",
						optedOutAt: NOW,
						endUserOptedOut: true,
					},
				],
				nextToken: token === null ? "t2" : null,
			});
		});
		const ryu = ryuWith(fetch);
		const all = await ryu.messaging.optOuts.iterate().collect();
		expect(all.map((entry) => entry.phoneNumber)).toEqual([
			"+15555550101",
			"+15555550102",
		]);
		expect(calls[1]?.url).toBe(`${BASE}/opt-outs?nextToken=t2`);
		const one = await ryu.messaging.optOuts.iterate({ maxItems: 1 }).collect();
		expect(one).toHaveLength(1);
	});

	test("optOuts.iterate follows nextToken past an empty page", async () => {
		const { calls, fetch } = stubFetch((request) => {
			const token = new URL(request.url).searchParams.get("nextToken");
			if (token === null) {
				return Response.json({ optOuts: [], nextToken: "t2" });
			}
			if (token === "t2") {
				return Response.json({
					optOuts: [
						{
							phoneNumber: "+15555550102",
							optedOutAt: NOW,
							endUserOptedOut: true,
						},
					],
					nextToken: "t3",
				});
			}
			return Response.json({ optOuts: [], nextToken: null });
		});
		const all = await ryuWith(fetch).messaging.optOuts.iterate().collect();
		expect(all.map((entry) => entry.phoneNumber)).toEqual(["+15555550102"]);
		expect(calls.map((call) => new URL(call.url).search)).toEqual([
			"",
			"?nextToken=t2",
			"?nextToken=t3",
		]);
	});

	test("optOuts.iterate stops on a repeated token even when pages are empty", async () => {
		const { calls, fetch } = stubFetch(() =>
			Response.json({ optOuts: [], nextToken: "same" })
		);
		const all = await ryuWith(fetch).messaging.optOuts.iterate().collect();
		expect(all).toEqual([]);
		expect(calls).toHaveLength(2);
	});

	test("an iterator page failure throws RyuError, also in object mode", async () => {
		const { fetch } = stubFetch(() =>
			refusal(400, "invalid_request", "invalid cursor")
		);
		const iterator = ryuObject(fetch)
			.messaging.messages.iterate()
			[Symbol.asyncIterator]();
		const error = await caught(iterator.next());
		expect(error.code).toBe("invalid_request");
	});

	test("status() and quote() call the service-level routes", async () => {
		const { calls, fetch } = stubFetch((request) =>
			request.url.endsWith("/status")
				? Response.json({
						apiVersion: "v1",
						configured: true,
						channels: { sms: true, mms: false, voice: true, whatsapp: false },
					})
				: Response.json({
						channel: "sms",
						credit: { availableMicroUsd: 5_000_000, heldMicroUsd: 0 },
						quote: {
							ceilingMicroUsd: 9000,
							encoding: "GSM",
							isoCountryCode: "SG",
							segments: 1,
						},
					})
		);
		const ryu = ryuWith(fetch);
		expect((await ryu.messaging.status()).apiVersion).toBe("v1");
		const quote = await ryu.messaging.quote({
			channel: "sms",
			to: "+6591234567",
			body: "Hi",
		});
		expect(quote.channel).toBe("sms");
		expect(calls.map((call) => call.url)).toEqual([
			"https://api.ryuhq.com/api/messaging/status",
			`${BASE}/quote?channel=sms&to=%2B6591234567&body=Hi`,
		]);
	});

	test("every canonical method resolves on the namespace", () => {
		const client = new Ryu({ env: ENV }).messaging as unknown as Record<
			string,
			unknown
		>;
		for (const path of MESSAGING_CANONICAL_METHODS) {
			let target: unknown = client;
			for (const key of path.split(".")) {
				target = (target as Record<string, unknown>)[key];
			}
			expect({ path, type: typeof target }).toEqual({
				path,
				type: "function",
			});
		}
	});
});

/** Each `messagingRouter.<method>("<path>", ...)` registration and its handler source. */
function routerRegistrations(): {
	body: string;
	method: string;
	path: string;
}[] {
	const source = readFileSync(ROUTER, "utf8");
	const pattern = /messagingRouter\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g;
	const matches = [...source.matchAll(pattern)];
	return matches.map((match) => {
		const start = match.index ?? 0;
		// The registration call ends at the first `)` or `})` at column 0.
		const end = source.slice(start).search(/\n\}?\);/);
		return {
			method: (match[1] ?? "").toUpperCase(),
			path: (match[2] ?? "").replaceAll(/:([A-Za-z]+)/g, "{$1}"),
			body: source.slice(start, end === -1 ? source.length : start + end),
		};
	});
}

describe("lockstep with #777's server", () => {
	test("the route table equals the routes that require an Idempotency-Key", () => {
		const required = routerRegistrations()
			.filter(
				({ body }) =>
					body.includes("requireIdempotencyKey(c)") || body.includes("runSend(")
			)
			.map(({ method, path }) => `${method} ${path}`)
			.sort();
		const table = MESSAGING_ROUTES.idempotent
			.map((route) => `${route.method} ${route.path}`)
			.sort();
		expect(required).toEqual(table);
		expect(MESSAGING_ROUTES.idempotent.every((route) => route.required)).toBe(
			true
		);
		// The mount the table is relative to (`/api` + `/messaging`).
		expect(readFileSync(resolve(ROUTER, "../index.ts"), "utf8")).toContain(
			'mountRouter("/messaging", messagingRouter)'
		);
		expect(MESSAGING_ROUTES.mount).toBe("/api/messaging");
	});

	test("refusals are rendered as { ...details, error, message } with retry-after", () => {
		const source = readFileSync(AUTH, "utf8");
		expect(source).toContain(
			"{ ...error.details, error: error.code, message: error.message }"
		);
		expect(source).toContain(
			'headers.set("retry-after", String(error.retryAfterSeconds))'
		);
	});

	test("outcome_unknown and the send caps are the codes these tests assume", () => {
		const source = readFileSync(ROUTER, "utf8");
		for (const code of [
			'"outcome_unknown"',
			'"provider_refused"',
			'"media_upload_failed"',
			'"send_rate_limited"',
			'"insufficient_credits"',
			"details: { limit: refusal.limit, window: refusal.window }",
		]) {
			expect({ code, found: source.includes(code) }).toEqual({
				code,
				found: true,
			});
		}
		expect(readFileSync(AUTH, "utf8")).toContain(
			'"Ryu Messaging is not available for this organization"'
		);
	});

	test("a refused or unstaged send releases the key's claim, so a retry is a new send", () => {
		const source = readFileSync(ROUTER, "utf8");
		const refused = source.indexOf(
			'"provider_refused",\n\t\t\t\t\t\t"AWS End User Messaging refused this send'
		);
		const staged = source.indexOf('"media_upload_failed"');
		expect(refused).toBeGreaterThan(0);
		expect(staged).toBeGreaterThan(0);
		for (const at of [refused, staged]) {
			const before = source.slice(Math.max(0, at - 400), at);
			expect(before).toContain("await claim.release();");
		}
	});
});
