import { expect, test } from "bun:test";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { PluginManifestSchema } from "./manifest.ts";

const legacy = {
	id: "com.test.optional",
	name: "Optional",
	version: "1.0.0",
	runnables: [],
	permission_grants: ["usage:read"],
};

test("old signed pack surface does not gain an empty optional field", () => {
	const parsed = PluginManifestSchema.parse(legacy);
	expect("optional_permission_grants" in parsed).toBe(false);
	const keys = generateKeyPairSync("ed25519");
	const packed = JSON.stringify(parsed);
	const signature = sign(null, Buffer.from(packed), keys.privateKey);
	const restored = PluginManifestSchema.parse(JSON.parse(packed));
	expect(
		verify(
			null,
			Buffer.from(JSON.stringify(restored)),
			keys.publicKey,
			signature
		)
	).toBe(true);
});

test("optional grants remain inside the signed pack surface", () => {
	const parsed = PluginManifestSchema.parse({
		...legacy,
		optional_permission_grants: ["usage:audit"],
	});
	const keys = generateKeyPairSync("ed25519");
	const packed = JSON.stringify(parsed);
	const signature = sign(null, Buffer.from(packed), keys.privateKey);
	const restored = PluginManifestSchema.parse(JSON.parse(packed));
	expect(restored.optional_permission_grants).toEqual(["usage:audit"]);
	expect(
		verify(
			null,
			Buffer.from(JSON.stringify(restored)),
			keys.publicKey,
			signature
		)
	).toBe(true);
	expect(
		verify(
			null,
			Buffer.from(
				JSON.stringify({ ...restored, optional_permission_grants: [] })
			),
			keys.publicKey,
			signature
		)
	).toBe(false);
	expect(
		PluginManifestSchema.safeParse({
			...legacy,
			optional_permission_grants: "usage:audit",
		}).success
	).toBe(false);
});
