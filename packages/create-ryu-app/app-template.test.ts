/**
 * create-ryu-app `app` template: an apps-store satellite (manifest + sidecar/),
 * NOT a plugin.
 *
 * Asserts the satellite tree, the sidecar/provides blocks as they sit on disk,
 * the dependency-free package.json files, and the sidecar's request handling.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { scaffold } from "./index.ts";
import { PackageSchema, readManifest } from "./test-helpers.ts";

/** The satellite blocks, as they sit on disk. Mirrors `SidecarSpec` /
 *  `ProvidesEntry` in `crates/core/kernel-contracts` — the Rust loader that
 *  cross-validates them is what these assertions stand in for, since a TS suite
 *  cannot run it. */
const RawSidecarSchema = z.object({
	health_path: z.string(),
	http: z
		.object({ routes: z.array(z.object({ path: z.string() })).optional() })
		.optional(),
	idle_stop_secs: z.number().optional(),
	lazy: z.boolean().optional(),
	name: z.string(),
	port: z.number(),
	process: z.object({
		kind: z.string(),
		command: z.string(),
		command_env: z.string().optional(),
		port_env: z.string().optional(),
	}),
});
const RawProvidesSchema = z.object({
	capability: z.string(),
	grant: z.string().optional(),
	route: z.string().optional(),
	sidecar: z.string().optional(),
	version: z.string(),
});
const RawManifestSchema = z.object({
	sidecars: z.array(RawSidecarSchema),
	provides: z.array(RawProvidesSchema),
	permission_grants: z.array(z.string()),
});

/**
 * The manifest exactly as it sits on disk.
 *
 * `readManifest` must NOT be used for the satellite blocks: `PluginManifestSchema`
 * is a non-strict `z.object`, so it accepts `sidecars`/`provides`/`engines` and
 * then STRIPS them from the parsed value. Core's Rust loader is the authority on
 * those, and it reads the bytes — so the assertions about them read the bytes too.
 */
function readRawManifest(projectDir: string) {
	const raw = readFileSync(join(projectDir, "manifest.json"), "utf8");
	return RawManifestSchema.parse(JSON.parse(raw));
}

type ControlModule =
	typeof import("./template/app/sidecar/src/main/control.ts");

