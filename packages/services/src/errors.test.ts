import { describe, expect, test } from "bun:test";
import { ManagedAgentsError } from "@ryuhq/client";
import { z } from "zod";
import {
	BoxError,
	errorResponse as boxErrorResponse,
} from "../../../apps/box/src/errors.ts";
import {
	NotifyError,
	errorResponse as notifyErrorResponse,
} from "../../../apps/notify/src/errors.ts";
import { apiBearerChallenge } from "../../../apps/server/src/api-auth-challenge.ts";
import { problemResponse } from "../../../apps/server/src/problem-details.ts";
import type { RyuFetch } from "./config.ts";
import {
	copyRyuError,
	createRyuError,
	fromManagedAgentsError,
	isRyuError,
	knownServerHint,
	messageWithHint,
	messageWithoutHint,
	parseErrorResponse,
	RyuAbortError,
	RyuAuthenticationError,
	RyuConfigurationError,
	RyuConflictError,
	RyuError,
	RyuInvalidRequestError,
	RyuNotFoundError,
	RyuPaymentRequiredError,
	RyuQuotaExceededError,
	RyuRateLimitError,
	RyuRedirectError,
	RyuResponseValidationError,
	RyuServerError,
	type RyuService,
	RyuUnavailableError,
	toRyuError,
	withRyuErrorFields,
} from "./errors.ts";
import * as root from "./index.ts";
import { Ryu } from "./ryu.ts";

const URL_WITH_TOKEN = "https://svc.example.com/v1/things?token=secret#frag";

function json(
	body: unknown,
	status: number,
	headers: Record<string, string> = {}
): Response {
	return Response.json(body, { headers, status });
}

function parse(service: RyuService, response: Response, method = "GET") {
	return parseErrorResponse(service, response, method, URL_WITH_TOKEN, {
		attempts: 2,
		idempotencyKey: "key-123",
	});
}

