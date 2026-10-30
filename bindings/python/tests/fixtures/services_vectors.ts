// bindings/python/tests/fixtures/services_vectors.ts
//
// Generates services_vectors.json: the decisions @ryuhq/services makes, run
// through the TypeScript source itself, for the Python client
// (bindings/python/ryu_sdk/services) to reproduce. Covers the constants the
// two SDKs share (env vars, idempotent routes, non-retryable codes, status
// codes, error classes), error-envelope parsing, retry decisions,
// Retry-After/RateLimit/deprecation parsing, configuration resolution, route
// matching, and webhook verification over deliveries signed here.
//
// Regenerate (test_services_vectors.py also does this when bun is installed
// and fails if the committed file is stale):
//
//   bun bindings/python/tests/fixtures/services_vectors.ts > bindings/python/tests/fixtures/services_vectors.json

import { createHmac } from "node:crypto";
import type { ManagedAgentEvent } from "@ryuhq/client";
import { BOX_ERROR_CODES } from "../../../../packages/services/src/box/codes.ts";
import * as config from "../../../../packages/services/src/config.ts";
import { CONNECT_ERROR_MESSAGES } from "../../../../packages/services/src/connect/namespace.ts";
import { createEnvReader } from "../../../../packages/services/src/env.ts";
import * as errors from "../../../../packages/services/src/errors.ts";
import {
	gatewayUpstreamStatus,
	refineGatewayError,
} from "../../../../packages/services/src/gateway/namespace.ts";
import { MAIL_MESSAGE_CODES } from "../../../../packages/services/src/mail/helpers.ts";
import {
	MANAGED_AGENTS_PREVIEW_DOCS,
	MANAGED_AGENTS_PREVIEW_HINTS,
} from "../../../../packages/services/src/managed-agents/codes.ts";
import {
	pendingToolApprovals,
	TOOL_APPROVAL_EVENT_TYPES,
	toolApprovalIdempotencyKey,
} from "../../../../packages/services/src/managed-agents/helpers.ts";
import {
	MESSAGING_DOCS,
	messagingAvailabilityHint,
} from "../../../../packages/services/src/messaging/namespace.ts";
import {
	passportCapabilitiesSchema,
	passportConnectionListSchema,
	passportCreatedConnectionSchema,
	passportDeletedConnectionSchema,
	passportFetchResultSchema,
	passportLoginFlowSchema,
	passportProfileListSchema,
	passportUsageReportSchema,
} from "../../../../packages/services/src/passport/client.ts";
import { SERVICE_ROUTES } from "../../../../packages/services/src/routes.ts";
import { Ryu } from "../../../../packages/services/src/ryu.ts";
import { STATUS_CODES } from "../../../../packages/services/src/status-codes.ts";
import { parseDeprecation } from "../../../../packages/services/src/transport/deprecation.ts";
import {
	matchCapabilityRoute,
	matchNonReplaySafeRoute,
	matchRoute,
} from "../../../../packages/services/src/transport/idempotency.ts";
import {
	parseRetryAfter,
	readRateLimit,
} from "../../../../packages/services/src/transport/rate-limit.ts";
import {
	computeDelay,
	NON_RETRYABLE_CODES,
	RETRYABLE_STATUSES,
	shouldRetry,
} from "../../../../packages/services/src/transport/retry.ts";
import {
	MAIL_EVENT_TYPES,
	MESSAGING_EVENT_TYPES,
	verifyMailWebhook,
	verifyMessagingWebhook,
	verifyNotifyWebhook,
	verifyStandardWebhook,
} from "../../../../packages/services/src/webhooks/index.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const NOW_MS = Date.UTC(2026, 9, 22, 12, 0, 0);
const NOW_S = NOW_MS / 1000;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const constants = {
	envVars: config.ENV_VARS.map((row) => ({
		default: row.default,
		name: row.name,
		role: row.role,
		service: row.service,
	})),
	serviceRoutes: Object.fromEntries(
		Object.entries(SERVICE_ROUTES).map(([service, table]) => [
			service,
			{
				capabilityIdempotent: (table.capabilityIdempotent ?? []).map(
					(route) => ({ ...route })
				),
				idempotent: table.idempotent.map((route) => ({ ...route })),
				mount: table.mount,
				nonReplaySafe: (table.nonReplaySafe ?? []).map((route) => ({
					...route,
				})),
				replayedBodyField: table.replayedBodyField ?? null,
				replayedBodyValue:
					table.replayedBodyValue ?? (table.replayedBodyField ? true : null),
			},
		])
	),
	nonRetryableCodes: [...NON_RETRYABLE_CODES].sort(),
	retryableStatuses: [...RETRYABLE_STATUSES].sort((a, b) => a - b),
	statusCodes: Object.fromEntries(
		Object.entries(STATUS_CODES).map(([status, row]) => [
			status,
			[row.code, row.title],
		])
	),
	errorClasses: Object.keys(errors)
		.filter((name) => /^Ryu\w*Error$/.test(name))
		.sort(),
	availabilityCodes: [...errors.AVAILABILITY_CODES].sort(),
	availability: { ...config.AVAILABILITY },
	defaults: {
		box: config.DEFAULT_BOX_URL,
		controlPlane: config.CONTROL_PLANE_URL,
		gateway: config.DEFAULT_GATEWAY_URL,
		notify: config.DEFAULT_NOTIFY_URL,
	},
	mailEventTypes: [...MAIL_EVENT_TYPES],
	boxErrorCodes: [...BOX_ERROR_CODES],
	messagingEventTypes: [...MESSAGING_EVENT_TYPES],
	// Prose-to-code and code-to-prose tables the Python client copies.
	mailMessageCodes: MAIL_MESSAGE_CODES.map((entry) => ({
		code: entry.code,
		message: entry.message,
		status: entry.status,
	})),
	connectErrorMessages: { ...CONNECT_ERROR_MESSAGES },
	managedAgentsPreviewDocs: MANAGED_AGENTS_PREVIEW_DOCS,
	managedAgentsPreviewHints: { ...MANAGED_AGENTS_PREVIEW_HINTS },
	messagingDocs: MESSAGING_DOCS,
	messagingAvailabilityHints: [
		{ status: 403, code: "feature_disabled", message: "off" },
		{
			status: 404,
			code: "not_found",
			message: "Ryu Messaging is not available for this organization",
		},
		{ status: 404, code: "not_found", message: "no such number" },
		{ status: 500, code: "internal_error", message: "boom" },
	].map((input) => ({ input, hint: messagingAvailabilityHint(input) })),
};

// ---------------------------------------------------------------------------
// Error parsing
// ---------------------------------------------------------------------------

interface ErrorCase {
	body: string;
	headers?: Record<string, string>;
	service: errors.RyuService;
	status: number;
}

const json = (value: unknown) => JSON.stringify(value);

