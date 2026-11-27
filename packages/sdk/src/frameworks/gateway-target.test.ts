/**
 * Unit tests for the Gateway target the framework helpers resolve: option and
 * environment order, the `/v1` suffix, the direct provider refusal, and the
 * lockstep with the Rust core's constants. Filesystem and memory only.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	assertGatewayUrl,
	BLOCKED_PROVIDER_PATTERNS,
	DEFAULT_GATEWAY_URL,
	ENV_GATEWAY_TOKEN,
	ENV_GATEWAY_URL,
	gatewayModelId,
	RYU_NO_KEY,
	resolveRyuGateway,
} from "./gateway-target.ts";
import { ryuChatOpenAI } from "./langchain.ts";
import { ryuModel } from "./mastra.ts";

const RUST_GATEWAY = join(
	import.meta.dir,
	"../../../../crates/sdk/core/src/gateway.rs"
);
const RE_EGRESS = /egress is not allowed/i;
const RE_NOT_A_URL = /not a valid URL/;
const RE_SCHEME = /must start with http/;
const RE_CREDENTIALS = /must not carry credentials/;
const RE_QUERY = /must not carry a query/;
const RE_MODEL_REQUIRED = /a model id is required/;
const RE_RUST_BLOCKLIST =
	/const BLOCKED_PROVIDER_PATTERNS[^=]*=\s*&\[([\s\S]*?)\];/;
const RE_RUST_RAW_STRING = /r"([^"]+)"/g;
const RE_RUST_DEFAULT_URL = /pub const DEFAULT_GATEWAY_URL: &str = "([^"]+)";/;
const RE_RUST_ENV_URL = /pub const ENV_GATEWAY_URL: &str = "([^"]+)";/;
const RE_RUST_ENV_TOKEN = /pub const ENV_GATEWAY_TOKEN: &str = "([^"]+)";/;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const name of [ENV_GATEWAY_URL, ENV_GATEWAY_TOKEN]) {
		saved[name] = process.env[name];
		delete process.env[name];
	}
});

afterEach(() => {
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	}
});

describe("resolveRyuGateway", () => {
	test("defaults to the local Gateway and the no-key placeholder", () => {
		expect(resolveRyuGateway()).toEqual({
			apiKey: RYU_NO_KEY,
			baseUrl: `${DEFAULT_GATEWAY_URL}/v1`,
			hasKey: false,
		});
	});

	test("reads the URL and the key from the environment", () => {
		process.env[ENV_GATEWAY_URL] = " https://gateway.example.test ";
		process.env[ENV_GATEWAY_TOKEN] = " env-key ";
		expect(resolveRyuGateway()).toEqual({
			apiKey: "env-key",
			baseUrl: "https://gateway.example.test/v1",
			hasKey: true,
		});
	});

	test("options win over the environment", () => {
		process.env[ENV_GATEWAY_URL] = "https://gateway.example.test";
		process.env[ENV_GATEWAY_TOKEN] = "env-key";
		const target = resolveRyuGateway({
			apiKey: "option-key",
			baseUrl: "http://10.0.0.5:7981",
		});
		expect(target.apiKey).toBe("option-key");
		expect(target.baseUrl).toBe("http://10.0.0.5:7981/v1");
	});

	test("an empty environment value counts as unset", () => {
		process.env[ENV_GATEWAY_URL] = "  ";
		process.env[ENV_GATEWAY_TOKEN] = "";
		const target = resolveRyuGateway();
		expect(target.baseUrl).toBe(`${DEFAULT_GATEWAY_URL}/v1`);
		expect(target.hasKey).toBe(false);
	});

	test("adds /v1 exactly once", () => {
		for (const baseUrl of [
			"http://127.0.0.1:7981",
			"http://127.0.0.1:7981/",
			"http://127.0.0.1:7981/v1",
			"http://127.0.0.1:7981/v1/",
			"http://127.0.0.1:7981/V1//",
		]) {
			expect(resolveRyuGateway({ baseUrl }).baseUrl.toLowerCase()).toBe(
				"http://127.0.0.1:7981/v1"
			);
		}
		expect(
			resolveRyuGateway({ baseUrl: "https://host.test/ryu/gateway" }).baseUrl
		).toBe("https://host.test/ryu/gateway/v1");
	});

	test("copies headers and leaves the key out when there are none", () => {
		const headers = { "x-trace-id": "t1" };
		const target = resolveRyuGateway({ headers });
		expect(target.headers).toEqual(headers);
		expect(target.headers).not.toBe(headers);
		expect("headers" in resolveRyuGateway({ headers: {} })).toBe(false);
	});

	test("refuses a malformed base URL", () => {
		for (const baseUrl of ["localhost:7981", "ftp://127.0.0.1:7981"]) {
			expect(() => resolveRyuGateway({ baseUrl })).toThrow(RE_SCHEME);
		}
		for (const baseUrl of ["not a url", "127.0.0.1:7981"]) {
			expect(() => resolveRyuGateway({ baseUrl })).toThrow(RE_NOT_A_URL);
		}
		expect(() =>
			resolveRyuGateway({ baseUrl: "http://user:pass@127.0.0.1:7981" })
		).toThrow(RE_CREDENTIALS);
		expect(() =>
			resolveRyuGateway({ baseUrl: "http://127.0.0.1:7981/v1?key=abc" })
		).toThrow(RE_QUERY);
	});

	test("an error never repeats a secret typed into the URL", () => {
		const message = (baseUrl: string): string => {
			try {
				resolveRyuGateway({ baseUrl });
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
			return "";
		};
		for (const baseUrl of [
			"https://user:hunter2secret@api.openai.com/v1",
			"ftp://user:hunter2secret@127.0.0.1:7981",
			"user:hunter2secret@127.0.0.1:7981",
			"http://127.0.0.1:7981/v1?key=hunter2secret",
			"http://127.0.0.1:7981/v1#hunter2secret",
			"not a url hunter2secret",
		]) {
			expect(message(baseUrl)).not.toBe("");
			expect(message(baseUrl)).not.toContain("hunter2secret");
		}
	});
});

describe("direct provider refusal", () => {
	test("refuses every provider host, in any letter case", () => {
		for (const blocked of [
			"https://api.openai.com/v1",
			"https://API.OpenAI.com/v1",
			"https://api.anthropic.com",
			"https://generativelanguage.googleapis.com/v1beta",
			"https://openrouter.ai/api/v1",
			"https://api.groq.com/openai/v1",
		]) {
			expect(() => assertGatewayUrl(blocked)).toThrow(RE_EGRESS);
			expect(() => ryuModel("gpt-4o", { baseUrl: blocked })).toThrow(RE_EGRESS);
			expect(() => ryuChatOpenAI("gpt-4o", { baseUrl: blocked })).toThrow(
				RE_EGRESS
			);
		}
	});

	test("refuses a provider host that arrives through the environment", () => {
		process.env[ENV_GATEWAY_URL] = "https://api.openai.com/v1";
		expect(() => ryuModel("gpt-4o")).toThrow(RE_EGRESS);
		expect(() => ryuChatOpenAI("gpt-4o")).toThrow(RE_EGRESS);
	});

	test("allows a Gateway on loopback, a LAN address or a private host", () => {
		for (const allowed of [
			"http://127.0.0.1:7981",
			"http://localhost:7981",
			"https://gateway.internal.example",
			"http://192.168.1.50:7981",
		]) {
			expect(() => assertGatewayUrl(allowed)).not.toThrow();
		}
	});
});

describe("lockstep with the Rust core (crates/sdk/core/src/gateway.rs)", () => {
	const rust = readFileSync(RUST_GATEWAY, "utf8");

	test("the provider blocklist is the same list in the same order", () => {
		const block = RE_RUST_BLOCKLIST.exec(rust)?.[1] ?? "";
		const patterns = [...block.matchAll(RE_RUST_RAW_STRING)].map(
			(match) => match[1]
		);
		expect(patterns.length).toBeGreaterThan(0);
		expect(patterns).toEqual([...BLOCKED_PROVIDER_PATTERNS]);
	});

	test("the default URL and the environment variable names match", () => {
		expect(RE_RUST_DEFAULT_URL.exec(rust)?.[1]).toBe(DEFAULT_GATEWAY_URL);
		expect(RE_RUST_ENV_URL.exec(rust)?.[1]).toBe(ENV_GATEWAY_URL);
		expect(RE_RUST_ENV_TOKEN.exec(rust)?.[1]).toBe(ENV_GATEWAY_TOKEN);
	});
});

describe("ryuModel (Mastra)", () => {
	test("returns the url model config with the ryu provider prefix", () => {
		expect(
			ryuModel("gpt-4o", { apiKey: "k", baseUrl: "http://127.0.0.1:7981" })
		).toEqual({
			apiKey: "k",
			id: "ryu/gpt-4o",
			url: "http://127.0.0.1:7981/v1",
		});
	});

	test("keeps a model id that has its own slash", () => {
		expect(ryuModel(" anthropic/claude-sonnet-4 ").id).toBe(
			"ryu/anthropic/claude-sonnet-4"
		);
	});

	test("passes headers and never leaves the key undefined", () => {
		const config = ryuModel("gpt-4o", { headers: { "x-trace-id": "t1" } });
		expect(config.headers).toEqual({ "x-trace-id": "t1" });
		expect(config.apiKey).toBe(RYU_NO_KEY);
	});

	test("refuses an empty model id", () => {
		expect(() => ryuModel("  ")).toThrow(RE_MODEL_REQUIRED);
		expect(() => gatewayModelId("")).toThrow(RE_MODEL_REQUIRED);
	});
});

describe("ryuChatOpenAI (LangChain)", () => {
	test("returns the ChatOpenAI fields pinned to Chat Completions", () => {
		expect(
			ryuChatOpenAI("gpt-4o", { apiKey: "k", baseUrl: "http://127.0.0.1:7981" })
		).toEqual({
			apiKey: "k",
			configuration: { baseURL: "http://127.0.0.1:7981/v1" },
			model: "gpt-4o",
			useResponsesApi: false,
		});
	});

	test("passes headers as defaultHeaders and never leaves the key undefined", () => {
		const fields = ryuChatOpenAI("gpt-4o", { headers: { "x-trace-id": "t1" } });
		expect(fields.configuration.defaultHeaders).toEqual({ "x-trace-id": "t1" });
		expect(fields.apiKey).toBe(RYU_NO_KEY);
	});

	test("refuses an empty model id", () => {
		expect(() => ryuChatOpenAI("")).toThrow(RE_MODEL_REQUIRED);
	});
});

describe("Security conditions on PR #1463", () => {
	const thrown = (run: () => unknown): string => {
		try {
			run();
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
		return "";
	};

	test("assertGatewayUrl names only the scheme and host of a refused URL", () => {
		const message = thrown(() =>
			assertGatewayUrl("https://user:secret@api.openai.com/v1/chat?k=q#frag")
		);
		expect(message).toMatch(RE_EGRESS);
		expect(message).toContain('"https://api.openai.com"');
		for (const part of ["secret", "user", "/v1", "/chat", "k=q", "frag"]) {
			expect(message).not.toContain(part);
		}
	});

	test("assertGatewayUrl prints <unparseable> when the URL has no host to name", () => {
		for (const raw of [
			"api.openai.com/v1?k=secret",
			"user:secret@api.openai.com",
		]) {
			const message = thrown(() => assertGatewayUrl(raw));
			expect(message).toMatch(RE_EGRESS);
			expect(message).toContain('"<unparseable>"');
			expect(message).not.toContain("secret");
		}
	});

	test("refuses a provider host that is only written in an encoded form", () => {
		for (const blocked of [
			"https://api%2Eopenai%2Ecom/v1",
			"https://ａｐｉ．ｏｐｅｎａｉ．ｃｏｍ/v1",
		]) {
			expect(() => assertGatewayUrl(blocked)).toThrow(RE_EGRESS);
			expect(() => resolveRyuGateway({ baseUrl: blocked })).toThrow(RE_EGRESS);
		}
	});

	test("builds the base URL from the parsed URL, not the raw text", () => {
		expect(resolveRyuGateway({ baseUrl: "http://h/?" }).baseUrl).toBe(
			"http://h/v1"
		);
		expect(resolveRyuGateway({ baseUrl: "http://h/v1#" }).baseUrl).toBe(
			"http://h/v1"
		);
	});
});

describe("plain http warning (once per process)", () => {
	type Module = typeof import("./gateway-target.ts");
	let fresh = 0;
	// A fresh module instance per test, so the once-per-process flag starts unset.
	const load = async (): Promise<Module> => {
		fresh += 1;
		const specifier = `./gateway-target.ts?plain-http-${fresh}`;
		return (await import(specifier)) as Module;
	};
	const warnings: string[] = [];
	const original = console.warn;

	beforeEach(() => {
		warnings.length = 0;
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		};
	});

	afterEach(() => {
		console.warn = original;
	});

	test("warns once, naming only the host, and returns the same target", async () => {
		const mod = await load();
		const options = {
			apiKey: "test-gateway-key",
			baseUrl: "http://gateway.internal:8080/path",
		};
		const target = mod.resolveRyuGateway(options);
		expect(target).toEqual({
			apiKey: "test-gateway-key",
			baseUrl: "http://gateway.internal:8080/path/v1",
			hasKey: true,
		});
		expect(warnings).toHaveLength(1);
		const [warning] = warnings;
		expect(warning).toStartWith("[ryu-sdk]");
		expect(warning).toContain("gateway.internal");
		for (const part of [
			"test-gateway-key",
			"http://gateway.internal",
			"8080",
			"/path",
		]) {
			expect(warning).not.toContain(part);
		}
		mod.resolveRyuGateway(options);
		mod.resolveRyuGateway({ ...options, baseUrl: "http://other.internal" });
		expect(warnings).toHaveLength(1);
	});

	test("does not warn for https, loopback hosts or without a real key", async () => {
		const mod = await load();
		const apiKey = "test-gateway-key";
		for (const baseUrl of [
			"https://gateway.internal:8080",
			"http://localhost:7981",
			"http://127.0.0.1:7981",
			"http://127.1.2.3:7981",
			"http://[::1]:7981",
		]) {
			mod.resolveRyuGateway({ apiKey, baseUrl });
		}
		mod.resolveRyuGateway({ baseUrl: "http://gateway.internal:8080" });
		expect(warnings).toEqual([]);
	});

	test("the key from the environment counts as a real key", async () => {
		const mod = await load();
		process.env[ENV_GATEWAY_TOKEN] = "test-gateway-key";
		process.env[ENV_GATEWAY_URL] = "http://10.0.0.5:7981";
		expect(mod.resolveRyuGateway().baseUrl).toBe("http://10.0.0.5:7981/v1");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("10.0.0.5");
	});
});
