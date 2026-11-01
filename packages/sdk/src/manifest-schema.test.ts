// Pure-zod tests for the manifest schema seams that gate what an author can pack:
// the semver regex (Core-lockstep), the anti-impersonation companion-label refine,
// and the RunnableMeta identity contract. These need no native addon — they exercise
// the TS-authoring zod layer directly, documenting the ACTUAL accept/reject boundary
// (including the deliberate substring behavior of the impersonation check).

import { describe, expect, test } from "bun:test";
import {
	ChatWidgetTemplateSchema,
	CompanionSurfaceSchema,
	labelImpersonatesSystemChrome,
	type PluginManifest,
	PluginManifestSchema,
	RunnableMetaSchema,
} from "./manifest.ts";

function baseManifest(
	overrides: Partial<Pick<PluginManifest, "version">> = {}
) {
	return {
		id: "com.example.app",
		name: "App",
		version: "1.0.0",
		runnables: [],
		...overrides,
	};
}

test("chat widget templates keep host rendering data-only and forward compatible", () => {
	const available = ChatWidgetTemplateSchema.safeParse({
		id: "meetings.chat",
		title: "Meetings widget",
		triggers: ["meetings widget"],
		examples: ["Show my meetings"],
		backing: { view_id: "surface:meetings" },
		display_mode: "inline",
		safe_action_ids: ["refresh"],
	}).success;
	const comingSoon = ChatWidgetTemplateSchema.safeParse({
		id: "future.chat",
		title: "Future widget",
		backing: {},
		display_mode: "compact-future-mode",
		availability: "coming-soon",
	}).success;
	const unsafe = ChatWidgetTemplateSchema.safeParse({
		id: "future/chat",
		title: "Unsafe",
		backing: { tool_id: "future.render" },
		display_mode: "inline",
	}).success;
	expect(available).toBe(true);
	expect(comingSoon).toBe(true);
	expect(unsafe).toBe(false);
});

// ── semver regex ──────────────────────────────────────────────────────────────

describe("PluginManifest version (semver regex)", () => {
	test("accepts plain MAJOR.MINOR.PATCH", () => {
		expect(
			PluginManifestSchema.safeParse(baseManifest({ version: "1.0.0" })).success
		).toBe(true);
		expect(
			PluginManifestSchema.safeParse(baseManifest({ version: "10.20.30" }))
				.success
		).toBe(true);
	});

	test("accepts a prerelease tag (1.0.0-beta.1)", () => {
		expect(
			PluginManifestSchema.safeParse(baseManifest({ version: "1.0.0-beta.1" }))
				.success
		).toBe(true);
	});

	test("accepts build metadata (1.0.0+build.5) and both together", () => {
		expect(
			PluginManifestSchema.safeParse(baseManifest({ version: "1.0.0+build.5" }))
				.success
		).toBe(true);
		expect(
			PluginManifestSchema.safeParse(
				baseManifest({ version: "1.2.3-rc.1+exp.sha.5114f85" })
			).success
		).toBe(true);
	});

	test("rejects a two-segment version (1.0)", () => {
		expect(
			PluginManifestSchema.safeParse(baseManifest({ version: "1.0" })).success
		).toBe(false);
	});

	test("rejects a leading-v version (v1.0.0)", () => {
		expect(
			PluginManifestSchema.safeParse(baseManifest({ version: "v1.0.0" }))
				.success
		).toBe(false);
	});

	test("rejects a non-numeric segment (1.0.x)", () => {
		expect(
			PluginManifestSchema.safeParse(baseManifest({ version: "1.0.x" })).success
		).toBe(false);
	});

	test("rejects an empty version", () => {
		expect(
			PluginManifestSchema.safeParse(baseManifest({ version: "" })).success
		).toBe(false);
	});
});

// ── labelImpersonatesSystemChrome (substring, case-insensitive) ───────────────

describe("labelImpersonatesSystemChrome", () => {
	test("flags any label containing 'ryu' or 'system', case-insensitively", () => {
		for (const bad of [
			"Ryu",
			"ryu panel",
			"My RYU thing",
			"System",
			"system tools",
			"SYSTEM",
		]) {
			expect(labelImpersonatesSystemChrome(bad)).toBe(true);
		}
	});

	test("is a raw substring match — 'systematic' and 'ryusaki' are flagged (documents behavior)", () => {
		// The check is a deliberate substring test, not word-boundary aware. These
		// false-positive-looking cases are the ACTUAL contract; pin them so a future
		// change is conscious.
		expect(labelImpersonatesSystemChrome("systematic review")).toBe(true);
		expect(labelImpersonatesSystemChrome("ryusaki")).toBe(true);
	});

	test("allows an ordinary third-party label", () => {
		for (const ok of ["Whiteboard", "Mail", "Kanban Board", "Notes"]) {
			expect(labelImpersonatesSystemChrome(ok)).toBe(false);
		}
	});
});

// ── CompanionSurfaceSchema refine ─────────────────────────────────────────────

