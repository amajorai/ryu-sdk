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
