import { expect, test } from "bun:test";
import { hasReferenceCycle } from "./reference-cycle.ts";

test("scalars and acyclic documents are not cycles", () => {
	expect(hasReferenceCycle(null)).toBe(false);
	expect(hasReferenceCycle("text")).toBe(false);
	expect(hasReferenceCycle({ a: [1, { b: null }], c: "x" })).toBe(false);
});

test("a shared reference is not a cycle", () => {
	const shared = { value: 1 };
	expect(hasReferenceCycle({ left: shared, right: [shared, shared] })).toBe(
		false
	);
});

test("an object that reaches itself is a cycle", () => {
	const self: Record<string, unknown> = {};
	self.self = self;
	expect(hasReferenceCycle(self)).toBe(true);
	const child: Record<string, unknown> = {};
	const outer: Record<string, unknown> = { inner: [child] };
	child.outer = outer;
	expect(hasReferenceCycle(outer)).toBe(true);
});

test("a deep acyclic chain does not overflow the stack", () => {
	let head: Record<string, unknown> = {};
	for (let depth = 0; depth < 50_000; depth += 1) {
		head = { next: head };
	}
	expect(hasReferenceCycle(head)).toBe(false);
});
