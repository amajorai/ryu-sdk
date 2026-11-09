/**
 * `ryu validate` and `ryu install` contracts: manifest validation against both
 * schemas, Core target/bearer resolution (never leaking the local node token to
 * a remote URL), and the install-bundle request shape.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	installBundle,
	isLoopbackUrl,
	resolveBundlePath,
	resolveCoreTarget,
} from "./install.ts";
import { validateManifestValue } from "./validate.ts";

const VALID_MANIFEST = {
	id: "com.example.demo",
	name: "Demo",
	version: "0.1.0",
	runnables: [],
	permission_grants: [],
};

function envOf(values: Record<string, string>) {
	return (key: string) => values[key];
}

describe("validateManifestValue", () => {
	it("accepts a minimal manifest", () => {
		expect(validateManifestValue(VALID_MANIFEST)).toEqual([]);
	});

	it("rejects a turn hook phase Core never fires (public JSON Schema)", () => {
		const findings = validateManifestValue({
			...VALID_MANIFEST,
			contributes: {
				turn_hooks: [{ id: "h", on: "post_turn", code: "return;" }],
			},
		});
		expect(findings.some((finding) => finding.source === "json-schema")).toBe(
			true
		);
	});

	it("accepts the newer hook phases", () => {
		for (const on of ["action", "pre_model_select", "view_action"]) {
			const findings = validateManifestValue({
				...VALID_MANIFEST,
				contributes: { turn_hooks: [{ id: "h", on, code: "return;" }] },
			});
			expect(findings).toEqual([]);
		}
	});

	it("accepts null agent config fields, as Core does (public JSON Schema)", () => {
		const jsonSchemaFindings = (config: unknown) =>
			validateManifestValue({
				...VALID_MANIFEST,
				runnables: [{ id: "a", kind: "agent", name: "A", config }],
			}).filter((finding) => finding.source === "json-schema");
		expect(jsonSchemaFindings(null)).toEqual([]);
		expect(
			jsonSchemaFindings({
				identity_mode: null,
				model: null,
				system_prompt: null,
			})
		).toEqual([]);
		expect(jsonSchemaFindings({ account_access: null }).length).toBeGreaterThan(
			0
		);
		expect(
			jsonSchemaFindings({ identity_mode: "bogus" }).length
		).toBeGreaterThan(0);
	});

	it("reports SDK schema failures", () => {
		const findings = validateManifestValue({ ...VALID_MANIFEST, id: "" });
		expect(findings.some((finding) => finding.source === "sdk")).toBe(true);
	});
});

describe("resolveCoreTarget", () => {
	it("defaults to the local node and reads its minted token", () => {
		const target = resolveCoreTarget(envOf({ RYU_DIR: "/data/ryu" }), (path) =>
			path === "/data/ryu/secrets/node-auth.token" ? "minted" : null
		);
		expect(target).toEqual({
			baseUrl: "http://127.0.0.1:7980",
			token: "minted",
		});
	});

	it("never sends the local node token to a remote URL", () => {
		const target = resolveCoreTarget(
			envOf({ RYU_CORE_URL: "http://localhost:80@evil.example/" }),
			() => "minted"
		);
		expect(target.token).toBeNull();
	});

	it("prefers an explicit RYU_CORE_TOKEN", () => {
		const target = resolveCoreTarget(
			envOf({
				RYU_CORE_URL: "https://node.example/",
				RYU_CORE_TOKEN: "explicit",
			}),
			() => "minted"
		);
		expect(target).toEqual({
			baseUrl: "https://node.example",
			token: "explicit",
		});
	});

	it("parses loopback hosts rather than string matching", () => {
		expect(isLoopbackUrl("http://[::1]:7980")).toBe(true);
		expect(isLoopbackUrl("http://localhost.:7980")).toBe(true);
		expect(isLoopbackUrl("not a url")).toBe(false);
	});
});

describe("installBundle", () => {
	it("posts the bundle with a bearer and enables on request", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ryu-install-"));
		try {
			writeFileSync(
				join(dir, "plugin.bundle.json"),
				JSON.stringify({ ...VALID_MANIFEST, ui_code: "<html></html>" })
			);
			const calls: { body?: string; headers: Headers; url: string }[] = [];
			const fetchImpl = (async (input, init) => {
				calls.push({
					url: String(input),
					headers: new Headers(init?.headers),
					body: typeof init?.body === "string" ? init.body : undefined,
				});
				return new Response("{}", { status: 200 });
			}) as typeof fetch;

			const outcome = await installBundle({
				bundlePath: join(dir, "plugin.bundle.json"),
				enable: true,
				update: true,
				fetchImpl,
				target: { baseUrl: "http://127.0.0.1:7980", token: "t0k" },
			});

			expect(outcome).toEqual({
				id: "com.example.demo",
				version: "0.1.0",
				enabled: true,
			});
			expect(calls.map((call) => call.url)).toEqual([
				"http://127.0.0.1:7980/api/plugins/install-bundle",
				"http://127.0.0.1:7980/api/plugins/com.example.demo/enable",
			]);
			expect(calls[0]?.headers.get("authorization")).toBe("Bearer t0k");
			expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({
				id: "com.example.demo",
				ui_code: "<html></html>",
				update: true,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("surfaces Core's error and an auth hint on 401", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ryu-install-"));
		try {
			writeFileSync(join(dir, "b.json"), JSON.stringify(VALID_MANIFEST));
			const fetchImpl = (async () =>
				new Response(JSON.stringify({ error: "unauthorized" }), {
					status: 401,
				})) as unknown as typeof fetch;
			await expect(
				installBundle({
					bundlePath: join(dir, "b.json"),
					fetchImpl,
					target: { baseUrl: "http://127.0.0.1:7980", token: null },
				})
			).rejects.toThrow("RYU_CORE_TOKEN");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resolves a project directory to its packed bundle", () => {
		const dir = mkdtempSync(join(tmpdir(), "ryu-install-"));
		try {
			expect(resolveBundlePath(dir)).toBe(
				join(dir, "dist", "plugin.bundle.json")
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