describe("parseErrorResponse: one fixture per mapping-table row", () => {
	test("control-plane problem+json with WWW-Authenticate", async () => {
		const challenge = apiBearerChallenge("https://api.ryuhq.com");
		const response = problemResponse(
			{ status: 401, detail: "Bad key." },
			{ "WWW-Authenticate": challenge, "X-Request-ID": "req_cp" }
		);
		const error = await parse("managedAgents", response);
		expect(error).toBeInstanceOf(RyuAuthenticationError);
		expect(error.envelope).toBe("problem+json");
		expect(error.code).toBe("unauthenticated");
		expect(messageWithoutHint(error)).toBe("Bad key.");
		expect(error.requestId).toBe("req_cp");
		expect(error.authChallenge).toBe(challenge);
		expect(error.docs).toContain("#unauthenticated");
		expect(error.hint).toContain("Authorization");
	});

	test("Notify 429 rate_limited from the real error helper", async () => {
		const response = notifyErrorResponse(
			new NotifyError("rate_limited", "Slow down.", 429, undefined, 7),
			"req_notify"
		);
		const error = await parse("notify", response);
		expect(error).toBeInstanceOf(RyuRateLimitError);
		expect(error.envelope).toBe("ryu-service");
		expect(error.type).toBe("notify.error");
		expect(error.code).toBe("rate_limited");
		expect(error.message).toBe("Slow down.");
		expect(error.requestId).toBe("req_notify");
		expect(error.retryAfterSeconds).toBe(7);
		expect(error.retryable).toBe(true);
	});

	test("Notify 402 insufficient_credits is not retryable", async () => {
		const response = notifyErrorResponse(
			new NotifyError("insufficient_credits", "No credits.", 402),
			"req_n2"
		);
		const error = await parse("notify", response, "POST");
		expect(error).toBeInstanceOf(RyuPaymentRequiredError);
		expect(error.code).toBe("insufficient_credits");
		expect(error.retryable).toBe(false);
	});

	test("Notify sequence conflict keeps details", async () => {
		const response = notifyErrorResponse(
			new NotifyError("conflict", "Stale.", 409, {
				expectedSequence: 3,
				sequence: 2,
			}),
			"req_n3"
		);
		const error = await parse("notify", response, "PATCH");
		expect(error).toBeInstanceOf(RyuConflictError);
		expect(error.details).toEqual({ expectedSequence: 3, sequence: 2 });
	});

	test("Notify problem+json (negotiated) keeps code, request id, details and Retry-After", async () => {
		const response = notifyErrorResponse(
			new NotifyError("conflict", "Stale.", 409, {
				expectedSequence: 3,
				sequence: 2,
			}),
			"req_np",
			{ instance: "/v1/events/evt_1", problem: true }
		);
		expect(response.headers.get("content-type")).toContain("problem+json");
		const error = await parse("notify", response, "PATCH");
		expect(error).toBeInstanceOf(RyuConflictError);
		expect(error.envelope).toBe("problem+json");
		expect(error.code).toBe("conflict");
		expect(error.message).toBe("Stale.");
		expect(error.requestId).toBe("req_np");
		expect(error.details).toEqual({ expectedSequence: 3, sequence: 2 });
		expect(error.docs).toBe(
			"https://docs.ryuhq.com/docs/standalone/notify-api#conflict"
		);
		const limited = await parse(
			"notify",
			notifyErrorResponse(
				new NotifyError("rate_limited", "Slow down.", 429, undefined, 7),
				"req_np2",
				{ problem: true }
			)
		);
		expect(limited).toBeInstanceOf(RyuRateLimitError);
		expect(limited.retryAfterSeconds).toBe(7);
	});

	test("Box problem+json (negotiated) keeps details and hint", async () => {
		const response = boxErrorResponse(
			new BoxError("quota_exceeded", "Box quota reached.", 429, {
				resource: "boxes",
				limit: 1,
			}),
			"req_bp",
			{ problem: true }
		);
		const error = await parse("box", response, "POST");
		expect(error).toBeInstanceOf(RyuQuotaExceededError);
		expect(error.envelope).toBe("problem+json");
		expect(error.requestId).toBe("req_bp");
		expect(error.details).toEqual({ resource: "boxes", limit: 1 });
		expect(error.hint).toContain("capacity quota");
		expect(error.retryable).toBe(false);
	});

	test("a problem body with a nested error.fields list (Sites) keeps the fields", async () => {
		const response = new Response(
			JSON.stringify({
				type: "https://docs.ryuhq.com/docs/standalone/sites-api#revisions-and-errors",
				title: "Bad Request",
				status: 400,
				detail: "Invalid site.",
				requestId: "req_sites",
				error: {
					code: "invalid_request",
					message: "Invalid site.",
					fields: ["slug"],
				},
			}),
			{
				status: 400,
				headers: { "content-type": "application/problem+json" },
			}
		);
		const error = await parse("sites", response, "POST");
		expect(error.code).toBe("invalid_request");
		expect(error.requestId).toBe("req_sites");
		expect(error.details).toEqual({ fields: ["slug"] });
	});

	test("Box 429 quota_exceeded from the real error helper", async () => {
		const response = boxErrorResponse(
			new BoxError("quota_exceeded", "Box quota reached.", 429),
			"req_box"
		);
		const error = await parse("box", response, "POST");
		expect(error).toBeInstanceOf(RyuQuotaExceededError);
		expect(error).toBeInstanceOf(RyuRateLimitError);
		expect(error.type).toBe("box.error");
		expect(error.code).toBe("quota_exceeded");
		expect(error.requestId).toBe("req_box");
		expect(error.retryable).toBe(false);
	});

	test("Managed Agents raw envelope", async () => {
		const response = json(
			{
				error: {
					code: "session_running",
					details: { status: "running" },
					message: "Session is running.",
					requestId: "req_ma",
				},
			},
			409
		);
		const error = await parse("managedAgents", response, "POST");
		expect(error).toBeInstanceOf(RyuConflictError);
		expect(error.envelope).toBe("nested-error");
		expect(error.code).toBe("session_running");
		expect(error.requestId).toBe("req_ma");
		expect(error.details).toEqual({ status: "running" });
	});

	test("messaging-envelope bodies ({error:<code>, message}) read `error` as the code and the rest as details", async () => {
		const response = json(
			{
				error: "outcome_unknown",
				limit: 5,
				message: "Delivery state unknown.",
				window: 60,
			},
			502
		);
		const error = await parse("sites", response, "POST");
		expect(error.envelope).toBe("messaging");
		expect(error.code).toBe("outcome_unknown");
		expect(error.message).toBe("Delivery state unknown.");
		expect(error.details).toEqual({ limit: 5, window: 60 });
		expect(error.retryable).toBe(false);
	});

	test("hosted Mail negotiated problem+json", async () => {
		const response = problemResponse({
			status: 413,
			detail: "Message too large",
		});
		const error = await parse("mail", response, "POST");
		expect(error).toBeInstanceOf(RyuInvalidRequestError);
		expect(error.code).toBe("payload_too_large");
		expect(error.message).toBe("Message too large");
	});

	test("hosted Mail {error, code}", async () => {
		const error = await parse(
			"mail",
			json({ code: "inbox_not_found", error: "Inbox not found" }, 404)
		);
		expect(error).toBeInstanceOf(RyuNotFoundError);
		expect(error.envelope).toBe("code-error");
		expect(error.code).toBe("inbox_not_found");
		expect(error.message).toBe("Inbox not found");
		expect(error.details).toBeNull();
	});

	test("hosted Mail insufficient_scope keeps requiredScope in details", async () => {
		const error = await parse(
			"mail",
			json(
				{
					code: "insufficient_scope",
					error: "This API key lacks the mail:send scope",
					requiredScope: "mail:send",
				},
				403
			),
			"POST"
		);
		expect(error.code).toBe("insufficient_scope");
		expect(error.details).toEqual({ requiredScope: "mail:send" });
	});

	test("{code, error, ok:false} does not echo ok into details", async () => {
		const error = await parse(
			"connect",
			json({ code: "tool_denied", error: "Denied", ok: false }, 403),
			"POST"
		);
		expect(error.details).toBeNull();
	});

	test("hosted Mail {message}", async () => {
		const error = await parse(
			"mail",
			json({ message: "Payload too large" }, 413),
			"POST"
		);
		expect(error.envelope).toBe("error-message");
		expect(error.code).toBe("payload_too_large");
		expect(error.message).toBe("Payload too large");
	});

	test("hosted Mail plain text (no Accept negotiation)", async () => {
		const error = await parse(
			"mail",
			new Response("Unauthorized", {
				headers: { "content-type": "text/plain" },
				status: 401,
			})
		);
		expect(error).toBeInstanceOf(RyuAuthenticationError);
		expect(error.envelope).toBe("text");
		expect(error.message).toBe("Unauthorized");
	});

	test("self-hosted Mail {error} without a code uses the status table", async () => {
		const error = await parse(
			"mail",
			json({ error: "Address is invalid." }, 422),
			"POST"
		);
		expect(error.envelope).toBe("error-string");
		expect(error.code).toBe("unprocessable_content");
		expect(error.message).toBe("Address is invalid.");
	});

	test("Gateway OpenAI-style 429 with error.retry_after", async () => {
		const response = json(
			{
				error: {
					code: "provider_rate_limited",
					message: "Provider is rate limiting.",
					retry_after: 42,
					type: "provider_rate_limited",
				},
			},
			429
		);
		const error = await parse("gateway", response, "POST");
		expect(error).toBeInstanceOf(RyuRateLimitError);
		expect(error.envelope).toBe("openai");
		expect(error.code).toBe("provider_rate_limited");
		expect(error.retryAfterSeconds).toBe(42);
	});

	test("Gateway 502 provider_error", async () => {
		const response = json(
			{
				error: {
					code: "provider_error",
					message: "Upstream failed.",
					type: "provider_error",
				},
			},
			502
		);
		const error = await parse("gateway", response, "POST");
		expect(error).toBeInstanceOf(RyuServerError);
		expect(error.code).toBe("provider_error");
	});

	test("Connect {code, error, ok:false} with retryAfterSeconds and x-request-id", async () => {
		const response = json(
			{
				code: "composio_rate_limited",
				error: "Too many executions.",
				ok: false,
				retryAfterSeconds: 40,
			},
			429,
			{ "x-request-id": "req_connect" }
		);
		const error = await parse("connect", response, "POST");
		expect(error.envelope).toBe("code-error");
		expect(error.code).toBe("composio_rate_limited");
		expect(error.message).toBe("Too many executions.");
		expect(error.retryAfterSeconds).toBe(40);
		expect(error.requestId).toBe("req_connect");
	});

	test("Connect bare {code}", async () => {
		const error = await parse("connect", json({ code: "tool_not_found" }, 404));
		expect(error.envelope).toBe("code-error");
		expect(error.code).toBe("tool_not_found");
	});

	test("Passport {error:'not_found'} is not misread as a messaging-envelope code", async () => {
		const bare = await parse("passport", json({ error: "not_found" }, 404));
		expect(bare.envelope).toBe("error-string");
		expect(bare.code).toBe("not_found");
		const withMessage = await parse(
			"passport",
			json({ error: "connection_missing", message: "No such connection." }, 404)
		);
		expect(withMessage.envelope).toBe("error-string");
		expect(withMessage.code).toBe("not_found");
		expect(withMessage.message).toBe("connection_missing");
	});

	test("Passport 503 {ok, code, error, message}", async () => {
		const error = await parse(
			"passport",
			json(
				{
					code: "metering_unavailable",
					error: "metering_unavailable",
					message: "Usage store is behind.",
					ok: false,
				},
				503
			),
			"POST"
		);
		expect(error).toBeInstanceOf(RyuUnavailableError);
		expect(error.code).toBe("metering_unavailable");
		expect(error.message).toBe("Usage store is behind.");
		expect(error.retryable).toBe(false);
	});

	test("Passport empty 404", async () => {
		const error = await parse("passport", new Response(null, { status: 404 }));
		expect(error).toBeInstanceOf(RyuNotFoundError);
		expect(error.envelope).toBe("empty");
		expect(error.code).toBe("not_found");
	});

	test("Sites {error:{code,message,fields}} keeps fields in details", async () => {
		const response = json(
			{
				error: {
					code: "conflict",
					fields: { expectedRevision: 3 },
					message: "Stale revision.",
				},
			},
			409
		);
		const error = await parse("sites", response, "POST");
		expect(error).toBeInstanceOf(RyuConflictError);
		expect(error.envelope).toBe("nested-error");
		expect(error.details).toEqual({ fields: { expectedRevision: 3 } });
	});

	test("a 3xx becomes RyuRedirectError", async () => {
		const error = await parse(
			"notify",
			Response.redirect("https://evil.example.com", 302)
		);
		expect(error).toBeInstanceOf(RyuRedirectError);
	});

	test("bodies are capped at 64 KiB", async () => {
		const error = await parse(
			"notify",
			new Response("x".repeat(200_000), { status: 500 })
		);
		expect(error.envelope).toBe("text");
		expect(error.message.length).toBe(512);
	});
});

