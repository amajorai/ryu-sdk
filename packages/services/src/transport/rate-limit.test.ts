import { describe, expect, test } from "bun:test";
import {
	formatRateLimit,
	formatRateLimitPolicy,
	withAuthRateLimitHeaders,
} from "../../../../apps/server/src/rate-limit-headers.ts";
import {
	parseRateLimit,
	parseRateLimitPolicy,
	parseRetryAfter,
	readRateLimit,
} from "./rate-limit.ts";

describe("RateLimit fields round-trip from apps/server", () => {
	test("formatRateLimitPolicy -> parseRateLimitPolicy", () => {
		const header = formatRateLimitPolicy({
			max: 3,
			name: "auth-credentials",
			window: 10,
		});
		expect(parseRateLimitPolicy(header)).toEqual([
			{ policy: "auth-credentials", quota: 3, windowSeconds: 10 },
		]);
	});

	test("formatRateLimit -> parseRateLimit, including names that need escaping", () => {
		const header = formatRateLimit('we"ird\\name', 0, 12.2);
		expect(parseRateLimit(header)).toEqual([
			{ policy: 'we"ird\\name', remaining: 0, resetSeconds: 13 },
		]);
	});

	test("a throttled auth response reads as remaining 0 with its policy", () => {
		const response = withAuthRateLimitHeaders(
			new Response(null, { headers: { "X-Retry-After": "9" }, status: 429 }),
			{ max: 3, name: "auth-email", window: 60 }
		);
		expect(readRateLimit(response.headers)).toEqual({
			limit: 3,
			policy: "auth-email",
			remaining: 0,
			resetSeconds: 9,
			windowSeconds: 60,
		});
		expect(parseRetryAfter(response.headers.get("Retry-After"))).toBe(9);
	});

	test("several items, tokens and unknown parameters are tolerated", () => {
		expect(parseRateLimit('"day";r=900;t=3600;x="y", burst;r=0;t=2')).toEqual([
			{ policy: "day", remaining: 900, resetSeconds: 3600 },
			{ policy: "burst", remaining: 0, resetSeconds: 2 },
		]);
		const headers = new Headers({
			RateLimit: '"burst";r=0;t=2',
			"RateLimit-Policy": '"day";q=1000;w=86400, "burst";q=10;w=1',
		});
		expect(readRateLimit(headers)).toEqual({
			limit: 10,
			policy: "burst",
			remaining: 0,
			resetSeconds: 2,
			windowSeconds: 1,
		});
	});

	test("garbage and absence give empty results", () => {
		expect(parseRateLimit(null)).toEqual([]);
		expect(parseRateLimit(";;,")).toEqual([]);
		expect(parseRateLimit('"p";r=abc')).toEqual([
			{ policy: "p", remaining: null, resetSeconds: null },
		]);
		expect(readRateLimit(new Headers())).toBeNull();
	});

	test("a policy-only response still reports the limit", () => {
		expect(
			readRateLimit(new Headers({ "RateLimit-Policy": '"auth";q=100;w=60' }))
		).toEqual({
			limit: 100,
			policy: "auth",
			remaining: null,
			resetSeconds: null,
			windowSeconds: 60,
		});
	});
});

describe("parseRetryAfter", () => {
	test("delta-seconds", () => {
		expect(parseRetryAfter("120")).toBe(120);
		expect(parseRetryAfter(" 0 ")).toBe(0);
	});

	test("HTTP-date", () => {
		const now = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
		expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:30 GMT", now)).toBe(30);
		expect(parseRetryAfter("Wed, 21 Oct 2026 07:27:00 GMT", now)).toBe(0);
	});

	test("absent or invalid", () => {
		expect(parseRetryAfter(null)).toBeNull();
		expect(parseRetryAfter("")).toBeNull();
		expect(parseRetryAfter("soon")).toBeNull();
		expect(parseRetryAfter("-5")).toBeNull();
	});
});
