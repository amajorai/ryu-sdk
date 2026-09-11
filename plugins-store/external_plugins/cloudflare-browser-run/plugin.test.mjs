import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const parseManifest = () =>
	JSON.parse(readFileSync(join(HERE, "manifest.json"), "utf8"));

test("declares an external Browser Run provider", () => {
	const manifest = parseManifest();
	assert.equal(manifest.external, true);
	assert.equal(manifest.mcp_servers.cloudflare.type, "streamable-http");
	assert.equal(
		manifest.mcp_servers.cloudflare.url,
		"https://browser.mcp.cloudflare.com/mcp"
	);
	assert.deepEqual(manifest.mcp_servers.cloudflare.auth, { type: "oauth" });
	assert.ok(manifest.permission_grants.includes("mcp:server"));
	assert.ok(manifest.permission_grants.includes("identity.read"));
});

test("participates in the Browser toolkit with honest URL-scoped verbs", () => {
	const manifest = parseManifest();
	const layer = manifest.provides.find(
		(provided) => provided.capability === "browser.control"
	);
	assert.ok(layer);
	assert.equal(layer.title, "Browser");
	assert.equal(layer.target, "remote-desktop");
	assert.equal(layer.selectable, true);
	assert.deepEqual(Object.keys(layer.tools).sort(), [
		"browser.navigate",
		"browser.screenshot",
		"browser.snapshot",
	]);
});

test("keeps sandboxed adapter bodies flat and referenced by code_file", () => {
	const manifest = parseManifest();
	for (const binding of Object.values(manifest.provides[0].tools)) {
		assert.equal(typeof binding.adapter?.code_file, "string");
		assert.equal(binding.adapter.code, undefined);
	}
});

// Execute the native fragment with Toolsmith's recorded, allowlisted effects.
async function runAdapterCase(verb, fixture) {
	const { runOnce } = await import("../../../tools/toolsmith/harness.mjs");
	const directory = dirname(fileURLToPath(import.meta.url));
	const source = JSON.parse(
		readFileSync(join(directory, "manifest.json"), "utf8")
	);
	const binding = source.provides
		.flatMap((entry) => Object.entries(entry.tools ?? {}))
		.find(([id]) => id === verb)[1];
	return runOnce({
		kind: "adapter",
		code: readFileSync(join(directory, binding.adapter.code_file), "utf8"),
		adapterTools: binding.adapter.tools ?? [],
		testCase: fixture,
	});
}

for (const verb of [
	"browser.navigate",
	"browser.snapshot",
	"browser.screenshot",
]) {
	test(`${verb} preserves provider errors without inventing a tab`, async () => {
		const raw = {
			isError: true,
			content: [{ type: "text", text: "unauthorized" }],
		};
		const outcome = await runAdapterCase(verb, {
			input: { url: "https://example.test", tab_id: "https://example.test" },
			provider: { call: [raw] },
		});
		assert.deepEqual(outcome.value, { raw });
		assert.deepEqual(outcome.calls, [
			{ path: "callTool", args: { url: "https://example.test" } },
		]);
	});
	test(`${verb} rejects a missing URL without provider effects`, async () => {
		const outcome = await runAdapterCase(verb, { input: {} });
		assert.equal(typeof outcome.value.error, "string");
		assert.deepEqual(outcome.calls, []);
	});
}

test("Browser Run screenshot requires an image result", async () => {
	const raw = { content: [{ type: "text", text: "connect your account" }] };
	const missing = await runAdapterCase("browser.screenshot", {
		input: { tab_id: "https://example.test" },
		provider: { call: [raw] },
	});
	assert.deepEqual(missing.value, { raw });
	const success = await runAdapterCase("browser.screenshot", {
		input: { tab_id: "https://example.test" },
		provider: {
			call: [
				{
					content: [{ type: "image", data: "fixture", mimeType: "image/png" }],
				},
			],
		},
	});
	assert.deepEqual(success.value.image, {
		data: "fixture",
		mimeType: "image/png",
	});
});

for (const verb of ["browser.navigate", "browser.snapshot"]) {
	test(`${verb} uses structured content and preserves account-connect requests`, async () => {
		const input = {
			url: "https://example.test",
			tab_id: "https://example.test",
		};
		const structuredContent = { content: "page content" };
		const success = await runAdapterCase(verb, {
			input,
			provider: { call: [{ structuredContent }] },
		});
		assert.equal(success.value.content, "page content");
		assert.equal(success.value.tab_id, input.url);
		const raw = { __ryu_elicitation__: { message: "connect account" } };
		const unavailable = await runAdapterCase(verb, {
			input,
			provider: { call: [raw] },
		});
		assert.deepEqual(unavailable.value, { raw });
	});
}
