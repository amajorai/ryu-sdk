import { describe, expect, test } from "bun:test";
import {
	API_VERSIONING_POLICY_URL,
	type DeprecatedRoute,
	deprecationHeaders,
} from "../../../../apps/server/src/deprecation.ts";
import {
	parseDeprecation,
	parseDeprecationDate,
	parseLinkHeader,
} from "./deprecation.ts";

function headersFor(route: DeprecatedRoute): Headers {
	const headers = new Headers();
	for (const [name, value] of deprecationHeaders(route)) {
		headers.append(name, value);
	}
	return headers;
}

describe("deprecation headers round-trip from apps/server", () => {
	test("deprecatedAt, sunsetAt, policy and successor", () => {
		const route: DeprecatedRoute = {
			deprecatedAt: new Date("2026-01-01T00:00:00Z"),
			path: "/api/old",
			successor: "https://api.ryuhq.com/api/new",
			sunsetAt: new Date("2026-07-01T00:00:00Z"),
		};
		expect(parseDeprecation(headersFor(route))).toEqual({
			deprecatedAt: route.deprecatedAt,
			policyUrl: API_VERSIONING_POLICY_URL,
			successorUrl: "https://api.ryuhq.com/api/new",
			sunsetAt: route.sunsetAt ?? null,
		});
	});

	test("without a sunset or successor", () => {
		const parsed = parseDeprecation(
			headersFor({ deprecatedAt: new Date("2026-03-04T05:06:07Z"), path: "/x" })
		);
		expect(parsed).toEqual({
			deprecatedAt: new Date("2026-03-04T05:06:07Z"),
			policyUrl: API_VERSIONING_POLICY_URL,
			successorUrl: null,
			sunsetAt: null,
		});
	});

	test("no Deprecation and no Sunset means no deprecation", () => {
		expect(
			parseDeprecation(
				new Headers({ Link: '<https://x.example.com>; rel="next"' })
			)
		).toBeNull();
	});
});

describe("parsers", () => {
	test("Deprecation as @unix or HTTP-date", () => {
		expect(parseDeprecationDate("@1767225600")?.toISOString()).toBe(
			"2026-01-01T00:00:00.000Z"
		);
		expect(
			parseDeprecationDate("Thu, 01 Jan 2026 00:00:00 GMT")?.toISOString()
		).toBe("2026-01-01T00:00:00.000Z");
		expect(parseDeprecationDate("nonsense")).toBeNull();
		expect(parseDeprecationDate("1767225600")).toBeNull();
		expect(parseDeprecationDate(null)).toBeNull();
	});

	test("Link values with commas inside URLs and quoted params, multiple rels", () => {
		expect(
			parseLinkHeader(
				'<https://a.example.com/x?a=1,2>; rel="deprecation successor-version"; title="a, b", <https://b.example.com>; rel=next'
			)
		).toEqual([
			{
				params: { rel: "deprecation successor-version", title: "a, b" },
				rels: ["deprecation", "successor-version"],
				url: "https://a.example.com/x?a=1,2",
			},
			{ params: { rel: "next" }, rels: ["next"], url: "https://b.example.com" },
		]);
		expect(parseLinkHeader("not a link")).toEqual([]);
	});
});
