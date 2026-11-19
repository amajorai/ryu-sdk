import { describe, expect, test } from "bun:test";
import {
	assertFetchableUrl,
	fetchGuarded,
	isPrivateAddress,
	readBodyCapped,
	ryuVaultSecret,
} from "./net.ts";
import { jsonResponse, mockNetwork, textResponse } from "./test-support.ts";
import { LoaderError } from "./types.ts";

describe("isPrivateAddress", () => {
	test("blocks loopback, private, link-local, CGNAT, and metadata ranges", () => {
		for (const address of [
			"127.0.0.1",
			"10.1.2.3",
			"172.16.0.1",
			"172.31.255.255",
			"192.168.1.1",
			"169.254.169.254",
			"100.64.0.1",
			"0.0.0.0",
			"224.0.0.1",
			"::1",
			"::",
			"fc00::1",
			"fd12:3456::1",
			"fe80::1",
			"::ffff:127.0.0.1",
			"::ffff:7f00:1",
			"64:ff9b::a9fe:a9fe",
			"[::1]",
			"not-an-ip",
		]) {
			expect(isPrivateAddress(address)).toBe(true);
		}
	});

	test("allows public addresses", () => {
		for (const address of [
			"93.184.215.14",
			"8.8.8.8",
			"172.32.0.1",
			"2606:4700::1111",
			"::ffff:8.8.8.8",
		]) {
			expect(isPrivateAddress(address)).toBe(false);
		}
	});
});

describe("assertFetchableUrl", () => {
	const publicLookup = () => Promise.resolve(["93.184.215.14"]);

	test("refuses non-http schemes, credentials, and local names", async () => {
		for (const url of [
			"file:///etc/passwd",
			"ftp://example.com/",
			"https://user:pw@example.com/",
			"http://localhost:3000/",
			"http://metadata.google.internal/",
			"http://printer.local/",
		]) {
			await expect(
				assertFetchableUrl(new URL(url), { lookup: publicLookup })
			).rejects.toBeInstanceOf(LoaderError);
		}
	});

	test("refuses private IP literals and private DNS answers", async () => {
		await expect(
			assertFetchableUrl(new URL("http://169.254.169.254/latest"))
		).rejects.toThrow("private address");
		await expect(
			assertFetchableUrl(new URL("http://[::1]:8080/"))
		).rejects.toThrow("private address");
		await expect(
			assertFetchableUrl(new URL("https://rebind.example/"), {
				lookup: () => Promise.resolve(["93.184.215.14", "10.0.0.5"]),
			})
		).rejects.toThrow("resolves to a private address");
	});

	test("allows private targets only when opted in", async () => {
		await assertFetchableUrl(new URL("http://127.0.0.1:8080/"), {
			allowPrivateNetwork: true,
		});
		await assertFetchableUrl(new URL("http://127.0.0.1:8080/"), {
			allowedHosts: ["127.0.0.1:8080"],
		});
		await expect(
			assertFetchableUrl(new URL("http://127.0.0.1:9090/"), {
				allowedHosts: ["127.0.0.1:8080"],
			})
		).rejects.toThrow("private address");
	});
});

describe("fetchGuarded", () => {
	test("re-checks every redirect hop", async () => {
		const net = mockNetwork({
			"https://example.com/start": Response.redirect(
				"http://10.0.0.1/admin",
				302
			),
		});
		await expect(
			fetchGuarded("https://example.com/start", {}, net)
		).rejects.toThrow("private address");
		expect(net.requests).toHaveLength(1);
	});

	test("drops Authorization when a redirect leaves the origin", async () => {
		const net = mockNetwork({
			"https://api.example.com/file": Response.redirect(
				"https://cdn.example.net/blob",
				307
			),
			"https://cdn.example.net/blob": textResponse("ok", "text/plain"),
		});
		const response = await fetchGuarded(
			"https://api.example.com/file",
			{ headers: { authorization: "Bearer secret" } },
			net
		);
		expect(await response.text()).toBe("ok");
		expect(net.requests[0]?.headers.get("authorization")).toBe("Bearer secret");
		expect(net.requests[1]?.headers.get("authorization")).toBeNull();
	});

	test("stops after maxRedirects", async () => {
		const net = mockNetwork({
			"https://example.com/loop": Response.redirect(
				"https://example.com/loop",
				301
			),
		});
		await expect(
			fetchGuarded("https://example.com/loop", {}, { ...net, maxRedirects: 2 })
		).rejects.toThrow("too many redirects");
		expect(net.requests).toHaveLength(3);
	});

	test("caps response bodies", async () => {
		await expect(
			readBodyCapped(new Response("x".repeat(100)), 10)
		).rejects.toThrow("limit");
		expect(
			new TextDecoder().decode(await readBodyCapped(new Response("hello"), 10))
		).toBe("hello");
	});
});

describe("ryuVaultSecret", () => {
	test("reveals a vault secret through Core", async () => {
		const net = mockNetwork({
			"http://127.0.0.1:7980/api/vault/secrets/NOTION_TOKEN/reveal":
				jsonResponse({ value: "secret_abc" }),
		});
		const credential = ryuVaultSecret({
			nodeUrl: "http://127.0.0.1:7980/",
			token: "node-token",
			name: "NOTION_TOKEN",
			path: "/connectors",
			fetch: net.fetch,
		});
		expect(await credential()).toBe("secret_abc");
		expect(net.requests[0]?.method).toBe("POST");
		expect(net.requests[0]?.headers.get("authorization")).toBe(
			"Bearer node-token"
		);
		expect(JSON.parse(net.requests[0]?.body ?? "{}")).toEqual({
			path: "/connectors",
		});
	});

	test("takes the node URL as baseUrl", async () => {
		const net = mockNetwork({
			"http://core/api/vault/secrets/NOTION_TOKEN/reveal": jsonResponse({
				value: "secret_abc",
			}),
		});
		const credential = ryuVaultSecret({
			baseUrl: "http://core/",
			name: "NOTION_TOKEN",
			fetch: net.fetch,
		});
		expect(await credential()).toBe("secret_abc");
	});

	test("fails when the secret is unreadable", async () => {
		const net = mockNetwork({
			"http://core/api/vault/secrets/MISSING/reveal": jsonResponse(
				{ error: "denied" },
				403
			),
		});
		await expect(
			ryuVaultSecret({
				nodeUrl: "http://core",
				name: "MISSING",
				fetch: net.fetch,
			})()
		).rejects.toThrow("HTTP 403");
	});
});