describe("RyuError", () => {
	test("toJSON strips the query string and carries request facts", async () => {
		const error = await parse(
			"box",
			json({ error: { code: "box_busy", message: "Busy." } }, 409),
			"POST"
		);
		const serialized = JSON.stringify(error);
		expect(serialized).not.toContain("secret");
		expect(error.url).toBe("https://svc.example.com/v1/things");
		expect(error.toJSON()).toMatchObject({
			attempts: 2,
			code: "box_busy",
			idempotencyKey: "key-123",
			method: "POST",
			name: "RyuConflictError",
			service: "box",
			status: 409,
		});
	});

	test("isRyuError recognizes RyuErrors and rejects other errors", () => {
		expect(
			isRyuError(
				createRyuError({
					code: "x",
					message: "m",
					service: "notify",
					status: 500,
				})
			)
		).toBe(true);
		expect(isRyuError(new Error("plain"))).toBe(false);
		expect(isRyuError({ code: "x", service: "notify" })).toBe(false);
	});

	test("createRyuError picks subclasses from status and availability codes", () => {
		const make = (status: number, code: string) =>
			createRyuError({ code, message: "m", service: "connect", status });
		expect(make(500, "internal_error")).toBeInstanceOf(RyuServerError);
		expect(make(400, "not_configured")).toBeInstanceOf(RyuUnavailableError);
		expect(make(410, "gone").constructor).toBe(RyuError);
	});
});

