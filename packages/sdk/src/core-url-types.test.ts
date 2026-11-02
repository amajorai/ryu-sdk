import { describe, expect, test } from "bun:test";
import type { CoreUrlOptions } from "./core-env.ts";
import type { CoreDocumentParserOptions } from "./loaders/file.ts";
import {
	type CoreTarget,
	coreBase,
	type RyuVaultSecretOptions,
} from "./loaders/net.ts";
import type { HttpPrimitiveTransportOptions } from "./runnable/primitives.ts";

/**
 * Pins the public Core-target option types as interfaces with statically
 * known members, so downstream `interface X extends CoreTarget {}` keeps
 * compiling (TS2312 if any of them becomes a union type alias again). The
 * "one of baseUrl / nodeUrl" rule is enforced at runtime instead.
 */

interface ExtendsCoreTarget extends CoreTarget {
	label?: string;
}
interface ExtendsTransport extends HttpPrimitiveTransportOptions {
	label?: string;
}
interface ExtendsParser extends CoreDocumentParserOptions {
	label?: string;
}
interface ExtendsVault extends RyuVaultSecretOptions {
	label?: string;
}
interface ExtendsUrlOptions extends CoreUrlOptions {
	label?: string;
}

describe("Core URL option types", () => {
	test("stay extendable interfaces and accept either URL name", () => {
		const legacy: ExtendsCoreTarget = { nodeUrl: "http://old/", label: "a" };
		const current: ExtendsCoreTarget = { baseUrl: "http://new" };
		const transport: ExtendsTransport = { baseUrl: "http://t" };
		const parser: ExtendsParser = { nodeUrl: "http://p", timeoutMs: 1 };
		const vault: ExtendsVault = { baseUrl: "http://v", name: "TOKEN" };
		const urls: ExtendsUrlOptions = {};
		expect(coreBase(legacy)).toBe("http://old");
		expect(coreBase(current)).toBe("http://new");
		expect(coreBase(transport)).toBe("http://t");
		expect(coreBase(parser)).toBe("http://p");
		expect(coreBase(vault)).toBe("http://v");
		expect(() => coreBase(urls)).toThrow(/Core URL is required/);
	});
});
