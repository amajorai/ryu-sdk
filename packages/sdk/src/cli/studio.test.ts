/**
 * `ryu dev --studio` tests: argument parsing, serving a real project entry
 * with the studio page, and a syntax check of the page's inline script.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { STUDIO_HTML } from "../server/studio.ts";
import {
	DEFAULT_STUDIO_PORT,
	guardStudio,
	isLoopbackHostname,
	parseStudioArgs,
	startStudio,
} from "./studio.ts";

const SRC = resolve(import.meta.dir, "..");
const SCRIPT_PATTERN = /<script>([\s\S]*)<\/script>/;

describe("parseStudioArgs", () => {
	it("defaults the entry, host, and port", () => {
		expect(parseStudioArgs(["--studio"])).toEqual({
			entry: "src/ryu.ts",
			host: "127.0.0.1",
			port: DEFAULT_STUDIO_PORT,
		});
		expect(
			parseStudioArgs(["--studio", "app.ts", "--port", "0", "--host=0.0.0.0"])
		).toEqual({ entry: "app.ts", host: "0.0.0.0", port: 0 });
	});

	it("rejects bad ports and unknown flags", () => {
		expect(() => parseStudioArgs(["--studio", "--port", "99999"])).toThrow(
			/--port/
		);
		expect(() => parseStudioArgs(["--studio", "--port", "abc"])).toThrow(
			/--port/
		);
		expect(() => parseStudioArgs(["--studio", "--open"])).toThrow(
			/unknown option/
		);
	});
});

describe("studio page", () => {
	it("ships a script that parses", () => {
		const script = SCRIPT_PATTERN.exec(STUDIO_HTML)?.[1] ?? "";
		expect(script.length).toBeGreaterThan(1000);
		// Parse only (the body touches `document`, which tests do not have).
		const transpiler = new Bun.Transpiler({ loader: "js" });
		expect(() => transpiler.transformSync(script)).not.toThrow();
		// Dynamic text is only ever written as text, never as markup.
		expect(script).not.toContain("innerHTML");
	});
});

describe("startStudio", () => {
	it("serves the project's API and the studio page", async () => {
		const root = mkdtempSync(join(tmpdir(), "ryu-studio-"));
		try {
			mkdirSync(join(root, "src"));
			writeFileSync(
				join(root, "src/ryu.ts"),
				`import { defineTool } from ${JSON.stringify(join(SRC, "runnable/tool.ts"))};
export const tools = {
	ping: defineTool({
		id: "ping",
		name: "Ping",
		schema: { type: "object", properties: {} },
		run: async () => "pong",
	}),
};
`
			);
			const { app, basePath } = await startStudio({
				entry: "src/ryu.ts",
				host: "127.0.0.1",
				port: 0,
				cwd: root,
			});
			try {
				expect(basePath).toBe("/api");
				const page = await fetch(`${app.url}/`);
				expect(page.headers.get("content-type")).toContain("text/html");
				expect(await page.text()).toContain("Ryu Studio");
				const res = await fetch(`${app.url}/api/tools/ping/execute`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}",
				});
				expect(await res.json()).toMatchObject({ output: "pong" });
				const crossSite = await fetch(`${app.url}/api/tools/ping/execute`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: "https://evil.example",
					},
					body: "{}",
				});
				expect(crossSite.status).toBe(403);
			} finally {
				await app.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("guardStudio", () => {
	const ok = () => Promise.resolve(new Response("ok"));
	const call = (
		guarded: ReturnType<typeof guardStudio>,
		url: string,
		init: RequestInit = {}
	) => Promise.resolve(guarded(new Request(url, init)));

	it("recognizes loopback hostnames", () => {
		for (const host of [
			"localhost",
			"127.0.0.1",
			"127.1.2.3",
			"[::1]",
			"app.localhost",
		]) {
			expect(isLoopbackHostname(host)).toBe(true);
		}
		for (const host of [
			"0.0.0.0",
			"192.168.1.4",
			"evil.example",
			"localhost.evil.example",
		]) {
			expect(isLoopbackHostname(host)).toBe(false);
		}
	});

	it("refuses DNS-rebound hosts when bound to loopback", async () => {
		const guarded = guardStudio(ok, { loopbackOnly: true });
		expect(
			(await call(guarded, "http://127.0.0.1:4111/api/agents")).status
		).toBe(200);
		const rebound = await call(guarded, "http://evil.example:4111/api/agents");
		expect(rebound.status).toBe(403);
		expect(await rebound.json()).toMatchObject({
			error: { code: "host_not_allowed" },
		});
		const open = guardStudio(ok, { loopbackOnly: false });
		expect(
			(await call(open, "http://192.168.1.4:4111/api/agents")).status
		).toBe(200);
	});

	it("only accepts changes from the studio's own origin", async () => {
		const guarded = guardStudio(ok, { loopbackOnly: true });
		const url = "http://localhost:4111/api/workflows/x/runs/y/cancel";
		expect((await call(guarded, url, { method: "POST" })).status).toBe(200);
		expect(
			(
				await call(guarded, url, {
					method: "POST",
					headers: { origin: "http://localhost:4111" },
				})
			).status
		).toBe(200);
		for (const origin of [
			"https://evil.example",
			"null",
			"http://localhost:3000",
		]) {
			const refused = await call(guarded, url, {
				method: "POST",
				headers: { origin },
			});
			expect(refused.status).toBe(403);
		}
		expect(
			(
				await call(guarded, "http://localhost:4111/api/agents", {
					headers: { origin: "https://evil.example" },
				})
			).status
		).toBe(200);
	});
});