describe("CompanionSurfaceSchema", () => {
	test("accepts a clean label with optional icon + shortcut", () => {
		const parsed = CompanionSurfaceSchema.safeParse({
			label: "Whiteboard",
			icon: "sparkles",
			shortcut: "ctrl+shift+w",
		});
		expect(parsed.success).toBe(true);
	});

	test("rejects an empty label (min(1))", () => {
		expect(CompanionSurfaceSchema.safeParse({ label: "" }).success).toBe(false);
	});

	test("rejects a label that impersonates system chrome, with the documented message", () => {
		const parsed = CompanionSurfaceSchema.safeParse({ label: "Ryu Settings" });
		expect(parsed.success).toBe(false);
		if (parsed.success) {
			return;
		}
		expect(parsed.error.issues[0]?.message).toContain(
			"impersonate system chrome"
		);
	});
});

// ── RunnableMetaSchema identity contract ──────────────────────────────────────

describe("RunnableMetaSchema", () => {
	test("requires a non-empty id and name", () => {
		expect(
			RunnableMetaSchema.safeParse({ id: "", name: "X", kind: "agent" }).success
		).toBe(false);
		expect(
			RunnableMetaSchema.safeParse({ id: "x", name: "", kind: "agent" }).success
		).toBe(false);
	});

	test("rejects an unknown kind", () => {
		expect(
			RunnableMetaSchema.safeParse({ id: "x", name: "X", kind: "daemon" })
				.success
		).toBe(false);
	});

	test("accepts each of the known kinds", () => {
		for (const kind of [
			"agent",
			"workflow",
			"tool",
			"skill",
			"companion",
			"policy",
		]) {
			expect(
				RunnableMetaSchema.safeParse({ id: "x", name: "X", kind }).success
			).toBe(true);
		}
	});

	test("keeps an opaque per-kind config record", () => {
		const parsed = RunnableMetaSchema.safeParse({
			id: "x",
			name: "X",
			kind: "tool",
			config: { widget: true, slug: "x.render" },
		});
		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			return;
		}
		expect(parsed.data.config?.widget).toBe(true);
	});

	test("accepts a null config like Core and the JSON Schema", () => {
		for (const kind of ["agent", "tool", "workflow"]) {
			const parsed = RunnableMetaSchema.safeParse({
				id: "x",
				name: "X",
				kind,
				config: null,
			});
			expect(parsed.success).toBe(true);
		}
		expect(
			PluginManifestSchema.safeParse({
				id: "com.acme.null-config",
				name: "Null config",
				version: "1.0.0",
				runnables: [
					{ id: "agent", name: "Agent", kind: "agent", config: null },
				],
			}).success
		).toBe(true);
	});

	test("still refuses a config that is not an object", () => {
		for (const config of ["agent", 1, ["managed"]]) {
			expect(
				RunnableMetaSchema.safeParse({
					id: "x",
					name: "X",
					kind: "tool",
					config,
				}).success
			).toBe(false);
		}
	});

	test("accepts each agent identity mode, or none", () => {
		for (const identity_mode of ["managed", "individual", "mixed", null]) {
			expect(
				RunnableMetaSchema.safeParse({
					id: "x",
					name: "X",
					kind: "agent",
					config: { identity_mode },
				}).success
			).toBe(true);
		}
		expect(
			RunnableMetaSchema.safeParse({
				id: "x",
				name: "X",
				kind: "agent",
				config: { model: "m" },
			}).success
		).toBe(true);
	});

	test("refuses an unknown agent identity mode", () => {
		for (const identity_mode of ["owner", "MANAGED", "", 1]) {
			const parsed = RunnableMetaSchema.safeParse({
				id: "x",
				name: "X",
				kind: "agent",
				config: { identity_mode },
			});
			expect(parsed.success).toBe(false);
			expect(parsed.error?.issues[0]?.path).toEqual([
				"config",
				"identity_mode",
			]);
		}
	});

	test("refuses an app-supplied account allowlist on an agent, even null", () => {
		for (const account_access of [["platform:treg"], [], null]) {
			const parsed = RunnableMetaSchema.safeParse({
				id: "x",
				name: "X",
				kind: "agent",
				config: { identity_mode: "mixed", account_access },
			});
			expect(parsed.success).toBe(false);
			expect(parsed.error?.issues[0]?.path).toEqual([
				"config",
				"account_access",
			]);
		}
	});

	test("leaves identity keys on non-agent configs to Core's per-kind rules", () => {
		expect(
			RunnableMetaSchema.safeParse({
				id: "x",
				name: "X",
				kind: "tool",
				config: { slug: "x.y", identity_mode: "owner" },
			}).success
		).toBe(true);
	});
});

describe("PluginManifestSchema deprecated", () => {
	test("accepts the three authoring shapes and rejects anything else", () => {
		for (const deprecated of [
			true,
			false,
			"Use @acme/new instead.",
			{ message: "Superseded.", replacement: "@acme/new" },
			{},
		]) {
			expect(
				PluginManifestSchema.safeParse({ ...baseManifest(), deprecated })
					.success,
				JSON.stringify(deprecated)
			).toBe(true);
		}
		for (const deprecated of [1, ["x"], { reason: "typo'd key" }]) {
			expect(
				PluginManifestSchema.safeParse({ ...baseManifest(), deprecated })
					.success,
				JSON.stringify(deprecated)
			).toBe(false);
		}
	});
});