describe("converting client errors", () => {
	test("fromManagedAgentsError keeps requestId, details, retryAfterSeconds and cause", () => {
		const original = new ManagedAgentsError({
			code: "managed_agents_disabled",
			details: { feature: "managed_agents" },
			message: "Managed Agents is off.",
			requestId: "req_off",
			retryAfterSeconds: 30,
			status: 503,
		});
		const error = fromManagedAgentsError(original, {
			attempts: 1,
			method: "GET",
			url: "https://api.ryuhq.com/api/v1/managed-agents/agents?limit=1",
		});
		expect(error).toBeInstanceOf(RyuUnavailableError);
		expect(error.envelope).toBe("managed-agents");
		expect(error.requestId).toBe("req_off");
		expect(error.details).toEqual({ feature: "managed_agents" });
		expect(error.retryAfterSeconds).toBe(30);
		expect(error.cause).toBe(original);
		expect(error.retryable).toBe(false);
		expect(error.url).toBe(
			"https://api.ryuhq.com/api/v1/managed-agents/agents"
		);
	});

	test("toRyuError maps zod and JSON failures to RyuResponseValidationError", () => {
		const zodFailure = z.object({ id: z.string() }).safeParse({}).error;
		expect(toRyuError(zodFailure, "notify")).toBeInstanceOf(
			RyuResponseValidationError
		);
		expect(toRyuError(new SyntaxError("Unexpected token"), "box").code).toBe(
			"invalid_response"
		);
	});

	test("toRyuError wraps unknown errors as client_error and passes RyuErrors through", () => {
		const plain = toRyuError(new Error("Box b1 failed: disk"), "box");
		expect(plain.code).toBe("client_error");
		expect(plain.envelope).toBe("client");
		expect(plain.message).toBe("Box b1 failed: disk");
		const ryu = createRyuError({
			code: "x",
			message: "m",
			service: "box",
			status: 500,
		});
		expect(toRyuError(ryu, "notify")).toBe(ryu);
	});

	test("toRyuError maps AbortError, or any error once the call aborted, to RyuAbortError", () => {
		const bodyAbort = toRyuError(
			new DOMException("The operation was aborted.", "AbortError"),
			"box",
			{ method: "GET", url: URL_WITH_TOKEN }
		);
		expect(bodyAbort).toBeInstanceOf(RyuAbortError);
		expect(bodyAbort.code).toBe("aborted");
		expect(bodyAbort.retryable).toBe(false);
		expect(bodyAbort.url).toBe("https://svc.example.com/v1/things");
		const afterAbort = toRyuError(new TypeError("reader released"), "notify", {
			aborted: true,
		});
		expect(afterAbort).toBeInstanceOf(RyuAbortError);
		expect(
			toRyuError(new TypeError("reader released"), "notify", {
				aborted: false,
			}).code
		).toBe("client_error");
	});
});

