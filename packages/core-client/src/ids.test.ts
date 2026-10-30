import { expect, test } from "bun:test";
import { createResourceId } from "./ids.ts";

test("resource UUIDs work in a WebView exposing only getRandomValues", () => {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
	const original = globalThis.crypto;
	try {
		Object.defineProperty(globalThis, "crypto", {
			configurable: true,
			value: { getRandomValues: original.getRandomValues.bind(original) },
		});
		const id = createResourceId();
		expect(id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
		);
		expect(createResourceId()).not.toBe(id);
	} finally {
		if (descriptor) {
			Object.defineProperty(globalThis, "crypto", descriptor);
		}
	}
});
