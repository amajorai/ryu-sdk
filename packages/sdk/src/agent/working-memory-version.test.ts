/**
 * The SDK tool's optimistic-concurrency text and argument parsing, which
 * mirror Core's built-in `update_working_memory` tool.
 */

import { describe, expect, test } from "bun:test";
import {
	conflictMessage,
	parseExpectedVersion,
	versionInstructions,
} from "./working-memory-version.ts";

describe("working memory versions", () => {
	test("parses expected_version like Core", () => {
		expect(parseExpectedVersion(undefined)).toBeUndefined();
		expect(parseExpectedVersion(null)).toBeUndefined();
		expect(parseExpectedVersion(0)).toBe(0);
		expect(parseExpectedVersion(4)).toBe(4);
		// Some models quote numbers.
		expect(parseExpectedVersion(" 7 ")).toBe(7);
		for (const bad of [-1, 1.5, "soon", "", [4], { v: 1 }, true]) {
			expect(() => parseExpectedVersion(bad)).toThrow("non-negative integer");
		}
	});

	test("the block instructions name the version to send back", () => {
		const text = versionInstructions(3);
		expect(text).toContain("This is version 3: pass `expected_version: 3`");
		expect(text).toContain("merge your change into the current document");
	});

	test("the conflict message carries the current document", () => {
		const base = {
			createdAt: 1,
			id: "t",
			scope: "thread" as const,
			updatedAt: 2,
			version: 5,
		};
		const template = conflictMessage("update_working_memory", 4, 5, {
			...base,
			content: "# Notes\n- kept\n",
			mode: "template",
		});
		expect(template).toContain("you sent expected_version 4");
		expect(template).toContain("Your update was NOT saved");
		expect(template).toContain(
			"call `update_working_memory` again with expected_version: 5."
		);
		expect(
			template.endsWith("Current document (version 5):\n# Notes\n- kept")
		).toBe(true);

		const schema = conflictMessage("update_working_memory", 0, 5, {
			...base,
			data: { plan: "pro" },
			mode: "schema",
		});
		expect(schema).toContain('"plan": "pro"');

		const empty = conflictMessage("update_working_memory", 0, 5, {
			...base,
			content: "  ",
			mode: "template",
		});
		expect(empty).toContain("The current document is empty.");

		const unread = conflictMessage("update_working_memory", 3, 0, null);
		expect(unread).toContain("expected_version: 0.");
		expect(unread).not.toContain("Current document");
	});
});