describe("default hints on facade errors", () => {
	const NOTIFY_ENV = {
		RYU_NOTIFY_API_KEY: "notify_secret_key",
		RYU_NOTIFY_URL: "https://notify.example.com/base",
	};
	const AGENTS_ENV = { RYU_API_KEY: "ryu_secret_key" };

	async function failure(run: () => PromiseLike<unknown>): Promise<RyuError> {
		try {
			await run();
		} catch (error) {
			if (isRyuError(error)) {
				return error;
			}
			throw error;
		}
		throw new Error("expected a RyuError");
	}

	function respondWith(response: () => Response): RyuFetch {
		return () => Promise.resolve(response());
	}

	const SECRETS = [
		"notify_secret_key",
		"ryu_secret_key",
		"pw@",
		"passport_runtime_secret",
		"connect_secret",
		"connect_mgmt_secret",
	];

	function leakedSecrets(error: RyuError): string[] {
		const serialized = JSON.stringify(error.toJSON());
		return SECRETS.filter((secret) => serialized.includes(secret));
	}

	test("a 401 without a server hint names the service key env var", async () => {
		const ryu = new Ryu({
			env: NOTIFY_ENV,
			fetch: respondWith(() => new Response(null, { status: 401 })),
			maxRetries: 0,
		});
		const error = await failure(() => ryu.notify.publish({ title: "x" }));
		expect(error).toBeInstanceOf(RyuAuthenticationError);
		expect(error.hint).toBe(
			"Ryu Notify did not accept the credentials. Check RYU_NOTIFY_API_KEY (or notify.apiKey)."
		);
		expect(leakedSecrets(error)).toEqual([]);
	});

	test("a 403 on a per-service key names the key env var", async () => {
		const ryu = new Ryu({
			env: NOTIFY_ENV,
			fetch: respondWith(() =>
				Response.json(
					{ error: "forbidden", message: "Not allowed." },
					{ status: 403 }
				)
			),
			maxRetries: 0,
		});
		const error = await failure(() => ryu.notify.publish({ title: "x" }));
		expect(error.status).toBe(403);
		expect(error.hint).toContain(
			"Check RYU_NOTIFY_API_KEY (or notify.apiKey)."
		);
		expect(leakedSecrets(error)).toEqual([]);
	});

	test("a server-provided hint is kept", async () => {
		const ryu = new Ryu({
			env: NOTIFY_ENV,
			fetch: respondWith(() =>
				problemResponse({
					status: 401,
					detail: "Bad key.",
					hint: "Rotate the key in the console.",
				})
			),
			maxRetries: 0,
		});
		const error = await failure(() => ryu.notify.publish({ title: "x" }));
		expect(error.status).toBe(401);
		expect(error.hint).toBe("Rotate the key in the console.");
	});

	test("a Managed Agents 401 names RYU_API_KEY and RYU_ORGANIZATION_ID", async () => {
		const ryu = new Ryu({
			env: AGENTS_ENV,
			fetch: respondWith(() => new Response(null, { status: 401 })),
			maxRetries: 0,
		});
		const error = await failure(() =>
			ryu.managedAgents.sessions.get("msess_1")
		);
		expect(error.status).toBe(401);
		expect(error.hint).toBe(
			"Ryu Managed Agents did not accept the credentials. Check RYU_API_KEY and RYU_ORGANIZATION_ID (or apiKey and organizationId)."
		);
		expect(leakedSecrets(error)).toEqual([]);
	});

	test("a connection error names the target origin, RYU_<SVC>_URL and doctor", async () => {
		const ryu = new Ryu({
			env: {
				...NOTIFY_ENV,
				RYU_NOTIFY_URL: "https://ops:pw@notify.example.com:8443/base?t=1",
			},
			fetch: () => Promise.reject(new TypeError("fetch failed")),
			maxRetries: 0,
		});
		const error = await failure(() => ryu.notify.publish({ title: "x" }));
		expect(error.code).toBe("connection_error");
		expect(error.hint).toBe(
			"Could not reach Ryu Notify at https://notify.example.com:8443. Check RYU_NOTIFY_URL (or notify.baseUrl). Run `ryu-services doctor --check` to test the connection."
		);
		expect(leakedSecrets(error)).toEqual([]);
	});
	test("a Managed Agents connection error names the origin and RYU_API_URL", async () => {
		const ryu = new Ryu({
			env: { ...AGENTS_ENV, RYU_API_URL: "https://agents.example.com/api?x=1" },
			fetch: () => Promise.reject(new TypeError("fetch failed")),
			maxRetries: 0,
		});
		const error = await failure(() =>
			ryu.managedAgents.sessions.get("msess_1")
		);
		expect(error.code).toBe("connection_error");
		expect(error.hint).toBe(
			"Could not reach Ryu Managed Agents at https://agents.example.com. Check RYU_API_URL (or baseUrl). Run `ryu-services doctor --check` to test the connection."
		);
		expect(leakedSecrets(error)).toEqual([]);
	});

	test("a Managed Agents 403 gets no default hint (its key is account-wide)", async () => {
		const ryu = new Ryu({
			env: AGENTS_ENV,
			fetch: respondWith(() => new Response(null, { status: 403 })),
			maxRetries: 0,
		});
		const error = await failure(() =>
			ryu.managedAgents.sessions.get("msess_1")
		);
		expect(error.status).toBe(403);
		expect(error.hint).toBeNull();
	});

	test("a runtime-only Passport 401 names only RYU_PASSPORT_RUNTIME_KEY", async () => {
		const ryu = new Ryu({
			env: {
				RYU_PASSPORT_RUNTIME_KEY: "passport_runtime_secret",
				RYU_PASSPORT_URL: "https://passport.example.com",
			},
			fetch: respondWith(() => new Response(null, { status: 401 })),
			maxRetries: 0,
		});
		const error = await failure(() => ryu.passport.runtime.connections.list());
		expect(error.status).toBe(401);
		expect(error.hint).toBe(
			"Ryu Passport did not accept the credentials. Check RYU_PASSPORT_RUNTIME_KEY (or passport.runtimeKey)."
		);
		expect(leakedSecrets(error)).toEqual([]);
	});

	test("a Connect 401 with a management key names both key variables", async () => {
		const ryu = new Ryu({
			env: {
				RYU_CONNECT_API_KEY: "connect_secret",
				RYU_CONNECT_MANAGEMENT_KEY: "connect_mgmt_secret",
				RYU_CONNECT_URL: "https://connect.example.com",
			},
			fetch: respondWith(() => new Response(null, { status: 401 })),
			maxRetries: 0,
		});
		const error = await failure(() => ryu.connect.skills.list());
		expect(error.status).toBe(401);
		expect(error.hint).toBe(
			"Ryu Connect did not accept the credentials. Check RYU_CONNECT_API_KEY and RYU_CONNECT_MANAGEMENT_KEY (or connect.apiKey and connect.managementKey)."
		);
		expect(leakedSecrets(error)).toEqual([]);
	});
});