const errorCases: ErrorCase[] = [
	{
		service: "managedAgents",
		status: 403,
		body: json({
			error: {
				code: "feature_disabled",
				message: "off",
				details: { feature: "managed-agents" },
				requestId: "req_body",
			},
		}),
	},
	{
		service: "managedAgents",
		status: 503,
		body: json({
			error: { code: "managed_agents_disabled", message: "not offered" },
		}),
		headers: { "x-request-id": "req_hdr" },
	},
	{
		service: "notify",
		status: 400,
		body: json({
			ok: false,
			type: "notify.error",
			error: {
				code: "invalid_request",
				message: "bad",
				fields: { title: "required" },
			},
		}),
	},
	{
		service: "gateway",
		status: 429,
		body: json({
			error: {
				message: "slow",
				type: "rate_limit_error",
				code: "rate_limited",
				retry_after: 7,
			},
		}),
		headers: {
			RateLimit: '"burst";r=0;t=12',
			"RateLimit-Policy": '"burst";q=60;w=60',
		},
	},
	{
		service: "connect",
		status: 402,
		body: json({
			code: "insufficient_credits",
			error: "insufficient_credits",
			retryAfterSeconds: 3,
		}),
	},
	{
		service: "messaging",
		status: 409,
		body: json({
			error: "outcome_unknown",
			message: "unclear",
			messageRecord: { id: "msg_1", status: "unresolved" },
		}),
	},
	{
		service: "passport",
		status: 404,
		body: json({ error: "connection not found", message: "nope" }),
	},
	{
		service: "box",
		status: 429,
		body: json({ code: "quota_exceeded", message: "quota", retryable: false }),
	},
	{
		service: "mail",
		status: 401,
		body: json({ message: "missing key" }),
		headers: { "WWW-Authenticate": 'Bearer realm="mail"' },
	},
	{
		service: "sites",
		status: 409,
		body: json({
			type: "https://docs.ryuhq.com/problems/conflict",
			title: "Conflict",
			status: 409,
			detail: "stale revision",
			code: "conflict",
			requestId: "req_p",
		}),
		headers: { "content-type": "application/problem+json" },
	},
	{ service: "notify", status: 502, body: "upstream exploded" },
	{ service: "box", status: 500, body: "" },
	{ service: "box", status: 418, body: "" },
	{
		service: "notify",
		status: 503,
		body: json({ code: "not_configured", message: "off" }),
		headers: { "Retry-After": "Wed, 22 Oct 2026 12:00:30 GMT" },
	},
	{
		service: "managedAgents",
		status: 409,
		body: json({
			error: { code: "idempotency_in_progress", message: "still running" },
		}),
		headers: {
			Deprecation: "@1790000000",
			Sunset: "Wed, 01 Apr 2027 00:00:00 GMT",
			Link: '<https://docs.ryuhq.com/policy>; rel="deprecation", <https://api.ryuhq.com/v2>; rel="successor-version"',
		},
	},
	// A URL env var pointing at another Ryu service: the error's problem type
	// (then docs) names that service's API page, and the hint says so.
	{
		service: "notify",
		status: 401,
		body: json({
			type: "https://docs.ryuhq.com/docs/standalone/box-api#unauthorized",
			title: "Unauthorized",
			status: 401,
			detail: "missing bearer token",
			code: "unauthorized",
			hint: "Check RYU_BOX_API_KEY.",
		}),
		headers: { "content-type": "application/problem+json" },
	},
	{
		service: "box",
		status: 401,
		body: json({
			type: "about:blank",
			title: "Error",
			status: 401,
			detail: "bad key",
			code: "unauthorized",
			docs: "https://docs.ryuhq.com/docs/standalone/notify-api#unauthorized",
		}),
		headers: { "content-type": "application/problem+json" },
	},
	{
		service: "sites",
		status: 401,
		body: json({
			type: "about:blank",
			title: "Error",
			status: 401,
			detail: "bad key",
			code: "unauthorized",
			docs: "https://docs.ryuhq.com/docs/standalone/passport-mcp-api/tools",
		}),
		headers: { "content-type": "application/problem+json" },
	},
	// The control-plane host serves Mail, Messaging and Managed Agents together.
	{
		service: "messaging",
		status: 401,
		body: json({
			type: "about:blank",
			title: "Error",
			status: 401,
			detail: "bad key",
			code: "unauthorized",
			docs: "https://docs.ryuhq.com/docs/standalone/mail-api#unauthorized",
		}),
		headers: { "content-type": "application/problem+json" },
	},
	// Passport's subpages are Passport's own.
	{
		service: "passport",
		status: 404,
		body: json({
			type: "about:blank",
			title: "Error",
			status: 404,
			detail: "no such tool",
			code: "not_found",
			docs: "https://docs.ryuhq.com/docs/standalone/passport-fetch-api#not-found",
		}),
		headers: { "content-type": "application/problem+json" },
	},
	// Connect lanes the operator has not configured.
	...[
		"upstream_unconfigured",
		"upstream_invalid",
		"mcp_unconfigured",
		"native_composio_unavailable",
		"skills_unavailable",
	].map(
		(code): ErrorCase => ({
			service: "connect",
			status: 503,
			body: json({ code, error: `Connect ${code}` }),
		})
	),
	{
		service: "connect",
		status: 503,
		body: json({ code: "upstream_unavailable", error: "down" }),
	},
	// Connect grants the operator has not given the tenant (a key cannot fix them).
	...["tool_denied", "toolkit_denied", "connection_denied", "forbidden"].map(
		(code): ErrorCase => ({
			service: "connect",
			status: 403,
			body: json({ code, error: `Connect ${code}`, ok: false }),
		})
	),
];

async function errorVectors(): Promise<Json[]> {
	const realNow = Date.now;
	Date.now = () => NOW_MS;
	try {
		const out: Json[] = [];
		for (const item of errorCases) {
			const response = new Response(item.body === "" ? null : item.body, {
				status: item.status,
				headers: item.headers,
			});
			const error = await errors.parseErrorResponse(
				item.service,
				response,
				"post",
				"https://svc.example.com/v1/x?token=secret"
			);
			const view = error.toJSON();
			out.push({
				input: item as unknown as Json,
				expected: {
					name: view.name,
					code: view.code,
					envelope: view.envelope,
					message: view.message,
					title: view.title,
					type: view.type,
					requestId: view.requestId,
					retryAfterSeconds: view.retryAfterSeconds,
					rateLimit: view.rateLimit as unknown as Json,
					deprecation: view.deprecation
						? {
								deprecatedAt:
									view.deprecation.deprecatedAt?.toISOString() ?? null,
								policyUrl: view.deprecation.policyUrl,
								successorUrl: view.deprecation.successorUrl,
								sunsetAt: view.deprecation.sunsetAt?.toISOString() ?? null,
							}
						: null,
					details: (view.details ?? null) as Json,
					docs: view.docs,
					hint: view.hint,
					authChallenge: view.authChallenge,
					retryable: view.retryable,
					url: view.url,
					method: view.method,
				},
			});
		}
		return out;
	} finally {
		Date.now = realNow;
	}
}

// ---------------------------------------------------------------------------
// Managed Agents errors, through the facade
// ---------------------------------------------------------------------------

// The facade never runs a Managed Agents reply through `parseErrorResponse`:
// @ryuhq/client raises ManagedAgentsError and `fromManagedAgentsError`
// converts it. These cases go through `new Ryu()` itself.
const managedAgentsErrorCases: Omit<ErrorCase, "service">[] = [
	{
		status: 403,
		body: json({
			error: {
				code: "feature_disabled",
				message: "off",
				details: { feature: "managed-agents" },
				requestId: "req_body",
			},
		}),
		headers: { "x-request-id": "req_hdr", "content-type": "application/json" },
	},
	{
		// No requestId: not the §4.1 envelope, so the status decides the code.
		status: 503,
		body: json({
			error: { code: "managed_agents_disabled", message: "not offered" },
		}),
		headers: { "x-request-id": "req_hdr", "content-type": "application/json" },
	},
	{
		status: 400,
		body: json({
			type: "about:blank",
			title: "Bad",
			code: "invalid_body",
			detail: "agentId is required",
		}),
		headers: { "content-type": "application/problem+json" },
	},
	{
		status: 429,
		body: json({ retryAfterSeconds: 9, code: "rate_limited" }),
		headers: { "content-type": "application/json", "Retry-After": "120" },
	},
	{ status: 502, body: "upstream exploded" },
	{
		status: 409,
		body: json({
			error: {
				code: "idempotency_in_progress",
				message: "still running",
				requestId: "req_409",
			},
		}),
		headers: {
			"content-type": "application/json",
			Deprecation: "@1790000000",
			Link: '<https://docs.ryuhq.com/policy>; rel="deprecation"',
		},
	},
	{
		status: 401,
		body: json({
			error: { code: "unauthenticated", message: "bad key", requestId: "r1" },
		}),
		headers: {
			"content-type": "application/json",
			"www-authenticate": "Bearer",
		},
	},
];

async function managedAgentsErrorVectors(): Promise<Json[]> {
	const { Ryu } = await import("../../../../packages/services/src/ryu.ts");
	const realNow = Date.now;
	Date.now = () => NOW_MS;
	try {
		const out: Json[] = [];
		for (const item of managedAgentsErrorCases) {
			const ryu = new Ryu({
				apiKey: "ryu_key",
				env: false,
				maxRetries: 0,
				result: "object",
				fetch: () =>
					Promise.resolve(
						new Response(item.body === "" ? null : item.body, {
							status: item.status,
							headers: item.headers,
						})
					),
			});
			const { error } = await ryu.managedAgents.agents.get("magt_1");
			if (error === null) {
				throw new Error("expected a Managed Agents error");
			}
			const view = error.toJSON();
			out.push({
				input: item as unknown as Json,
				expected: {
					name: view.name,
					code: view.code,
					envelope: view.envelope,
					message: view.message,
					title: view.title,
					requestId: view.requestId,
					retryAfterSeconds: view.retryAfterSeconds,
					rateLimit: view.rateLimit as unknown as Json,
					deprecated: view.deprecation !== null,
					details: (view.details ?? null) as Json,
					docs: view.docs,
					hint: view.hint,
					authChallenge: view.authChallenge,
					retryable: view.retryable,
					url: view.url,
					method: view.method,
				},
			});
		}
		return out;
	} finally {
		Date.now = realNow;
	}
}

// ---------------------------------------------------------------------------
// Retry decisions, header parsing
// ---------------------------------------------------------------------------

const retryCases = [
	{ status: 503, code: "service_unavailable", replaySafe: true },
	{ status: 503, code: "service_unavailable", replaySafe: false },
	{ status: 0, code: "connection_error", replaySafe: true },
	{ status: 429, code: "rate_limited", replaySafe: false },
	{
		status: 429,
		code: "rate_limited",
		replaySafe: false,
		retryAfterSeconds: 2,
	},
	{
		status: 429,
		code: "rate_limited",
		replaySafe: false,
		rateLimitRemaining: 0,
		rateLimitResetSeconds: 4,
	},
	{
		status: 429,
		code: "rate_limited",
		replaySafe: false,
		rateLimitRemaining: 3,
		rateLimitResetSeconds: 4,
	},
	{
		status: 429,
		code: "rate_limited",
		replaySafe: true,
		bodyRetryAfterSeconds: 5,
	},
	{
		status: 429,
		code: "quota_exceeded",
		replaySafe: true,
		retryAfterSeconds: 2,
	},
	{ status: 409, code: "idempotency_in_progress", replaySafe: true },
	{ status: 409, code: "conflict", replaySafe: true },
	{ status: 402, code: "payment_required", replaySafe: true },
	{ status: 502, code: "outcome_unknown", replaySafe: true },
	{ status: 500, code: "internal_error", replaySafe: true },
	{ status: 425, code: "client_error", replaySafe: true },
	{ status: 404, code: "not_found", replaySafe: true },
];

