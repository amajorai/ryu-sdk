import { describe, expect, it } from "bun:test";
import { PluginManifestSchema } from "../manifest.ts";
import { appToolId, defineApp, WIDGET_RENDER_GRANT } from "./app.ts";

/** A minimal single-render-tool app — the shape both scaffold templates emit. */
function checklistApp(grants?: string[]) {
	return defineApp({
		id: "com.example.checklist",
		slug: "checklist",
		title: "Checklist",
		version: "1.0.0",
		uiEntry: "src/checklist.tsx",
		...(grants ? { grants } : {}),
		tools: [{ name: "render", description: "Render a checklist" }],
	});
}

describe("defineApp widget grant", () => {
	it("declares widget:render for an app that contributes a widget", () => {
		// The whole point: Core refuses to promote a widget whose owning plugin
		// lacks this grant, and the refusal is an info-log — the widget just
		// silently renders as text. An app scaffolded with no `grants` used to hit
		// that every time.
		const manifest = checklistApp();
		expect(manifest.contributes?.widgets ?? []).toHaveLength(1);
		expect(manifest.permission_grants).toContain(WIDGET_RENDER_GRANT);
	});

	it("keeps the author's own grants and appends, never replaces", () => {
		const manifest = checklistApp(["mcp:web_search"]);
		expect(manifest.permission_grants).toEqual([
			"mcp:web_search",
			WIDGET_RENDER_GRANT,
		]);
	});

	it("does not duplicate a grant the author already declared", () => {
		const manifest = checklistApp([WIDGET_RENDER_GRANT]);
		expect(
			manifest.permission_grants?.filter((g) => g === WIDGET_RENDER_GRANT)
		).toHaveLength(1);
	});

	it("does not add the grant to an app that contributes no widget", () => {
		// Every tool marked `accessible` is a companion (call target), so nothing
		// renders — the grant would be an unused capability on the record.
		const manifest = defineApp({
			id: "com.example.tools",
			slug: "tools",
			title: "Tools",
			version: "1.0.0",
			uiEntry: "src/tools.tsx",
			tools: [{ name: "toggle", description: "Toggle", accessible: true }],
		});
		expect(manifest.contributes?.widgets ?? []).toHaveLength(0);
		expect(manifest.permission_grants ?? []).not.toContain(WIDGET_RENDER_GRANT);
	});

	it("still emits a manifest Core's own schema accepts", () => {
		expect(() => PluginManifestSchema.parse(checklistApp())).not.toThrow();
	});

	it("binds the widget to the render tool's fully-qualified id", () => {
		const manifest = checklistApp();
		expect(manifest.contributes?.widgets?.[0]?.tool_id).toBe(
			appToolId("checklist", "render")
		);
	});
});