describe("parseErrorResponse: known server hints", () => {
	test("a bare Mail 'email transport is not configured' gains an SMTP hint and docs", async () => {
		const error = await parse(
			"mail",
			json({ error: "email transport is not configured" }, 400),
			"POST"
		);
		expect(error.hint).toContain("RYU_SMTP_HOST");
		expect(error.docs).toBe(
			"https://docs.ryuhq.com/docs/standalone/mail#start-the-standalone-service"
		);
	});

	test("a 429 after failed authentication says a correct key is refused too", async () => {
		const error = await parse(
			"notify",
			json(
				{
					error: {
						code: "rate_limited",
						message:
							"Too many failed authentication attempts from this address; retry after the Retry-After delay.",
					},
				},
				429,
				{ "retry-after": "60" }
			),
			"GET"
		);
		expect(error.status).toBe(429);
		expect(error.hint).toContain("refuses even a correct key");
		expect(error.hint).toContain("Retry-After");
		expect(error.docs).toBe(
			"https://docs.ryuhq.com/docs/standalone/sdk/errors#default-hints"
		);
		const ordinary = await parse(
			"notify",
			json(
				{
					error: {
						code: "rate_limited",
						message: "This tenant is publishing too fast.",
					},
				},
				429
			),
			"POST"
		);
		expect(ordinary.hint).toBeNull();
	});

	test("a server-supplied hint wins, and other services are untouched", async () => {
		const withHint = await parse(
			"mail",
			json(
				{
					status: 400,
					title: "Bad Request",
					detail: "email transport is not configured",
					hint: "Ask the operator.",
				},
				400,
				{ "content-type": "application/problem+json" }
			),
			"POST"
		);
		expect(withHint.hint).toBe("Ask the operator.");
		const notify = await parse(
			"notify",
			json({ error: "email transport is not configured" }, 400),
			"POST"
		);
		expect(notify.hint).toBeNull();
		expect(notify.docs).toBeNull();
	});
});

