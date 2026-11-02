import { describe, expect, test } from "bun:test";
import {
	CORE_TOKEN_ENV_VARS,
	DEFAULT_CORE_URL,
	pickCoreUrl,
	requireCoreUrl,
	resolveCoreToken,
	resolveCoreUrl,
} from "./core-env.ts";

const reader =
	(values: Record<string, string>) =>
	(name: string): string | undefined =>
		values[name];

describe("Core env defaults", () => {
	test("RYU_CORE_TOKEN wins over RYU_TOKEN", () => {
		expect(CORE_TOKEN_ENV_VARS).toEqual(["RYU_CORE_TOKEN", "RYU_TOKEN"]);
		expect(
			resolveCoreToken(reader({ RYU_CORE_TOKEN: "core", RYU_TOKEN: "old" }))
		).toBe("core");
	});

	test("RYU_TOKEN is still read, and blank values count as unset", () => {
		expect(resolveCoreToken(reader({ RYU_TOKEN: "old" }))).toBe("old");
		expect(
			resolveCoreToken(reader({ RYU_CORE_TOKEN: "  ", RYU_TOKEN: " old " }))
		).toBe("old");
		expect(resolveCoreToken(reader({}))).toBeUndefined();
	});

	test("RYU_CORE_URL, else the local node", () => {
		expect(resolveCoreUrl(reader({ RYU_CORE_URL: "http://core:7980" }))).toBe(
			"http://core:7980"
		);
		expect(resolveCoreUrl(reader({ RYU_CORE_URL: "" }))).toBe(DEFAULT_CORE_URL);
		expect(DEFAULT_CORE_URL).toBe("http://127.0.0.1:7980");
	});

	test("baseUrl is the Core URL option; nodeUrl is still read", () => {
		expect(pickCoreUrl({ baseUrl: "http://core:7980/" })).toBe(
			"http://core:7980"
		);
		expect(pickCoreUrl({ nodeUrl: "http://old:7980//" })).toBe(
			"http://old:7980"
		);
		expect(
			pickCoreUrl({ baseUrl: "http://core:7980", nodeUrl: "http://core:7980" })
		).toBe("http://core:7980");
		expect(pickCoreUrl({ baseUrl: " ", nodeUrl: "http://old" })).toBe(
			"http://old"
		);
		expect(pickCoreUrl({})).toBeUndefined();
	});

	test("the same URL written with and without a trailing slash is no conflict", () => {
		expect(pickCoreUrl({ baseUrl: "http://a", nodeUrl: "http://a/" })).toBe(
			"http://a"
		);
		expect(pickCoreUrl({ baseUrl: " http://a// ", nodeUrl: "http://a" })).toBe(
			"http://a"
		);
	});

	test("conflicting baseUrl and nodeUrl throw; requireCoreUrl needs one", () => {
		expect(() =>
			pickCoreUrl({ baseUrl: "http://a", nodeUrl: "http://b" })
		).toThrow(/baseUrl or nodeUrl/);
		expect(() => requireCoreUrl({})).toThrow(/Core URL is required/);
		expect(requireCoreUrl({ nodeUrl: "http://old/" })).toBe("http://old");
	});
});