function retryVectors(): Json[] {
	return retryCases.map((item) => {
		const hints = {
			bodyRetryAfterSeconds: item.bodyRetryAfterSeconds ?? null,
			rateLimitRemaining: item.rateLimitRemaining ?? null,
			rateLimitResetSeconds: item.rateLimitResetSeconds ?? null,
			retryAfterSeconds: item.retryAfterSeconds ?? null,
		};
		const retry = shouldRetry({
			...hints,
			code: item.code,
			replayableBody: true,
			replaySafe: item.replaySafe,
			status: item.status,
		});
		const delays = [0, 1, 2, 5].map((index) =>
			computeDelay(index, hints, () => 0.5)
		);
		return {
			input: { ...item, ...hints } as unknown as Json,
			expected: {
				retry,
				delays: delays.map((delay) => ({
					ms: delay.delayMs,
					source: delay.source,
				})),
			},
		};
	});
}

const retryAfterCases = [
	"0",
	"12",
	" 7 ",
	"",
	"soon",
	"-3",
	"Wed, 22 Oct 2026 12:00:30 GMT",
	"Wed, 22 Oct 2026 11:00:00 GMT",
	"1790000000",
];

const rateLimitCases: [string | null, string | null][] = [
	['"burst";r=0;t=12', '"burst";q=60;w=60'],
	["default;r=5;t=30", null],
	[null, '"daily";q=1000;w=86400'],
	['"a";r=1;t=2, "b";r=3;t=4', '"b";q=9;w=9, "a";q=5;w=10'],
	['"x";r=abc', null],
	[null, null],
];

const deprecationCases: Record<string, string>[] = [
	{ Deprecation: "@1790000000" },
	{
		Deprecation: "Sat, 01 Jan 2028 00:00:00 GMT",
		Link: '<https://docs.ryuhq.com/p>; rel="deprecation"',
	},
	{
		Sunset: "Wed, 01 Apr 2027 00:00:00 GMT",
		Link: '<https://a.example.com/x,y>; rel="successor-version"',
	},
	{ Link: '<https://docs.ryuhq.com/p>; rel="deprecation"' },
];

function headerVectors(): Json {
	return {
		retryAfter: retryAfterCases.map((value) => ({
			input: value,
			expected: parseRetryAfter(value, NOW_MS),
		})),
		rateLimit: rateLimitCases.map(([limit, policy]) => {
			const headers = new Headers();
			if (limit !== null) {
				headers.set("RateLimit", limit);
			}
			if (policy !== null) {
				headers.set("RateLimit-Policy", policy);
			}
			return {
				input: [limit, policy],
				expected: readRateLimit(headers) as unknown as Json,
			};
		}),
		deprecation: deprecationCases.map((input) => {
			const parsed = parseDeprecation(new Headers(input));
			return {
				input,
				expected: parsed
					? {
							deprecatedAt: parsed.deprecatedAt?.toISOString() ?? null,
							policyUrl: parsed.policyUrl,
							successorUrl: parsed.successorUrl,
							sunsetAt: parsed.sunsetAt?.toISOString() ?? null,
						}
					: null,
			};
		}),
	};
}

// ---------------------------------------------------------------------------
// Configuration resolution
// ---------------------------------------------------------------------------

interface ConfigCase {
	env: Record<string, string>;
	options?: Record<string, unknown>;
	/** Credential strictness (Messaging `status()` resolves with `credentials: "optional"`). */
	resolution?: config.ConfigResolution;
	service: errors.RyuService;
}

const configCases: ConfigCase[] = [
	{ service: "managedAgents", env: {} },
	{
		service: "managedAgents",
		env: { RYU_API_KEY: "ryu_k", RYU_ORGANIZATION_ID: "org_1" },
	},
	{
		service: "managedAgents",
		env: { RYU_API_KEY: "ryu_k", RYU_API_URL: "https://api.example.com" },
		options: { managedAgents: { organizationId: "org_scoped" } },
	},
	{
		service: "managedAgents",
		env: { RYU_API_KEY: "ryu_k", RYU_API_URL: "not a url" },
	},
	{ service: "messaging", env: { RYU_API_KEY: "ryu_k" } },
	{
		service: "messaging",
		env: {},
		resolution: { credentials: "optional" },
	},
	{
		service: "messaging",
		env: { RYU_API_KEY: "ryu_k" },
		resolution: { credentials: "optional" },
	},
	{
		service: "messaging",
		env: { RYU_API_KEY: "ryu_k", RYU_ORGANIZATION_ID: "org_1" },
		resolution: { credentials: "optional" },
	},
	{
		service: "messaging",
		env: { RYU_API_URL: "not a url" },
		resolution: { credentials: "optional" },
	},
	// A URL written without its scheme gets a hint naming the fix (never the value).
	{
		service: "sites",
		env: { RYU_SITES_API_KEY: "s_k", RYU_SITES_URL: "127.0.0.1:48721" },
	},
	{
		service: "notify",
		env: { RYU_NOTIFY_API_KEY: "n_k", RYU_NOTIFY_URL: "localhost:8021" },
	},
	{
		service: "box",
		env: { RYU_BOX_API_KEY: "b_k", RYU_BOX_URL: "box.example.com/v1" },
	},
	{
		service: "box",
		env: { RYU_BOX_API_KEY: "b_k", RYU_BOX_URL: "ftp://box.example.com" },
	},
	// A value that names a scheme but no `//` authority is rejected by both SDKs
	// (WHATWG would repair it; urlsplit does not) and gets no "Add the scheme" hint.
	{
		service: "sites",
		env: { RYU_SITES_API_KEY: "s_k", RYU_SITES_URL: "http:127.0.0.1:8021" },
	},
	{
		service: "sites",
		env: { RYU_SITES_API_KEY: "s_k", RYU_SITES_URL: "http:/127.0.0.1:8021" },
	},
	{
		service: "notify",
		env: { RYU_NOTIFY_API_KEY: "n_k", RYU_NOTIFY_URL: "mailto:x" },
	},
	{
		service: "box",
		env: { RYU_BOX_API_KEY: "b_k", RYU_BOX_URL: "[::1]:8021" },
	},
	// A bare word is not a recognisable host, so it gets no hint either.
	{
		service: "box",
		env: { RYU_BOX_API_KEY: "b_k", RYU_BOX_URL: "nope" },
	},
	{
		service: "notify",
		env: {},
		resolution: { credentials: "optional" },
	},
	{
		service: "messaging",
		env: { RYU_API_KEY: "ryu_k", RYU_ORGANIZATION_ID: "org_1" },
	},
	{ service: "mail", env: {} },
	{
		service: "mail",
		env: { RYU_API_KEY: "ryu_k", RYU_ORGANIZATION_ID: "org_1" },
	},
	{
		service: "mail",
		env: { RYU_API_KEY: "ryu_k", RYU_MAIL_GATEWAY_KEY: "gw_k" },
	},
	{
		service: "mail",
		env: { RYU_API_KEY: "ryu_k", RYU_MAIL_URL: "https://mail.example.com" },
	},
	{
		service: "mail",
		env: {
			RYU_MAIL_API_KEY: "self_k",
			RYU_MAIL_URL: "https://mail.example.com",
			RYU_MAIL_GATEWAY_KEY: "gw_k",
		},
	},
	{ service: "mail", env: { RYU_MAIL_API_KEY: "self_k" } },
	{
		service: "mail",
		env: { RYU_MAIL_GATEWAY_KEY: "gw_env" },
		options: { apiKey: "ryu_opt" },
	},
	{
		service: "mail",
		env: { RYU_API_KEY: "ryu_k", RYU_MAIL_URL: "https://api.ryuhq.com" },
	},
	{ service: "notify", env: {} },
	{ service: "notify", env: { RYU_NOTIFY_API_KEY: "  " } },
	{ service: "notify", env: { RYU_NOTIFY_API_KEY: "n_k" } },
	{
		service: "box",
		env: { RYU_BOX_API_KEY: "b_k", RYU_BOX_URL: "https://box.example.com" },
	},
	{ service: "gateway", env: {} },
	{ service: "gateway", env: { RYU_GATEWAY_TOKEN: "g_k" } },
	{ service: "connect", env: { RYU_CONNECT_API_KEY: "c_k" } },
	{
		service: "connect",
		env: {
			RYU_CONNECT_API_KEY: "c_k",
			RYU_CONNECT_URL: "https://connect.example.com",
			RYU_CONNECT_MANAGEMENT_KEY: "m_k",
		},
	},
	{
		service: "passport",
		env: {
			RYU_PASSPORT_URL: "https://passport.example.com",
			RYU_PASSPORT_RUNTIME_KEY: "rt_k",
		},
	},
	{
		service: "passport",
		env: { RYU_PASSPORT_URL: "https://passport.example.com" },
	},
	{ service: "sites", env: {} },
	{
		service: "sites",
		env: { RYU_SITES_URL: "http://localhost:8090", RYU_SITES_API_KEY: "s_k" },
		options: { sites: { apiKey: "s_opt" } },
	},
];