describe("parseErrorResponse: a URL pointing at another Ryu service", () => {
	const problem = (page: string, code: string, status: number, hint?: string) =>
		json(
			{
				type: `https://docs.ryuhq.com/docs/standalone/${page}#${code}`,
				title: "Unauthorized",
				status,
				detail: "Missing or invalid bearer token",
				code,
				...(hint === undefined ? {} : { hint }),
			},
			status,
			{ "content-type": "application/problem+json" }
		);

	test("Notify's URL at Box names the URL env var, not the key", async () => {
		const error = await parse(
			"notify",
			problem("box-api", "unauthorized", 401)
		);
		expect(error.hint).toBe(
			"RYU_NOTIFY_URL points at Ryu Box, not Ryu Notify: the error came from the other service. Set RYU_NOTIFY_URL to the Ryu Notify server's URL."
		);
		expect(error.docs).toBe(
			"https://docs.ryuhq.com/docs/standalone/sdk/errors#default-hints"
		);
		expect(error.type).toBe(
			"https://docs.ryuhq.com/docs/standalone/box-api#unauthorized"
		);
	});

	test("each standalone pair is detected, and the other service's own hint is replaced", async () => {
		const pairs: [RyuService, string, string][] = [
			["box", "notify-api", "RYU_BOX_URL points at Ryu Notify"],
			["sites", "notify-api", "RYU_SITES_URL points at Ryu Notify"],
			["notify", "sites-api", "RYU_NOTIFY_URL points at Ryu Sites"],
			["notify", "connect-api", "RYU_NOTIFY_URL points at Ryu Connect"],
			["connect", "passport-mcp-api", "RYU_CONNECT_URL points at Ryu Passport"],
		];
		for (const [service, page, start] of pairs) {
			const error = await parse(
				service,
				problem(page, "unauthorized", 401, "Check the other key.")
			);
			expect(error.hint?.startsWith(start)).toBe(true);
		}
	});

	test("the service's own page, or a control-plane sibling, keeps the normal hint", async () => {
		const own = await parse("box", problem("box-api", "unauthorized", 401));
		expect(own.hint).toBeNull();
		const sibling = await parse(
			"mail",
			problem("managed-agents-api", "unauthorized", 401)
		);
		expect(sibling.hint).toBeNull();
		const elsewhere = await parse(
			"notify",
			problem("notify-api", "unauthorized", 401, "Own hint.")
		);
		expect(elsewhere.hint).toBe("Own hint.");
	});
});

describe("parseErrorResponse: Connect lanes the operator has not configured", () => {
	test("each configuration-class 503 says retrying will not help", async () => {
		for (const [code, setting] of [
			["upstream_unconfigured", "RYU_CONNECT_CORE_URL"],
			["upstream_invalid", "RYU_CONNECT_MCP_UPSTREAM"],
			["mcp_unconfigured", "RYU_CONNECT_MCP_UPSTREAM"],
			["native_composio_unavailable", "RYU_CONNECT_COMPOSIO_BINDINGS"],
			["skills_unavailable", "RYU_CONNECT_SKILLS_DIR"],
		] as const) {
			const error = await parse(
				"connect",
				json(
					{ code, error: "Connect upstream is not configured", ok: false },
					503
				)
			);
			expect(error.code).toBe(code);
			expect(error.hint).toContain("This Connect has no ");
			expect(error.hint).toContain(setting);
			expect(error.hint).toContain("will not help");
		}
	});

	test("other Connect 503s and other services keep no hint", async () => {
		const other = await parse(
			"connect",
			json({ code: "provider_unavailable", error: "down", ok: false }, 503)
		);
		expect(other.hint).toBeNull();
		const notify = await parse(
			"notify",
			json({ code: "upstream_unconfigured", error: "x" }, 503)
		);
		expect(notify.hint).toBeNull();
	});

	test("upstream_unconfigured names the native settings before compatibility mode", async () => {
		const error = await parse(
			"connect",
			json({ code: "upstream_unconfigured", error: "x", ok: false }, 503)
		);
		const hint = error.hint ?? "";
		expect(hint).toContain("RYU_CONNECT_MCP_SERVERS");
		expect(hint).toContain("RYU_CONNECT_COMPOSIO_BINDINGS");
		expect(hint.indexOf("native:")).toBeGreaterThan(-1);
		expect(hint.indexOf("RYU_CONNECT_MCP_SERVERS")).toBeLessThan(
			hint.indexOf("RYU_CONNECT_CORE_URL")
		);
		expect(hint).toContain("compatibility mode");
	});
});

