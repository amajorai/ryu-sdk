/**
 * create-ryu-app widget templates: `ryu-app` (an in-chat widget) and
 * `companion-plugin` (a widget that calls a companion tool, plus a panel).
 *
 * Asserts the manifest shape (widget bound to a ui:// resource, companion tool +
 * surface) and that each stamped src/app.ts defineApp output deep-equals the
 * shipped manifest.json, proving the two never drift.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { scaffold } from "./index.ts";
import { PackageSchema, readManifest } from "./test-helpers.ts";

// ── ryu-app template ───────────────────────────────────────────────────────────

describe("create-ryu-app scaffold (ryu-app)", () => {
	let tmpDir: string;
	let projectDir: string;

	beforeAll(() => {
		tmpDir = join(import.meta.dir, `__test-ryuapp-${Date.now()}`);
		projectDir = scaffold("my-widget", tmpDir, "ryu-app");
	});

	afterAll(() => {
		if (existsSync(tmpDir)) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("produces the expected file set including a widget entry", () => {
		for (const file of [
			"manifest.json",
			"src/app.ts",
			"src/widget.tsx",
			"src/index.html",
			"package.json",
		]) {
			expect(existsSync(join(projectDir, file))).toBe(true);
		}
	});

	it("manifest declares a render widget bound to a ui:// resource", () => {
		const parsed = readManifest(projectDir);
		expect(parsed.id).toBe("com.example.my-widget");
		const widgets = parsed.contributes?.widgets ?? [];
		expect(widgets).toHaveLength(1);
		expect(widgets[0]?.uri).toBe("ui://widget/my-widget.html");
		expect(widgets[0]?.tool_id).toBe("my-widget.render");
		const render = parsed.runnables.find((r) => r.id === "my-widget.render");
		expect(render?.kind).toBe("tool");
		expect(
			z.object({ widget: z.boolean().optional() }).parse(render?.config).widget
		).toBe(true);
	});

	it("stamped src/app.ts defineApp output deep-equals the shipped manifest.json", async () => {
		const mod = await import(join(projectDir, "src/app.ts"));
		expect(mod.default).toEqual(readManifest(projectDir));
	});

	it("the widget source is CSP-safe (no network egress)", () => {
		const widget = readFileSync(join(projectDir, "src/widget.tsx"), "utf8");
		expect(widget).not.toContain("fetch(");
		expect(widget).not.toContain("http://");
		expect(widget).not.toContain("https://");
		expect(widget).toContain("window.openai");
	});

	it("package.json pulls in React for the widget bundle", () => {
		const pkg = PackageSchema.parse(
			JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8"))
		);
		expect(pkg.dependencies.react).toBeDefined();
		expect(pkg.dependencies["react-dom"]).toBeDefined();
	});
});

// ── companion-plugin template ──────────────────────────────────────────────────

describe("create-ryu-app scaffold (companion-plugin)", () => {
	let tmpDir: string;
	let projectDir: string;

	beforeAll(() => {
		tmpDir = join(import.meta.dir, `__test-companion-${Date.now()}`);
		projectDir = scaffold("my-panel", tmpDir, "companion-plugin");
	});

	afterAll(() => {
		if (existsSync(tmpDir)) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("declares an accessible companion tool the widget can call", () => {
		const parsed = readManifest(projectDir);
		const save = parsed.runnables.find((r) => r.id === "my-panel.save");
		expect(save).toBeDefined();
		expect(
			z
				.object({ widget_accessible: z.boolean().optional() })
				.parse(save?.config).widget_accessible
		).toBe(true);
		// The render tool's widget may call companions because one exists.
		const render = parsed.runnables.find((r) => r.id === "my-panel.render");
		expect(
			z
				.object({ widget_accessible: z.boolean().optional() })
				.parse(render?.config).widget_accessible
		).toBe(true);
	});

	it("declares a companion surface whose label never impersonates system chrome", () => {
		const parsed = readManifest(projectDir);
		expect(parsed.companion?.label).toBeDefined();
		const label = (parsed.companion?.label ?? "").toLowerCase();
		expect(label.includes("ryu")).toBe(false);
		expect(label.includes("system")).toBe(false);
	});

	it("stamped src/app.ts defineApp output deep-equals the shipped manifest.json", async () => {
		const mod = await import(join(projectDir, "src/app.ts"));
		expect(mod.default).toEqual(readManifest(projectDir));
	});

	it("the widget calls the companion tool via the host bridge", () => {
		const widget = readFileSync(join(projectDir, "src/widget.tsx"), "utf8");
		expect(widget).toContain("callTool");
		expect(widget).toContain("my-panel.save");
		expect(widget).not.toContain("fetch(");
	});
});