function configVectors(): Json[] {
	return configCases.map((item) => {
		try {
			const resolved = config.resolveServiceConfig(
				item.service,
				(item.options ?? {}) as config.RyuOptions,
				createEnvReader(item.env),
				item.resolution
			);
			return {
				input: item as unknown as Json,
				expected: {
					apiKey: resolved.apiKey,
					auth: resolved.auth,
					baseUrl: resolved.baseUrl,
					mailMode: resolved.mailMode,
					managementKey: resolved.managementKey,
					organizationId: resolved.organizationId,
					runtimeKey: resolved.runtimeKey,
				},
			};
		} catch (error) {
			const ryuError = error as errors.RyuError;
			return {
				input: item as unknown as Json,
				error: {
					code: ryuError.code,
					details: (ryuError.details ?? null) as Json,
					hint: ryuError.hint,
					message: ryuError.message,
					name: ryuError.name,
				},
			};
		}
	});
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

const routeCases: [errors.RyuService, string, string, string][] = [
	[
		"mail",
		"https://api.ryuhq.com",
		"POST",
		"https://api.ryuhq.com/api/mail/inboxes/ibx_1/send",
	],
	[
		"mail",
		"https://api.ryuhq.com",
		"POST",
		"https://api.ryuhq.com/api/mail/inboxes/ibx_1/messages/m_1/reply-all",
	],
	[
		"mail",
		"https://api.ryuhq.com",
		"GET",
		"https://api.ryuhq.com/api/mail/inboxes/ibx_1/send",
	],
	[
		"mail",
		"https://mail.example.com/base",
		"POST",
		"https://mail.example.com/base/api/mail/inboxes/i/drafts/d/send",
	],
	[
		"mail",
		"https://api.ryuhq.com",
		"POST",
		"https://other.example.com/api/mail/inboxes/ibx_1/send",
	],
	[
		"notify",
		"https://notify.ryuhq.com",
		"POST",
		"https://notify.ryuhq.com/v1/topics/deploys",
	],
	[
		"notify",
		"https://notify.ryuhq.com",
		"POST",
		"https://notify.ryuhq.com/v1/events/evt_1/ack",
	],
	[
		"box",
		"https://box.ryuhq.com",
		"POST",
		"https://box.ryuhq.com/v1/boxes/box_1/fork",
	],
	["box", "https://box.ryuhq.com", "POST", "https://box.ryuhq.com/v1/boxes/"],
	[
		"managedAgents",
		"https://api.ryuhq.com",
		"PATCH",
		"https://api.ryuhq.com/api/v1/managed-agents/agents/magt_1",
	],
	[
		"managedAgents",
		"https://api.ryuhq.com",
		"POST",
		"https://api.ryuhq.com/api/v1/managed-agents/sessions/s_1/cancel",
	],
	[
		"messaging",
		"https://api.ryuhq.com",
		"POST",
		"https://api.ryuhq.com/api/messaging/orgs/org_1/sms",
	],
	[
		"gateway",
		"http://127.0.0.1:7981",
		"POST",
		"http://127.0.0.1:7981/v1/chat/completions",
	],
];

const capabilityRouteCases: [errors.RyuService, string, string, string][] = [
	[
		"passport",
		"https://passport.example.com",
		"POST",
		"https://passport.example.com/v1/connections",
	],
	[
		"passport",
		"https://passport.example.com/base",
		"POST",
		"https://passport.example.com/base/v1/connections/",
	],
	[
		"passport",
		"https://passport.example.com",
		"GET",
		"https://passport.example.com/v1/connections",
	],
	[
		"passport",
		"https://passport.example.com",
		"POST",
		"https://passport.example.com/v1/connections/conn_1/login",
	],
	[
		"passport",
		"https://passport.example.com",
		"POST",
		"https://other.example.com/v1/connections",
	],
	[
		"messaging",
		"https://api.ryuhq.com",
		"PUT",
		"https://api.ryuhq.com/api/messaging/orgs/org_1/settings",
	],
	[
		"messaging",
		"https://api.ryuhq.com",
		"GET",
		"https://api.ryuhq.com/api/messaging/orgs/org_1/settings",
	],
	[
		"messaging",
		"https://api.ryuhq.com",
		"POST",
		"https://api.ryuhq.com/api/messaging/orgs/org_1/settings/webhook-secret/rotate",
	],
	[
		"messaging",
		"https://api.ryuhq.com",
		"DELETE",
		"https://api.ryuhq.com/api/messaging/orgs/org_1/opt-outs/x",
	],
];

function routeVectors(): Json[] {
	const plain = routeCases.map(([service, baseUrl, method, url]) => ({
		input: { service, baseUrl, method, url },
		expected:
			matchRoute(SERVICE_ROUTES[service], baseUrl, method, url)?.path ?? null,
	}));
	const gated = capabilityRouteCases.map(([service, baseUrl, method, url]) => {
		const table = SERVICE_ROUTES[service];
		return {
			input: { service, baseUrl, method, url },
			expected: matchRoute(table, baseUrl, method, url)?.path ?? null,
			expectedCapability:
				matchCapabilityRoute(table, baseUrl, method, url)?.capability ?? null,
			expectedNonReplaySafe:
				matchNonReplaySafeRoute(table, baseUrl, method, url)?.path ?? null,
		};
	});
	return [...plain, ...gated];
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

const STANDARD_SECRET = `whsec_${Buffer.from("ryu-vectors-signing-key-0123456789").toString("base64")}`;
const NOTIFY_SECRET = "notify-destination-secret";

function standardSignature(
	key: Buffer | string,
	id: string,
	timestamp: string,
	body: string
): string {
	return createHmac("sha256", key)
		.update(`${id}.${timestamp}.${body}`)
		.digest("base64");
}

const standardKey = Buffer.from(
	STANDARD_SECRET.slice("whsec_".length),
	"base64"
);
const mailBody = json({
	type: "event",
	event_type: "message.bounced",
	event_id: "evt_mail_1",
	data: { reason: "mailbox full" },
});
const messagingBody = json({
	type: "event",
	event_type: "message.failed",
	event_id: "evt_msg_1",
	data: { message: { id: "msg_1", error: "unreachable" } },
});
const ts = String(NOW_S);
const old = String(NOW_S - 1000);

interface WebhookCase {
	allowBodyOnlySignature?: boolean;
	headers: Record<string, string>;
	kind?: "destination" | "callback";
	name: string;
	payload: string;
	requireTimestamp?: boolean;
	scheme?: "standard" | "legacy";
	/** null stands for an unset env var or binding (undefined / None). */
	secret: string | null;
	toleranceSeconds?: number;
	verifier: "standard" | "mail" | "messaging" | "notify";
}

const notifyDestinationBody = json({
	deliveryId: "dlv_1",
	event: { id: "evt_n_1", title: "Deployed" },
	type: "notification",
});
const notifyCallbackBody = json({
	type: "notification.response",
	eventId: "evt_n_2",
	response: { status: "approved" },
});
const hex = (secret: string, content: string) =>
	createHmac("sha256", secret).update(content).digest("hex");

const webhookCases: WebhookCase[] = [
	{
		name: "mail standard ok",
		verifier: "mail",
		payload: mailBody,
		secret: STANDARD_SECRET,
		headers: {
			"webhook-id": "evt_mail_1",
			"webhook-timestamp": ts,
			"webhook-signature": `v1,${standardSignature(standardKey, "evt_mail_1", ts, mailBody)}`,
		},
	},
	{
		name: "mail rotation list ok",
		verifier: "mail",
		payload: mailBody,
		secret: STANDARD_SECRET,
		headers: {
			"webhook-id": "evt_mail_1",
			"webhook-timestamp": ts,
			"webhook-signature": `v1,AAAA v2,zzz v1,${standardSignature(standardKey, "evt_mail_1", ts, mailBody)}`,
		},
	},
	{
		name: "mail svix aliases ok",
		verifier: "mail",
		payload: mailBody,
		secret: STANDARD_SECRET,
		headers: {
			"svix-id": "evt_mail_1",
			"svix-timestamp": ts,
			"svix-signature": `v1,${standardSignature(standardKey, "evt_mail_1", ts, mailBody)}`,
		},
	},
	{
		name: "mail legacy raw svix ok",
		verifier: "mail",
		scheme: "legacy",
		payload: mailBody,
		secret: STANDARD_SECRET,
		headers: {
			"svix-id": "evt_mail_1",
			"svix-timestamp": ts,
			"svix-signature": `v1,${standardSignature(STANDARD_SECRET, "evt_mail_1", ts, mailBody)}`,
		},
	},
	{
		name: "mail tampered body",
		verifier: "mail",
		payload: mailBody.replace("full", "fine"),
		secret: STANDARD_SECRET,
		headers: {
			"webhook-id": "evt_mail_1",
			"webhook-timestamp": ts,
			"webhook-signature": `v1,${standardSignature(standardKey, "evt_mail_1", ts, mailBody)}`,
		},
	},
	{
		name: "mail old timestamp",
		verifier: "mail",
		payload: mailBody,
		secret: STANDARD_SECRET,
		headers: {
			"webhook-id": "evt_mail_1",
			"webhook-timestamp": old,
			"webhook-signature": `v1,${standardSignature(standardKey, "evt_mail_1", old, mailBody)}`,
		},
	},
	{
		name: "mail old timestamp within custom tolerance",
		verifier: "mail",
		toleranceSeconds: 2000,
		payload: mailBody,
		secret: STANDARD_SECRET,
		headers: {
			"webhook-id": "evt_mail_1",
			"webhook-timestamp": old,
			"webhook-signature": `v1,${standardSignature(standardKey, "evt_mail_1", old, mailBody)}`,
		},
	},
	{
		name: "mail missing headers",
		verifier: "mail",
		payload: mailBody,
		secret: STANDARD_SECRET,
		headers: { "webhook-id": "evt_mail_1" },
	},
	{
		name: "mail bad secret",
		verifier: "mail",
		payload: mailBody,
		secret: "whsec_not base64!",
		headers: {
			"webhook-id": "evt_mail_1",
			"webhook-timestamp": ts,
			"webhook-signature": "v1,AAAA",
		},
	},
	{
		name: "standard non json",
		verifier: "standard",
		payload: "not json",
		secret: STANDARD_SECRET,
		headers: {
			"webhook-id": "x",
			"webhook-timestamp": ts,
			"webhook-signature": `v1,${standardSignature(standardKey, "x", ts, "not json")}`,
		},
	},
	{
		name: "mail wrong envelope",
		verifier: "mail",
		payload: json({ hello: "world" }),
		secret: STANDARD_SECRET,
		headers: {
			"webhook-id": "x",
			"webhook-timestamp": ts,
			"webhook-signature": `v1,${standardSignature(standardKey, "x", ts, json({ hello: "world" }))}`,
		},
	},
	{
		name: "messaging ok",
		verifier: "messaging",
		payload: messagingBody,
		secret: STANDARD_SECRET,
		headers: {
			"webhook-id": "evt_msg_1",
			"webhook-timestamp": ts,
			"webhook-signature": `v1,${standardSignature(standardKey, "evt_msg_1", ts, messagingBody)}`,
		},
	},
	{
		name: "messaging missing resource",
		verifier: "messaging",
		payload: json({
			type: "event",
			event_type: "message.failed",
			event_id: "e",
			data: {},
		}),
		secret: STANDARD_SECRET,
		headers: {
			"webhook-id": "e",
			"webhook-timestamp": ts,
			"webhook-signature": `v1,${standardSignature(standardKey, "e", ts, json({ type: "event", event_type: "message.failed", event_id: "e", data: {} }))}`,
		},
	},
	{
		name: "notify destination standard ok",
		verifier: "notify",
		kind: "destination",
		payload: notifyDestinationBody,
		secret: NOTIFY_SECRET,
		headers: {
			"webhook-id": "dlv_1",
			"webhook-timestamp": ts,
			"webhook-signature": `v1,${standardSignature(NOTIFY_SECRET, "dlv_1", ts, notifyDestinationBody)}`,
			"x-ryu-notify-event": "evt_n_1",
		},
	},
	{
		name: "notify destination id mismatch",
		verifier: "notify",
		kind: "destination",
		payload: notifyDestinationBody,
		secret: NOTIFY_SECRET,
		headers: {
			"webhook-id": "dlv_2",
			"webhook-timestamp": ts,
			"webhook-signature": `v1,${standardSignature(NOTIFY_SECRET, "dlv_2", ts, notifyDestinationBody)}`,
		},
	},
	{
		name: "notify destination partial headers",
		verifier: "notify",
		kind: "destination",
		payload: notifyDestinationBody,
		secret: NOTIFY_SECRET,
		headers: {
			"webhook-id": "dlv_1",
			"x-ryu-notify-signature": `sha256=${hex(NOTIFY_SECRET, notifyDestinationBody)}`,
		},
	},
	{
		name: "notify destination legacy body-only refused by default",
		verifier: "notify",
		kind: "destination",
		payload: notifyDestinationBody,
		secret: NOTIFY_SECRET,
		headers: {
			"x-ryu-notify-signature": `sha256=${hex(NOTIFY_SECRET, notifyDestinationBody)}`,
		},
	},
	{
		name: "notify destination legacy body-only ok when requireTimestamp is false",
		verifier: "notify",
		kind: "destination",
		requireTimestamp: false,
		payload: notifyDestinationBody,
		secret: NOTIFY_SECRET,
		headers: {
			"x-ryu-notify-signature": `sha256=${hex(NOTIFY_SECRET, notifyDestinationBody)}`,
		},
	},
	{
		name: "notify destination legacy body-only ok",
		verifier: "notify",
		kind: "destination",
		allowBodyOnlySignature: true,
		payload: notifyDestinationBody,
		secret: NOTIFY_SECRET,
		headers: {
			"x-ryu-notify-signature": `SHA256=${hex(NOTIFY_SECRET, notifyDestinationBody).toUpperCase()}`,
		},
	},
	{
		name: "notify destination legacy refused by requireTimestamp",
		verifier: "notify",
		kind: "destination",
		allowBodyOnlySignature: true,
		requireTimestamp: true,
		payload: notifyDestinationBody,
		secret: NOTIFY_SECRET,
		headers: {
			"x-ryu-notify-signature": `sha256=${hex(NOTIFY_SECRET, notifyDestinationBody)}`,
		},
	},
	{
		name: "notify destination plain text ok",
		verifier: "notify",
		kind: "destination",
		allowBodyOnlySignature: true,
		payload: "Deployed",
		secret: NOTIFY_SECRET,
		headers: {
			"x-ryu-notify-signature": `sha256=${hex(NOTIFY_SECRET, "Deployed")}`,
		},
	},
	{
		name: "notify destination tampered header",
		verifier: "notify",
		kind: "destination",
		allowBodyOnlySignature: true,
		payload: notifyDestinationBody,
		secret: NOTIFY_SECRET,
		headers: {
			"x-ryu-notify-signature": `sha256=${hex(NOTIFY_SECRET, notifyDestinationBody)}`,
			"x-ryu-notify-delivery": "dlv_other",
		},
	},
	{
		name: "notify callback ok",
		verifier: "notify",
		kind: "callback",
		payload: notifyCallbackBody,
		secret: NOTIFY_SECRET,
		headers: {
			"x-ryu-notify-timestamp": ts,
			"x-ryu-notify-signature": `sha256=${hex(NOTIFY_SECRET, `${ts}.${notifyCallbackBody}`)}`,
		},
	},
	{
		name: "notify callback missing timestamp",
		verifier: "notify",
		kind: "callback",
		payload: notifyCallbackBody,
		secret: NOTIFY_SECRET,
		headers: {
			"x-ryu-notify-signature": `sha256=${hex(NOTIFY_SECRET, notifyCallbackBody)}`,
		},
	},
	{
		name: "notify callback old",
		verifier: "notify",
		kind: "callback",
		payload: notifyCallbackBody,
		secret: NOTIFY_SECRET,
		headers: {
			"x-ryu-notify-timestamp": old,
			"x-ryu-notify-signature": `sha256=${hex(NOTIFY_SECRET, `${old}.${notifyCallbackBody}`)}`,
		},
	},
	{
		name: "notify empty secret",
		verifier: "notify",
		kind: "destination",
		payload: notifyDestinationBody,
		secret: "",
		headers: { "x-ryu-notify-signature": "sha256=00" },
	},
	{
		name: "mail unset secret",
		verifier: "mail",
		payload: mailBody,
		secret: null,
		headers: {
			"webhook-id": "evt_mail_1",
			"webhook-timestamp": ts,
			"webhook-signature": `v1,${standardSignature(standardKey, "evt_mail_1", ts, mailBody)}`,
		},
	},
	{
		name: "mail unset secret reported before missing headers",
		verifier: "mail",
		payload: mailBody,
		secret: null,
		headers: {},
	},
	{
		name: "messaging unset secret",
		verifier: "messaging",
		payload: messagingBody,
		secret: null,
		headers: {
			"webhook-id": "evt_msg_1",
			"webhook-timestamp": ts,
			"webhook-signature": `v1,${standardSignature(standardKey, "evt_msg_1", ts, messagingBody)}`,
		},
	},
	{
		name: "notify destination unset secret reported before missing headers",
		verifier: "notify",
		kind: "destination",
		payload: notifyDestinationBody,
		secret: null,
		headers: {},
	},
	{
		name: "notify callback unset secret reported before missing headers",
		verifier: "notify",
		kind: "callback",
		payload: notifyCallbackBody,
		secret: null,
		headers: {},
	},
];

async function webhookVectors(): Promise<Json[]> {
	const out: Json[] = [];
	const now = new Date(NOW_MS);
	for (const item of webhookCases) {
		const common = {
			headers: item.headers,
			now,
			payload: item.payload,
			// An unset binding arrives as undefined at runtime.
			secret: (item.secret ?? undefined) as string,
			toleranceSeconds: item.toleranceSeconds,
		};
		try {
			let result: unknown;
			if (item.verifier === "mail") {
				result = await verifyMailWebhook({ ...common, scheme: item.scheme });
			} else if (item.verifier === "messaging") {
				result = await verifyMessagingWebhook(common);
			} else if (item.verifier === "standard") {
				result = await verifyStandardWebhook({
					...common,
					scheme: item.scheme,
				});
			} else {
				result = await verifyNotifyWebhook({
					...common,
					kind: item.kind ?? "destination",
					allowBodyOnlySignature: item.allowBodyOnlySignature,
					requireTimestamp: item.requireTimestamp,
				});
			}
			out.push({
				input: { ...item, now: NOW_S } as unknown as Json,
				expected: result as Json,
			});
		} catch (error) {
			out.push({
				input: { ...item, now: NOW_S } as unknown as Json,
				error: (error as errors.RyuError).code,
			});
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Facade surface: every ryu.<ns>.<path> the TypeScript namespaces expose
// ---------------------------------------------------------------------------

const NAMESPACE_DIRS = [
	"managed-agents",
	"messaging",
	"mail",
	"notify",
	"box",
	"gateway",
	"connect",
	"passport",
	"sites",
];
const SKIPPED_MEMBERS = new Set([
	"constructor",
	"length",
	"name",
	"prototype",
	"caller",
	"arguments",
	"transport",
	"options",
]);

function walkSurface(
	target: object,
	prefix: string,
	out: Set<string>,
	depth: number
): void {
	if (depth > 4) {
		return;
	}
	const seen = new Set<string>();
	for (
		let proto: object | null = target;
		proto && proto !== Object.prototype && proto !== Function.prototype;
		proto = Object.getPrototypeOf(proto)
	) {
		for (const name of Object.getOwnPropertyNames(proto)) {
			if (SKIPPED_MEMBERS.has(name) || seen.has(name)) {
				continue;
			}
			seen.add(name);
			const value = (target as Record<string, unknown>)[name];
			if (typeof value === "function") {
				out.add(`${prefix}${name}`);
				walkSurface(value, `${prefix}${name}.`, out, depth + 1);
			} else if (value !== null && typeof value === "object") {
				walkSurface(value, `${prefix}${name}.`, out, depth + 1);
			}
		}
	}
}

async function facadeSurface(): Promise<string[]> {
	const services = await import("../../../../packages/services/src/index.ts");
	const env = Object.fromEntries(
		config.ENV_VARS.filter((row) => row.name !== "RYU_MAIL_API_KEY").map(
			(row) => [
				row.name,
				row.role === "url"
					? `https://${row.service.toLowerCase()}.example.com`
					: "vectors-key",
			]
		)
	);
	const out = new Set<string>();
	for (const dir of NAMESPACE_DIRS) {
		const module = (await import(
			`../../../../packages/services/src/${dir}/namespace.ts`
		)) as Record<string, unknown>;
		// Flat `@ryuhq/client` names kept as deprecated aliases are not canonical.
		const flat = new Set<string>(dir === "mail" ? ["sendFromInbox"] : []);
		const topLevel = new Set<string>();
		for (const [name, value] of Object.entries(module)) {
			if (
				name.endsWith("_CANONICAL_METHODS") &&
				value &&
				typeof value === "object" &&
				!Array.isArray(value)
			) {
				for (const method of Object.values(value as Record<string, string>)) {
					// `ryu.mail.send` is the facade's own top-level send, not the flat alias.
					if (!(dir === "mail" && method === "send")) {
						flat.add(method);
					}
				}
			}
			if (name.endsWith("_TOP_LEVEL_METHODS") && Array.isArray(value)) {
				for (const method of value as string[]) {
					topLevel.add(method);
				}
			}
		}
		for (const value of Object.values(module)) {
			const definition = value as { create?: unknown; service?: unknown };
			if (
				typeof definition?.create !== "function" ||
				typeof definition.service !== "string"
			) {
				continue;
			}
			const service = definition.service as errors.RyuService;
			const resolved = services.resolveServiceConfig(
				service,
				{},
				createEnvReader(env)
			);
			const client = (definition.create as (...args: unknown[]) => object)(
				resolved,
				() => Promise.reject(new Error("no request")),
				{}
			);
			const paths = new Set<string>();
			walkSurface(client, "", paths, 0);
			for (const path of paths) {
				const head = path.split(".")[0] ?? path;
				if (flat.has(head) && !topLevel.has(head) && !path.includes(".")) {
					continue;
				}
				out.add(`${service}.${path}`);
			}
		}
	}
	return [...out].sort();
}

// ---------------------------------------------------------------------------
// Managed Agents tool approvals
// ---------------------------------------------------------------------------

function toolApprovalVectors(): Json {
	const keyCases: [string, "allow" | "deny", string | null][] = [
		["toolu_0123456789", "allow", null],
		["toolu_0123456789", "deny", "Not now"],
		["toolu_0123456789", "allow", ""],
		["toolu_0123456789", "deny", "Nicht jetzt \u2014 sp\u00e4ter \u{1f642}"],
		["x", "deny", null],
		["bad id/with slash", "allow", null],
		["t".repeat(120), "allow", "too long once hashed"],
	];
	const request = (seq: number, toolUseId: string) => ({
		seq,
		type: "agent.tool_approval_request",
		toolUseId,
	});
	const interrupted = (seq: number, inputSeq: number | null) => ({
		seq,
		type: "session.status",
		status: "idle",
		stopReason: "interrupted",
		inputSeq,
		pendingToolUseIds: [],
	});
	const logs: Record<string, unknown>[][] = [
		[request(3, "toolu_1"), request(4, "toolu_2")],
		[
			request(3, "toolu_1"),
			request(4, "toolu_2"),
			{ seq: 5, type: "user.tool_approval", toolUseId: "toolu_1" },
		],
		[request(3, "toolu_1"), { seq: 4, type: "user.interrupt" }],
		[
			request(3, "toolu_1"),
			{ seq: 4, type: "user.interrupt" },
			interrupted(5, 4),
		],
		[
			request(3, "toolu_1"),
			{ seq: 4, type: "user.interrupt" },
			interrupted(5, 2),
		],
		[request(3, "toolu_1"), interrupted(4, null)],
		[
			request(3, "toolu_1"),
			{ seq: 4, type: "user.interrupt" },
			interrupted(5, null),
		],
		[request(9, "toolu_9"), request(3, "toolu_3")],
	];
	return {
		eventTypes: [...TOOL_APPROVAL_EVENT_TYPES],
		keys: keyCases.map(([toolUseId, decision, message]) => ({
			toolUseId,
			decision,
			message,
			expected:
				toolApprovalIdempotencyKey(toolUseId, decision, message) ?? null,
		})),
		pending: logs.map((events) => ({
			events: events as Json,
			expected: pendingToolApprovals(
				events as unknown as ManagedAgentEvent[]
			).map((event) => event.toolUseId),
		})),
	};
}

// ---------------------------------------------------------------------------
// Gateway upstream status
// ---------------------------------------------------------------------------

const gatewayBodies: Json[] = [
	{ error: { code: "provider_error", upstream_status: 400 } },
	{ error: { code: "provider_error", upstream_status: 404 } },
	{ error: { code: "provider_error", upstream_status: 408 } },
	{ error: { code: "provider_error", upstream_status: 425 } },
	{ error: { code: "provider_error", upstream_status: 429 } },
	{ error: { code: "provider_error", upstream_status: 451 } },
	{ error: { code: "provider_error", upstream_status: 500 } },
	{ error: { code: "provider_error", upstream_status: 599 } },
	{ error: { code: "provider_error", upstream_status: 600 } },
	{ error: { code: "provider_error", upstream_status: 399 } },
	{ error: { code: "provider_error", upstream_status: 404.5 } },
	{ error: { code: "provider_error", upstream_status: "404" } },
	{ error: { code: "provider_error", upstream_status: true } },
	{ error: { code: "provider_error" } },
	{ error: "provider_error" },
	[],
	null,
];

function gatewayUpstreamVectors(): Json[] {
	return gatewayBodies.map((body) => {
		const base = errors.createRyuError({
			code: "provider_error",
			details: { provider: "openai" },
			message: "upstream failed",
			service: "gateway",
			status: 502,
		});
		const refined = refineGatewayError(base, body);
		return {
			body,
			expected: {
				details: (refined.details ?? null) as Json,
				retryable: refined.retryable,
				upstreamStatus: gatewayUpstreamStatus(body),
			},
		};
	});
}

// ---------------------------------------------------------------------------
// Error classes by status and code
// ---------------------------------------------------------------------------

/**
 * `createRyuError` / `copyRyuError`: the subclass picked for a status and code.
 * Every status-0 code the table names is listed so the two tables cannot drift.
 */
const errorClassCases: [number, string][] = [
	[0, "aborted"],
	[0, "configuration_error"],
	[0, "connection_error"],
	[0, "invalid_id"],
	[0, "invalid_response"],
	[0, "timeout"],
	[0, "unknown_code"],
	[302, "redirect"],
	[400, "redirect_refused"],
	[400, "invalid_request"],
	[401, "unauthorized"],
	[402, "quota_exceeded"],
	[404, "not_found"],
	[409, "idempotency_conflict"],
	[422, "validation_error"],
	[429, "rate_limited"],
	[500, "internal_error"],
	[503, "unavailable"],
];

function errorClassVectors(): Json[] {
	return errorClassCases.map(([status, code]) => {
		const created = errors.createRyuError({
			code,
			message: "vector",
			service: "box",
			status,
		});
		const copied = errors.copyRyuError(created, { hint: "Try again." });
		return { code, created: created.name, copied: copied.name, status };
	});
}

// ---------------------------------------------------------------------------
// Hosted Mail realtime tickets
// ---------------------------------------------------------------------------

const REALTIME_TICKET = "mrt_2r7Yf0kQ6bWm9pXcJ3hT1sLeAa8uVnZg4oDiRyKqE5w";
const realtimeTicketCases: { env: Record<string, string>; reply: Json }[] = [
	{
		env: { RYU_API_KEY: "ryu_vectors", RYU_ORGANIZATION_ID: "org_1" },
		reply: {
			ticket: REALTIME_TICKET,
			expiresAt: "2026-10-23T12:00:30.000Z",
			expiresIn: 30,
			path: "/api/mail/realtime",
			protocols: ["ryu-mail.v1", `ryu-ticket.${REALTIME_TICKET}`],
		},
	},
	{
		// Unknown keys are dropped; snake_case is read as a fallback.
		env: { RYU_MAIL_GATEWAY_KEY: "rgw_vectors" },
		reply: {
			ticket: REALTIME_TICKET,
			expires_at: "2026-10-23T12:00:30.000Z",
			expires_in: 30,
			protocols: ["ryu-mail.v1", `ryu-ticket.${REALTIME_TICKET}`],
			extra: "dropped",
		},
	},
];

/** What `ryu.mail.createRealtimeTicket()` decodes from each reply. */
async function mailRealtimeTicketVectors(): Promise<Json[]> {
	const out: Json[] = [];
	for (const { env, reply } of realtimeTicketCases) {
		const ryu = new Ryu({
			env,
			fetch: () => Promise.resolve(Response.json(reply, { status: 201 })),
		});
		const expected = await ryu.mail.createRealtimeTicket();
		out.push({ env, reply, expected: { ...expected } });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Mail list limits (drafts, events, webhook deliveries)
// ---------------------------------------------------------------------------

/**
 * Each case names a Mail list call and its arguments in TypeScript form;
 * Python takes the same values as `limit=` / `event_type=` keywords. The
 * limit `"NaN"` stands for the number NaN, which JSON cannot hold.
 */
const mailListLimitCases: {
	call: "drafts.list" | "events.list" | "webhooks.deliveries.list";
	id: string | null;
	eventType: string | null;
	limit: number | boolean | "NaN" | null;
}[] = [
	{ call: "drafts.list", id: "inbox_1", eventType: null, limit: null },
	{ call: "drafts.list", id: "inbox_1", eventType: null, limit: 25 },
	{ call: "events.list", id: null, eventType: null, limit: null },
	{ call: "events.list", id: null, eventType: null, limit: 5 },
	{ call: "events.list", id: null, eventType: "message.received", limit: 10 },
	{ call: "events.list", id: "inbox_1", eventType: null, limit: 500 },
	// The inbox route takes no event type; only the limit is sent.
	{
		call: "events.list",
		id: "inbox_1",
		eventType: "message.received",
		limit: 3,
	},
	{
		call: "webhooks.deliveries.list",
		id: "wh_1",
		eventType: null,
		limit: null,
	},
	{
		call: "webhooks.deliveries.list",
		id: "wh_1",
		eventType: null,
		limit: 1000,
	},
	// A limit that is not a positive integer is refused before any request.
	{ call: "drafts.list", id: "inbox_1", eventType: null, limit: 0 },
	{ call: "drafts.list", id: "inbox_1", eventType: null, limit: -1 },
	{ call: "drafts.list", id: "inbox_1", eventType: null, limit: 2.5 },
	{ call: "drafts.list", id: "inbox_1", eventType: null, limit: "NaN" },
	{ call: "drafts.list", id: "inbox_1", eventType: null, limit: true },
	{ call: "events.list", id: null, eventType: null, limit: 0 },
	{ call: "events.list", id: "inbox_1", eventType: null, limit: -1 },
	{
		call: "webhooks.deliveries.list",
		id: "wh_1",
		eventType: null,
		limit: 2.5,
	},
	{
		call: "webhooks.deliveries.list",
		id: "wh_1",
		eventType: null,
		limit: "NaN",
	},
	// An empty id is refused, never read as "every inbox".
	{ call: "events.list", id: "", eventType: null, limit: 3 },
	{ call: "events.list", id: "", eventType: null, limit: null },
	{ call: "drafts.list", id: "", eventType: null, limit: 3 },
	// The id is checked before the limit.
	{ call: "events.list", id: "", eventType: null, limit: 0 },
];

/** The path and query each Mail list call sends, or the code that refused it. */
async function mailListLimitVectors(): Promise<Json[]> {
	const out: Json[] = [];
	for (const item of mailListLimitCases) {
		let sent: string | null = null;
		const ryu = new Ryu({
			env: { RYU_MAIL_GATEWAY_KEY: "rgw_vectors" },
			fetch: (input) => {
				const url = new URL(String(input));
				sent = `${url.pathname}${url.search}`;
				return Promise.resolve(
					Response.json({ drafts: [], events: [], deliveries: [] })
				);
			},
			maxRetries: 0,
			result: "object",
		});
		const limit = (item.limit === "NaN" ? Number.NaN : item.limit) as number;
		const query = item.limit === null ? undefined : { limit };
		let result: { error: { code: string } | null };
		if (item.call === "drafts.list") {
			result = await ryu.mail.drafts.list(item.id ?? "", query);
		} else if (item.call === "webhooks.deliveries.list") {
			result = await ryu.mail.webhooks.deliveries.list(item.id ?? "", query);
		} else {
			result = await ryu.mail.events.list(
				item.id ?? undefined,
				item.eventType ?? undefined,
				query
			);
		}
		out.push({ ...item, path: sent, error: result.error?.code ?? null });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Notify topic header text (RFC 2047)
// ---------------------------------------------------------------------------

const NOTIFY_HEADER_TEXTS = [
	"Deploy finished",
	"Déploiement",
	"部署完成 ✅",
	"=?UTF-8?B?aGk=?=",
	"=?ISO-8859-1?Q?caf=E9?=",
	"Price =?x?Q?y?=",
	"部署 =?UTF-8?B?aGk=?=",
	"a=?b",
	"a\nb",
	"部署\n完成",
	"a\u0000b",
	"a\ud800b",
];

/** The raw `Title` header `ryu.notify.topics.publish` sends, or `null` when it is refused. */
async function notifyHeaderVectors(): Promise<Json[]> {
	const out: Json[] = [];
	for (const title of NOTIFY_HEADER_TEXTS) {
		let header: string | null = null;
		const ryu = new Ryu({
			env: { RYU_NOTIFY_API_KEY: "n" },
			fetch: (_input, init) => {
				header = new Headers(init?.headers).get("title");
				return Promise.resolve(
					Response.json(
						{ error: { code: "stop", message: "stop" } },
						{ status: 400 }
					)
				);
			},
			maxRetries: 0,
		});
		await ryu.notify.topics
			.publish("alerts", "hi", { title })
			.catch(() => null);
		out.push({ title, header });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Messaging organization ids in org-scoped paths
// ---------------------------------------------------------------------------

const MESSAGING_ORG_IDS = ["org_1", ".", "..", "a..b", "a b", "../x"];

/**
 * The path `ryu.messaging.numbers.list()` sends for each organization id, or
 * the error code it refuses with before any request.
 */
async function messagingOrgIdVectors(): Promise<Json[]> {
	const out: Json[] = [];
	for (const organizationId of MESSAGING_ORG_IDS) {
		let path: string | null = null;
		const ryu = new Ryu({
			apiKey: "ryu_x",
			baseUrl: "https://api.example",
			fetch: (input) => {
				path = new URL(String(input)).pathname;
				return Promise.resolve(Response.json({ numbers: [] }));
			},
			maxRetries: 0,
			organizationId,
		});
		const { error } = await ryu.safe.messaging.numbers.list();
		out.push({
			organizationId,
			path,
			error: error ? { code: error.code, errorClass: error.name } : null,
		});
	}
	return out;
}

/** `messageWithHint` / `messageWithoutHint`: the message a RyuError ends up with. */
function messageHintVectors(): Json[] {
	const cases: [string, string | null][] = [
		[
			"Ryu Notify is not configured: set RYU_NOTIFY_API_KEY.",
			"Set RYU_NOTIFY_API_KEY.",
		],
		["bad key", "Check the key."],
		["Slow down!", "Wait."],
		["Too many requests?", "Wait."],
		["", "Check the key."],
		["   ", "Check the key."],
		["bad key  ", "Check the key."],
		["bad key", null],
		["bad key", ""],
		["bad key", "   "],
		["Bad key; check RYU_NOTIFY_API_KEY.", "check RYU_NOTIFY_API_KEY."],
		["Bad key. Hint: Rotate it.", "Rotate it."],
		["bad key", "  Check the key.  "],
		// Only a hint the message ends with is dropped, ignoring a final period.
		["Unauthorized: key", "key"],
		["Unauthorized key supplied", "key"],
		["Check the key. Then retry.", "Check the key."],
		["bad key. Check the key", "Check the key."],
	];
	return cases.map(([message, hint]) => {
		const error = new errors.RyuError({
			service: "notify",
			status: 401,
			code: "unauthenticated",
			message,
			hint,
		});
		return {
			input: { message, hint },
			expected: {
				message: errors.messageWithHint(message, hint),
				errorMessage: error.message,
				withoutHint: errors.messageWithoutHint(error),
				foreignWithoutHint: errors.messageWithoutHint({
					message: error.message,
					hint: error.hint,
				}),
				// A copy given the hinted message back plus a new hint carries only the new one.
				rehinted: errors.withRyuErrorFields(error, {
					message: error.message,
					hint: "Try again later.",
				}).message,
			},
		};
	});
}

// ---------------------------------------------------------------------------
// Sites settings (projects.updateSettings / makePublic)
// ---------------------------------------------------------------------------

const SITES_VECTOR_ENV = {
	RYU_SITES_API_KEY: "s",
	RYU_SITES_URL: "http://localhost:8021",
};
const SITES_VECTOR_SETTINGS = {
	mode: "local",
	audience: "private",
	workspaceId: "ws_1",
	viewers: [],
	editors: [],
	optionalSignIn: false,
	allowRemix: false,
	database: { databaseId: "db_1", spaceId: "space_1" },
	extensions: { connections: [], mcp: false },
};

function sitesVectorSite(revision: number, settings: Json): Json {
	return {
		aliases: [],
		createdAt: "2026-10-22T12:00:00.000Z",
		deploymentId: null,
		domains: [],
		hasPublished: false,
		id: "site_1",
		name: "Launch",
		ownerId: "owner",
		prompt: "",
		revision,
		settings,
		slug: "launch-notes",
		template: "website",
		updatedAt: "2026-10-22T12:00:00.000Z",
		versions: [],
	};
}

const PUBLIC_DISABLED_REPLY = {
	status: 403,
	body: {
		error: {
			code: "policy_denied",
			message: "Public publishing is disabled by the operator",
		},
	},
};

interface SitesSettingsCase {
	call: "updateSettings" | "makePublic";
	expectedRevision?: number;
	name: string;
	patch?: Json;
	/** The PUT reply; absent: 200 with the sent settings at revision + 1. */
	put?: { body: Json; status: number };
	stored?: Json;
}

const sitesSettingsCases: SitesSettingsCase[] = [
	{
		name: "patch laid over the stored settings",
		call: "updateSettings",
		patch: {
			audience: "invited",
			viewers: ["ada@example.com"],
			workspaceId: null,
		},
	},
	{
		name: "pinned stale revision",
		call: "updateSettings",
		patch: { allowRemix: true },
		expectedRevision: 1,
		put: {
			status: 409,
			body: { error: { code: "conflict", message: "Site changed." } },
		},
	},
	{ name: "make public", call: "makePublic" },
	{
		name: "make public refused",
		call: "makePublic",
		put: PUBLIC_DISABLED_REPLY,
	},
	{
		name: "stored public refused without an audience",
		call: "updateSettings",
		patch: { allowRemix: true },
		stored: { ...SITES_VECTOR_SETTINGS, audience: "public" },
		put: PUBLIC_DISABLED_REPLY,
	},
	{
		name: "configuration refusal is not retried",
		call: "updateSettings",
		patch: { audience: "invited" },
		put: {
			status: 503,
			body: {
				error: {
					code: "unavailable",
					message:
						"Connect platform identity before enabling sharing or sign-in",
				},
			},
		},
	},
	{ name: "null audience", call: "updateSettings", patch: { audience: null } },
	{ name: "empty patch", call: "updateSettings", patch: {} },
	{
		name: "managed setting",
		call: "updateSettings",
		patch: { database: null },
	},
];

/** The requests `projects.updateSettings()` / `makePublic()` send and what they resolve to. */
async function sitesSettingsVectors(): Promise<Json[]> {
	const out: Json[] = [];
	for (const item of sitesSettingsCases) {
		const stored = item.stored ?? SITES_VECTOR_SETTINGS;
		const requests: Json[] = [];
		const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			const body =
				typeof init?.body === "string" ? (JSON.parse(init.body) as Json) : null;
			const method = init?.method ?? "GET";
			requests.push({ method, path: url.pathname, body });
			if (method === "GET") {
				return Promise.resolve(Response.json(sitesVectorSite(2, stored)));
			}
			if (item.put) {
				return Promise.resolve(
					Response.json(item.put.body, { status: item.put.status })
				);
			}
			const sent = body as { settings: Json };
			return Promise.resolve(Response.json(sitesVectorSite(3, sent.settings)));
		};
		const ryu = new Ryu({ env: SITES_VECTOR_ENV, fetch });
		const options =
			item.expectedRevision === undefined
				? {}
				: { expectedRevision: item.expectedRevision };
		let outcome: Json;
		try {
			const project =
				item.call === "makePublic"
					? await ryu.sites.projects.makePublic("site_1", options)
					: await ryu.sites.projects.updateSettings(
							"site_1",
							item.patch as Parameters<
								typeof ryu.sites.projects.updateSettings
							>[1],
							options
						);
			outcome = {
				revision: project.revision,
				settings: project.settings as unknown as Json,
			};
		} catch (error) {
			if (!errors.isRyuError(error)) {
				throw error;
			}
			outcome = {
				error: {
					code: error.code,
					details: error.details as Json,
					hint: error.hint,
					retryable: error.retryable,
					status: error.status,
				},
			};
		}
		out.push({
			name: item.name,
			call: item.call,
			patch: item.patch ?? null,
			expectedRevision: item.expectedRevision ?? null,
			stored,
			put: item.put ?? null,
			requests,
			outcome,
		});
	}
	return out;
}

// Passport reply decoding: each body run through the passport/client.ts Zod
// schema its route decodes with. The Python validators in
// ryu_sdk/services/passport.py must accept and refuse the same bodies, and the
// hand-written malformed-reply table in test_services_namespaces.py must be a
// subset of the refused bodies here, so a schema change fails CI.
const PASSPORT_SCHEMAS = {
	capabilities: passportCapabilitiesSchema,
	connectionList: passportConnectionListSchema,
	createdConnection: passportCreatedConnectionSchema,
	deletedConnection: passportDeletedConnectionSchema,
	fetchResult: passportFetchResultSchema,
	loginFlow: passportLoginFlowSchema,
	profileList: passportProfileListSchema,
	usageReport: passportUsageReportSchema,
} as const;

const PASSPORT_VECTOR_CONNECTION = {
	created_at: 1_760_000_000,
	domain: "github.com",
	flow_status: "IDLE",
	id: "conn_0123456789abcdef",
	last_checked: 0,
	profile_id: "work",
	source: "manual",
	status: "NEEDS_AUTH",
	updated_at: 1_760_000_000,
};
const PASSPORT_VECTOR_FETCH = {
	authenticated: true,
	content: "{}",
	status: 200,
	truncated: false,
};
const PASSPORT_VECTOR_USAGE = {
	from: "a",
	meters: { connectionSeconds: 1, fetches: 2 },
	ok: true,
	to: "b",
	type: "passport.usage",
};

const passportReplyCases: [keyof typeof PASSPORT_SCHEMAS, Json][] = [
	["connectionList", { connections: [PASSPORT_VECTOR_CONNECTION] }],
	["connectionList", { connections: [], extra: { kept: true } }],
	[
		"connectionList",
		{ connections: [{ ...PASSPORT_VECTOR_CONNECTION, status: "SIGNED_IN" }] },
	],
	[
		"connectionList",
		{ connections: [{ ...PASSPORT_VECTOR_CONNECTION, flow_status: "DONE?" }] },
	],
	["connectionList", { connections: { id: "conn_1" } }],
	["connectionList", {}],
	["connectionList", []],
	["connectionList", null],
	[
		"connectionList",
		{ connections: [{ ...PASSPORT_VECTOR_CONNECTION, last_checked: true }] },
	],
	["connectionList", { connections: [null] }],
	["createdConnection", { connection: PASSPORT_VECTOR_CONNECTION }],
	[
		"createdConnection",
		{ connection: { ...PASSPORT_VECTOR_CONNECTION, domain: null } },
	],
	["createdConnection", { id: "conn_1" }],
	["deletedConnection", { deleted: true, id: "conn_1" }],
	["deletedConnection", { deleted: "yes", id: "conn_1" }],
	["deletedConnection", { deleted: true }],
	[
		"loginFlow",
		{
			flow_id: "flow_1",
			kind: { kind: "hosted", url: "https://passport.example.com/flow/1" },
		},
	],
	["loginFlow", { flow_id: "flow_1", kind: { kind: "manual", note: "x" } }],
	["loginFlow", { flow_id: "flow_1", kind: { kind: "hosted" } }],
	["loginFlow", { flow_id: "flow_1", kind: { kind: "device" } }],
	["loginFlow", { flow_id: "flow_1", kind: "manual" }],
	["loginFlow", { kind: { kind: "manual" } }],
	["fetchResult", PASSPORT_VECTOR_FETCH],
	[
		"fetchResult",
		{ ...PASSPORT_VECTOR_FETCH, wwwAuthenticate: ['Bearer realm="api"'] },
	],
	["fetchResult", { ...PASSPORT_VECTOR_FETCH, status: "200" }],
	["fetchResult", { ...PASSPORT_VECTOR_FETCH, wwwAuthenticate: null }],
	["fetchResult", { ...PASSPORT_VECTOR_FETCH, wwwAuthenticate: [1] }],
	["fetchResult", { status: 200, content: "{}" }],
	["fetchResult", { ...PASSPORT_VECTOR_FETCH, truncated: 0 }],
	[
		"profileList",
		{
			profiles: [
				{ profile_id: "work", connections: [PASSPORT_VECTOR_CONNECTION] },
			],
		},
	],
	["profileList", { profiles: [] }],
	["profileList", { profiles: [{ profile_id: "work" }] }],
	["profileList", { profiles: [{ profile_id: 1, connections: [] }] }],
	[
		"profileList",
		{ profiles: [{ profile_id: "work", connections: [{ id: "conn_1" }] }] },
	],
	["profileList", { profiles: ["work"] }],
	["profileList", { profiles: null }],
	[
		"capabilities",
		{
			api_version: "v1",
			service: "passport",
			features: { idempotency_keys: true },
		},
	],
	[
		"capabilities",
		{
			api_version: "v1",
			service: "passport",
			features: { idempotency_keys: "true" },
		},
	],
	["capabilities", { api_version: "v1", features: {} }],
	["usageReport", PASSPORT_VECTOR_USAGE],
	["usageReport", { ...PASSPORT_VECTOR_USAGE, meters: { fetches: 2 } }],
	["usageReport", { ...PASSPORT_VECTOR_USAGE, ok: "true" }],
	["usageReport", []],
];

function passportReplyVectors(): Json[] {
	return passportReplyCases.map(([schema, body]) => ({
		schema,
		body,
		accepted: PASSPORT_SCHEMAS[schema].safeParse(body).success,
	}));
}

const vectors = {
	generatedBy: "bindings/python/tests/fixtures/services_vectors.ts",
	constants,
	errors: await errorVectors(),
	managedAgentsErrors: await managedAgentsErrorVectors(),
	retry: retryVectors(),
	headers: headerVectors(),
	config: configVectors(),
	routes: routeVectors(),
	gatewayUpstream: gatewayUpstreamVectors(),
	errorClassFor: errorClassVectors(),
	webhooks: await webhookVectors(),
	surface: await facadeSurface(),
	toolApprovals: toolApprovalVectors(),
	mailRealtimeTickets: await mailRealtimeTicketVectors(),
	mailListLimits: await mailListLimitVectors(),
	notifyHeaderText: await notifyHeaderVectors(),
	messagingOrgIds: await messagingOrgIdVectors(),
	messageHints: messageHintVectors(),
	sitesSettings: await sitesSettingsVectors(),
	passportReplies: passportReplyVectors(),
};

process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);
