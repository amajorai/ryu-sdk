import { describe, expect, it } from "bun:test";
import type { AgUiJson } from "./events.ts";
import { applyJsonPatch, diffJsonState, jsonEqual } from "./json-patch.ts";

describe("diffJsonState", () => {
	it("returns no operations for equal states", () => {
		expect(diffJsonState({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toEqual(
			[]
		);
	});

	it("diffs objects key by key and escapes pointer segments", () => {
		const prev: AgUiJson = {
			keep: 1,
			drop: true,
			nested: { "a/b": 1, "c~d": 2 },
		};
		const next: AgUiJson = {
			keep: 1,
			nested: { "a/b": 3, "c~d": 2 },
			added: [1],
		};
		const patch = diffJsonState(prev, next);
		expect(patch).toEqual([
			{ op: "remove", path: "/drop" },
			{ op: "replace", path: "/nested/a~1b", value: 3 },
			{ op: "add", path: "/added", value: [1] },
		]);
		expect(applyJsonPatch(prev, patch)).toEqual(next);
	});

	it("replaces arrays and scalars whole, including the root", () => {
		expect(diffJsonState({ list: [1, 2] }, { list: [1, 2, 3] })).toEqual([
			{ op: "replace", path: "/list", value: [1, 2, 3] },
		]);
		expect(diffJsonState(1, "x")).toEqual([
			{ op: "replace", path: "", value: "x" },
		]);
	});
});

describe("applyJsonPatch", () => {
	it("supports add into arrays, move, copy, test, and leaves the input untouched", () => {
		const doc: AgUiJson = { items: ["a", "c"], meta: { owner: "x" } };
		const out = applyJsonPatch(doc, [
			{ op: "add", path: "/items/1", value: "b" },
			{ op: "add", path: "/items/-", value: "d" },
			{ op: "copy", from: "/meta/owner", path: "/owner" },
			{ op: "move", from: "/meta", path: "/info" },
			{ op: "test", path: "/owner", value: "x" },
		]);
		expect(out).toEqual({
			items: ["a", "b", "c", "d"],
			owner: "x",
			info: { owner: "x" },
		});
		expect(doc).toEqual({ items: ["a", "c"], meta: { owner: "x" } });
	});

	it("rejects failed tests and missing targets", () => {
		expect(() =>
			applyJsonPatch({ a: 1 }, [{ op: "test", path: "/a", value: 2 }])
		).toThrow("test failed");
		expect(() =>
			applyJsonPatch({ a: 1 }, [{ op: "remove", path: "/b" }])
		).toThrow("missing");
		expect(() =>
			applyJsonPatch([1], [{ op: "replace", path: "/4", value: 1 }])
		).toThrow("out of range");
	});

	it("compares JSON structurally", () => {
		expect(jsonEqual({ a: [1, null] }, { a: [1, null] })).toBe(true);
		expect(jsonEqual({ a: 1 }, { b: 1 })).toBe(false);
		expect(jsonEqual([1], { 0: 1 })).toBe(false);
	});
});