describe("create-ryu-app scaffold (app)", () => {
	let tmpDir: string;
	let projectDir: string;

	beforeAll(() => {
		tmpDir = join(import.meta.dir, `__test-app-${Date.now()}`);
		projectDir = scaffold("my-app", tmpDir, "app");
	});

	afterAll(() => {
		if (existsSync(tmpDir)) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("produces a satellite tree: a manifest plus a self-contained sidecar/", () => {
		for (const file of [
			"manifest.json",
			"README.md",
			"package.json",
			"sidecar/package.json",
			"sidecar/tsconfig.json",
			"sidecar/src/main/index.ts",
			"sidecar/src/main/control.ts",
		]) {
			expect(existsSync(join(projectDir, file))).toBe(true);
		}
		// An app is NOT a plugin: no authoring src/, no widget, no packed UI.
		expect(existsSync(join(projectDir, "src"))).toBe(false);
	});

	it("manifest.json still parses against PluginManifestSchema", () => {
		const parsed = readManifest(projectDir);
		expect(parsed.id).toBe("com.example.my-app");
		expect(parsed.name).toBe("My App");
		// A satellite contributes nothing in-process — no widgets, no hooks, no
		// settings tabs, no tool filters — so it declares no `contributes` block at
		// all and cannot contradict those typed contracts.
		expect(parsed.contributes).toBeUndefined();
		expect(parsed.runnables).toHaveLength(0);
	});

	it("declares a lazy local sidecar wired to the injected env vars", () => {
		const raw = readRawManifest(projectDir);
		const sidecars = raw.sidecars;
		expect(sidecars).toHaveLength(1);
		const sidecar = sidecars[0];
		expect(sidecar?.name).toBe("my-app");
		expect(sidecar?.process.kind).toBe("local");
		expect(sidecar?.process.command).toBe("ryu-my-app");
		// The env names are stamped from the slug; `port_env` is what lets a
		// dev-profile Core hand the child its profile-shifted port.
		expect(sidecar?.process.command_env).toBe("RYU_MY_APP_BIN");
		expect(sidecar?.process.port_env).toBe("RYU_MY_APP_PORT");
		expect(sidecar?.health_path).toBe("/health");
		expect(sidecar?.lazy).toBe(true);
		expect(sidecar?.idle_stop_secs).toBeGreaterThanOrEqual(30);
	});

	it("provides[] cross-validates against the sidecar it names", () => {
		const raw = readRawManifest(projectDir);
		const sidecar = raw.sidecars[0];
		const provides = raw.provides;
		expect(provides).toHaveLength(1);
		const entry = provides[0];
		expect(entry?.capability).toBe("my-app.control");
		// Core's loader rejects a provides entry whose sidecar/route does not exist.
		expect(entry?.sidecar).toBe(sidecar?.name);
		const routes = (sidecar?.http?.routes ?? []).map((r) => r.path);
		expect(routes).toContain(entry?.route);
		// The grant the capability is gated behind must be one the app declares.
		expect(raw.permission_grants).toContain(entry?.grant);
	});

	it("leaves no unstamped placeholder anywhere in the tree", () => {
		for (const file of [
			"manifest.json",
			"README.md",
			"sidecar/package.json",
			"sidecar/src/main/index.ts",
			"sidecar/src/main/control.ts",
		]) {
			const src = readFileSync(join(projectDir, file), "utf8");
			expect(src).not.toContain("__APP_");
		}
	});

	it("package.json runs the sidecar and depends on nothing of ours", () => {
		const pkg = PackageSchema.parse(
			JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8"))
		);
		expect(pkg.scripts.dev).toBe("bun run sidecar/src/main/index.ts");
		expect(pkg.scripts.build).toBe("bun run --cwd sidecar build");
		// A satellite must ship from its own tree: no @ryuhq/sdk, and no `ryu pack`
		// (there is no widget bundle to pack).
		expect(pkg.dependencies).toBeUndefined();
		expect(pkg.scripts.pack).toBeUndefined();
	});

	it("the sidecar's own package.json names the binary the manifest spawns", () => {
		const raw = readRawManifest(projectDir);
		const command = raw.sidecars[0]?.process.command;
		const pkg = PackageSchema.parse(
			JSON.parse(readFileSync(join(projectDir, "sidecar/package.json"), "utf8"))
		);
		expect(Object.keys(pkg.bin)).toContain(command);
		// Dependency-free by design (node:http + node:crypto only).
		expect(pkg.dependencies).toBeUndefined();
	});

	it("the sidecar serves every route the manifest declares", async () => {
		const control: ControlModule = await import(
			join(projectDir, "sidecar/src/main/control.ts")
		);
		const deps = { store: new control.MemoryItemStore(), token: "tok" };
		const auth = "Bearer tok";

		// `/health` — the health_path Core probes, deliberately unauthenticated.
		expect(
			control.handleRequest("GET", "/health", undefined, "", deps).status
		).toBe(200);

		// `/` — the capability root `provides[].route` points at.
		const root = control.handleRequest("GET", "/", auth, "", deps);
		expect(root.status).toBe(200);
		expect(
			z.object({ capability: z.string() }).parse(root.json).capability
		).toBe(control.CAPABILITY);

		// `/items` + `/items/:id` — the declared collection and item routes.
		expect(control.handleRequest("GET", "/items", auth, "", deps).status).toBe(
			200
		);
		const created = control.handleRequest(
			"POST",
			"/items",
			auth,
			JSON.stringify({ text: "hello" }),
			deps
		);
		expect(created.status).toBe(201);
		const id = z
			.object({ item: z.object({ id: z.string() }) })
			.parse(created.json).item.id;
		expect(
			control.handleRequest("GET", `/items/${id}`, auth, "", deps).status
		).toBe(200);
		expect(
			control.handleRequest("DELETE", `/items/${id}`, auth, "", deps).status
		).toBe(200);
	});

	it("the sidecar decodes item text and rejects malformed request bodies", async () => {
		const control: ControlModule = await import(
			join(projectDir, "sidecar/src/main/control.ts")
		);
		const deps = { store: new control.MemoryItemStore(), token: "tok" };
		for (const body of [
			"{",
			"null",
			"[]",
			"1",
			"{}",
			'{"text":2}',
			'{"text":{}}',
		]) {
			expect(
				control.handleRequest("POST", "/items", "Bearer tok", body, deps).status
			).toBe(400);
		}
		expect(deps.store.list()).toEqual([]);
		const created = control.handleRequest(
			"POST",
			"/items",
			"Bearer tok",
			'{"text":"  hello  "}',
			deps
		);
		expect(created.status).toBe(201);
		expect(created.json?.item?.text).toBe("hello");
	});

	it("the sidecar fails closed when no token is injected", async () => {
		const control: ControlModule = await import(
			join(projectDir, "sidecar/src/main/control.ts")
		);
		const store = new control.MemoryItemStore();

		// No token configured ⇒ every protected route 401s, even with a bearer.
		expect(control.resolveControlToken({})).toBeNull();
		const closed = { store, token: null };
		expect(
			control.handleRequest("GET", "/items", "Bearer x", "", closed).status
		).toBe(401);
		// …but health stays reachable so Core can still see the process is alive.
		expect(
			control.handleRequest("GET", "/health", undefined, "", closed).status
		).toBe(200);

		// A token IS configured but the caller presents none/the wrong one ⇒ 401.
		const open = { store, token: "tok" };
		expect(
			control.handleRequest("GET", "/items", undefined, "", open).status
		).toBe(401);
		expect(
			control.handleRequest("GET", "/items", "Bearer nope", "", open).status
		).toBe(401);
	});

	it("the sidecar reads its bind port from the injected env var", async () => {
		const control: ControlModule = await import(
			join(projectDir, "sidecar/src/main/control.ts")
		);
		const raw = readRawManifest(projectDir);
		const sidecar = raw.sidecars[0];

		// Core injects the profile-shifted port under `port_env`; honouring it is
		// what keeps a dev-profile node from health-checking a port the child never
		// bound.
		expect(control.resolveControlPort({ RYU_MY_APP_PORT: "9123" })).toBe(9123);
		expect(control.resolveControlPort({})).toBe(sidecar?.port);
	});
});