describe("RyuError messages end with the hint", () => {
	const notConfigured = () =>
		new RyuConfigurationError({
			service: "notify",
			status: 0,
			message: "Ryu Notify is not configured: set RYU_NOTIFY_API_KEY.",
			hint: "Set RYU_NOTIFY_API_KEY (or pass notify.apiKey to new Ryu()).",
		});

	test("message, String() and toJSON() carry the hint; code and hint are unchanged", () => {
		const error = notConfigured();
		const full =
			"Ryu Notify is not configured: set RYU_NOTIFY_API_KEY. Hint: Set RYU_NOTIFY_API_KEY (or pass notify.apiKey to new Ryu()).";
		expect(error.message).toBe(full);
		expect(String(error)).toBe(`RyuConfigurationError: ${full}`);
		expect(error.toJSON().message).toBe(full);
		expect(error.code).toBe("configuration_error");
		expect(error.hint).toBe(
			"Set RYU_NOTIFY_API_KEY (or pass notify.apiKey to new Ryu())."
		);
		expect(messageWithoutHint(error)).toBe(
			"Ryu Notify is not configured: set RYU_NOTIFY_API_KEY."
		);
	});

	test("messageWithHint adds a period only when the message lacks one, and skips empty or repeated hints", () => {
		expect(messageWithHint("Bad key", "Check it.")).toBe(
			"Bad key. Hint: Check it."
		);
		expect(messageWithHint("Bad key!", "Check it.")).toBe(
			"Bad key! Hint: Check it."
		);
		expect(messageWithHint("", "Check it.")).toBe("Hint: Check it.");
		expect(messageWithHint("Bad key", null)).toBe("Bad key");
		expect(messageWithHint("Bad key", "  ")).toBe("Bad key");
		expect(
			messageWithHint(
				"Bad key; check RYU_NOTIFY_API_KEY.",
				"check RYU_NOTIFY_API_KEY."
			)
		).toBe("Bad key; check RYU_NOTIFY_API_KEY.");
	});

	test("a hint the message already contains is not repeated", () => {
		const error = new RyuError({
			service: "notify",
			status: 401,
			code: "unauthenticated",
			message: "Bad key. Hint: Rotate it.",
			hint: "Rotate it.",
		});
		expect(error.message).toBe("Bad key. Hint: Rotate it.");
	});

	test("only a hint the message ends with is dropped, ignoring a final period", () => {
		expect(messageWithHint("Unauthorized key supplied", "key")).toBe(
			"Unauthorized key supplied. Hint: key"
		);
		expect(messageWithHint("Unauthorized: key", "key")).toBe(
			"Unauthorized: key"
		);
		expect(
			messageWithHint("Check the key. Then retry.", "Check the key.")
		).toBe("Check the key. Then retry. Hint: Check the key.");
		expect(messageWithHint("bad key. Check the key", "Check the key.")).toBe(
			"bad key. Check the key"
		);
	});

	test("a copy given the hinted message back plus a new hint carries only the new hint", () => {
		const error = new RyuError({
			service: "notify",
			status: 401,
			code: "unauthenticated",
			message: "bad key",
			hint: "Check A.",
		});
		for (const copied of [
			withRyuErrorFields(error, { message: error.message, hint: "Check B." }),
			copyRyuError(error, { message: error.message, hint: "Check B." }),
		]) {
			expect(copied.message).toBe("bad key. Hint: Check B.");
			expect(messageWithoutHint(copied)).toBe("bad key");
		}
		expect(withRyuErrorFields(error, { message: "other" }).message).toBe(
			"other. Hint: Check A."
		);
	});

	test("a plain copy of the error keeps the period added before the hint", () => {
		const error = new RyuError({
			service: "notify",
			status: 401,
			code: "unauthenticated",
			message: "bad key",
			hint: "Check the key.",
		});
		const plainCopy = JSON.parse(JSON.stringify(error.toJSON())) as {
			hint: string;
			message: string;
		};
		expect(messageWithoutHint(error)).toBe("bad key");
		expect(messageWithoutHint(plainCopy)).toBe("bad key.");
	});

	test("copies rebuild the message from the new hint without keeping the old one", () => {
		const error = notConfigured();
		const copied = copyRyuError(error, { hint: "Run the setup." });
		expect(copied.message).toBe(
			"Ryu Notify is not configured: set RYU_NOTIFY_API_KEY. Hint: Run the setup."
		);
		const kept = withRyuErrorFields(error, { requestId: "req_1" });
		expect(kept.message).toBe(error.message);
		const cleared = withRyuErrorFields(error, { hint: null });
		expect(cleared.message).toBe(
			"Ryu Notify is not configured: set RYU_NOTIFY_API_KEY."
		);
		const bare = new RyuError({
			service: "gateway",
			status: 401,
			code: "unauthenticated",
			message: "bad key",
		});
		const hinted = copyRyuError(bare, { hint: "Check the token." });
		expect(hinted.message).toBe("bad key. Hint: Check the token.");
		expect(messageWithoutHint(hinted)).toBe("bad key");
	});

	test("an error from another copy of the package strips its hint by suffix", () => {
		const foreign = Object.assign(new Error("Bad key. Hint: Check it."), {
			hint: "Check it.",
		});
		expect(messageWithoutHint(foreign)).toBe("Bad key.");
		expect(
			messageWithoutHint({ message: "Hint: Check it.", hint: "Check it." })
		).toBe("");
	});

	test("a parsed 429 after failed authentication ends its message with the backoff hint", async () => {
		const error = await parse(
			"notify",
			json(
				{
					ok: false,
					type: "notify.error",
					error: {
						code: "rate_limited",
						message:
							"Too many failed authentication attempts from this address; retry after the Retry-After delay.",
					},
				},
				429,
				{ "retry-after": "30" }
			)
		);
		expect(error.message).toStartWith(
			"Too many failed authentication attempts from this address; retry after the Retry-After delay. Hint: The service blocks an address"
		);
		expect(error.message).not.toContain("secret");
	});

	test("knownServerHint and the message helpers are root exports", () => {
		expect(root.knownServerHint).toBe(knownServerHint);
		expect(root.messageWithHint).toBe(messageWithHint);
		expect(root.messageWithoutHint).toBe(messageWithoutHint);
		expect(
			knownServerHint("box", 429, "Failed authentication backoff")?.docs
		).toBe("https://docs.ryuhq.com/docs/standalone/sdk/errors#default-hints");
	});
});
