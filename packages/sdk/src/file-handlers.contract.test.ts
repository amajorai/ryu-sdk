import { expect, test } from "bun:test";
import { PluginManifestSchema } from "./manifest.ts";

test("SDK authoring preserves canonical fileHandlers", () => {
	const manifest = PluginManifestSchema.parse({
		id: "@example/editor",
		name: "Editor",
		version: "1.0.0",
		runnables: [],
		contributes: {
			fileHandlers: [
				{
					id: "editor",
					title: "Editor",
					extensions: ["txt"],
					companion: "editor",
					editable: true,
				},
			],
		},
	});
	expect(manifest.contributes?.fileHandlers?.[0]?.editable).toBe(true);
});

test("SDK file extensions reject traversal", () => {
	expect(() =>
		PluginManifestSchema.parse({
			id: "@example/editor",
			name: "Editor",
			version: "1.0.0",
			runnables: [],
			contributes: {
				fileHandlers: [
					{
						id: "editor",
						title: "Editor",
						extensions: ["../txt"],
						companion: "editor",
					},
				],
			},
		})
	).toThrow();
});
