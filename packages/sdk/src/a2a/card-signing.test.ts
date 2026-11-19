/**
 * Agent Card signature tests. The JCS and thumbprint vectors are the ones
 * Core's `card_signing.rs` tests assert, plus the RFC 8037 Appendix A.4
 * Ed25519 JWS, so this verifier agrees with Core byte for byte.
 */

import { describe, expect, it } from "bun:test";
import { z } from "zod";
import type { PrimitiveJsonValue } from "../runnable/primitive-contracts.ts";
import {
	fixtureSigningKey,
	sampleCard,
	signCard,
} from "./card-signing.fixtures.ts";
import {
	agentCardSigningPayload,
	base64UrlDecode,
	base64UrlEncode,
	type CardVerificationKey,
	canonicalizeJson,
	ed25519JwkThumbprint,
	ed25519KeysFromJwks,
	importEd25519PublicKey,
	type KeyResolution,
	verifyAgentCardSignatures,
} from "./card-signing.ts";
import { A2AEndpointError, validateEndpoint } from "./endpoint.ts";

const JKU = "https://node.example.com/a2a-card/jwks.json";

function resolver(keys: CardVerificationKey[]) {
	return (header: { kid?: string }): KeyResolution => {
		const match = keys.find((key) => key.kid === header.kid);
		return match
			? { kind: "found", key: match.key }
			: { kind: "not_published" };
	};
}

function reversedText(value: PrimitiveJsonValue): string {
	if (Array.isArray(value)) {
		return `[ ${value.map(reversedText).join(" , ")} ]`;
	}
	if (value !== null && Object.getPrototypeOf(value) === Object.prototype) {
		return `{ ${Object.entries(value)
			.reverse()
			.map(([key, item]) => `${JSON.stringify(key)} : ${reversedText(item)}`)
			.join(" , ")} }`;
	}
	return JSON.stringify(value);
}

describe("canonicalizeJson (RFC 8785)", () => {
	it("matches Core's JCS object vector", () => {
		const value = JSON.parse(
			'{"b":[1,2.5,{"y":null,"x":true}],"a":"\\u20ac\\n\\u0001\\"","é":0,"€":1,"😀":2,"\\r":3}'
		);
		expect(canonicalizeJson(value)).toBe(
			'{"\\r":3,"a":"€\\n\\u0001\\"","b":[1,2.5,{"x":true,"y":null}],"é":0,"€":1,"😀":2}'
		);
	});

	it("serializes numbers like ECMAScript (RFC 8785 Appendix B)", () => {
		const cases: [number, string][] = [
			[0, "0"],
			[-0, "0"],
			[1e30, "1e+30"],
			[4.5, "4.5"],
			[2e-3, "0.002"],
			[0.000_001, "0.000001"],
			[1e-7, "1e-7"],
			[123_456_789_012_345_680_000, "123456789012345680000"],
			[1e21, "1e+21"],
			[9_007_199_254_740_992, "9007199254740992"],
			[295_147_905_179_352_830_000, "295147905179352830000"],
			[-1.5e-10, "-1.5e-10"],
			[5e-324, "5e-324"],
			[1.797_693_134_862_315_7e308, "1.7976931348623157e+308"],
			[333_333_333.333_333_3, "333333333.3333333"],
			[-17, "-17"],
			[9_007_199_254_740_991, "9007199254740991"],
		];
		for (const [input, expected] of cases) {
			expect(canonicalizeJson(input)).toBe(expected);
		}
	});
});

describe("keys", () => {
	it("computes the RFC 8037 Appendix A.3 thumbprint", async () => {
		const x = base64UrlDecode("11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo");
		expect(x).toBeDefined();
		expect(await ed25519JwkThumbprint(x ?? new Uint8Array())).toBe(
			"kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k"
		);
	});

	it("verifies the RFC 8037 Appendix A.4 Ed25519 JWS", async () => {
		const x = base64UrlDecode("11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo");
		const key = await importEd25519PublicKey(x ?? new Uint8Array());
		const signature = base64UrlDecode(
			"hgyY0il_MGCjP0JzlnLWG1PPOt7-09PGcvMg3AIbQR6dWbhijcNR4ki4iylGjg5BhVsPt9g7sVvpAr_MuM0KAg"
		);
		expect(key).toBeDefined();
		const valid = await crypto.subtle.verify(
			{ name: "Ed25519" },
			key ?? never(),
			new Uint8Array(signature ?? new Uint8Array()),
			new TextEncoder().encode(
				"eyJhbGciOiJFZERTQSJ9.RXhhbXBsZSBvZiBFZDI1NTE5IHNpZ25pbmc"
			)
		);
		expect(valid).toBe(true);
	});

	it("reads Ed25519 signing keys from a JWKS and skips others", async () => {
		const signer = await fixtureSigningKey(0x41);
		const keys = await ed25519KeysFromJwks({
			keys: [
				...signer.jwks.keys,
				{ kty: "OKP", crv: "X25519", x: "AA" },
				{
					kty: "OKP",
					crv: "Ed25519",
					x: signer.jwks.keys[0]?.x ?? "",
					use: "enc",
				},
				{ kty: "OKP", crv: "Ed25519", x: signer.jwks.keys[0]?.x ?? "" },
			],
		});
		expect(keys.map((key) => key.kid)).toEqual([signer.kid, signer.kid]);
	});

	it("rejects non-canonical base64url", () => {
		expect(base64UrlDecode("AA==")).toBeUndefined();
		expect(base64UrlDecode("AB")).toBeUndefined();
		expect(base64UrlEncode(base64UrlDecode("AA") ?? new Uint8Array())).toBe(
			"AA"
		);
	});
});

function never(): never {
	throw new Error("missing key");
}

describe("verifyAgentCardSignatures", () => {
	it("verifies a signed card against its published key", async () => {
		const signer = await fixtureSigningKey(0x41);
		const card = await signCard(sampleCard(), signer, JKU);
		const keys = await ed25519KeysFromJwks(signer.jwks);
		expect(await verifyAgentCardSignatures(card, resolver(keys))).toEqual({
			status: "verified",
			kid: signer.kid,
			jku: JKU,
		});
	});

	it("rejects tampered content and swapped endpoints", async () => {
		const signer = await fixtureSigningKey(0x41);
		const keys = await ed25519KeysFromJwks(signer.jwks);
		const card = await signCard(sampleCard(), signer, JKU);
		const renamed = { ...card, name: "Impostor" };
		expect(await verifyAgentCardSignatures(renamed, resolver(keys))).toEqual({
			status: "invalid",
			reason: "signature does not match the card",
		});
		const moved = {
			...card,
			supportedInterfaces: [
				{
					url: "https://attacker.example/a2a",
					protocolBinding: "JSONRPC",
					protocolVersion: "1.0",
				},
			],
		};
		expect(
			(await verifyAgentCardSignatures(moved, resolver(keys))).status
		).toBe("invalid");
	});

	it("reports unpublished keys as invalid and unreachable keys as unverifiable", async () => {
		const signer = await fixtureSigningKey(0x41);
		const other = await fixtureSigningKey(0x42);
		const card = await signCard(sampleCard(), signer, JKU);
		const wrongKeys = await ed25519KeysFromJwks(other.jwks);
		expect(await verifyAgentCardSignatures(card, resolver(wrongKeys))).toEqual({
			status: "invalid",
			reason: "signing key is not published by the key source",
		});
		expect(
			await verifyAgentCardSignatures(card, () => ({
				kind: "unavailable",
				reason: "offline",
			}))
		).toEqual({ status: "unverifiable", reason: "offline" });
	});

	it("treats a card without signatures as unsigned and malformed ones as invalid", async () => {
		expect(
			await verifyAgentCardSignatures(sampleCard(), () => never())
		).toEqual({ status: "unsigned" });
		expect(
			await verifyAgentCardSignatures(
				{ ...sampleCard(), signatures: "not-an-array" },
				() => never()
			)
		).toEqual({
			status: "invalid",
			reason: "signatures must be an array of JWS objects",
		});
	});

	it("ignores the unprotected header when locating the key", async () => {
		const signer = await fixtureSigningKey(0x41);
		const keys = await ed25519KeysFromJwks(signer.jwks);
		const card = await signCard(sampleCard(), signer, JKU);
		const [entry] = z
			.array(z.object({ protected: z.string(), signature: z.string() }))
			.parse(card.signatures);
		const forged = {
			...card,
			signatures: [
				{
					protected: entry?.protected ?? "",
					signature: entry?.signature ?? "",
					header: { kid: "attacker", jku: "https://attacker.example/jwks" },
				},
			],
		};
		const seen: (string | undefined)[] = [];
		const status = await verifyAgentCardSignatures(forged, (header) => {
			seen.push(header.kid, header.jku);
			return resolver(keys)(header);
		});
		expect(status.status).toBe("verified");
		expect(seen).toEqual([signer.kid, JKU]);
	});

	it("does not depend on member order or whitespace", async () => {
		const signer = await fixtureSigningKey(0x41);
		const keys = await ed25519KeysFromJwks(signer.jwks);
		const card = await signCard(sampleCard(), signer, JKU);
		const reordered = JSON.parse(reversedText(card));
		expect(agentCardSigningPayload(reordered)).toBe(
			agentCardSigningPayload(card)
		);
		expect(
			(await verifyAgentCardSignatures(reordered, resolver(keys))).status
		).toBe("verified");
	});

	it("leaves unsupported algorithms and critical headers unverifiable", async () => {
		const encode = (header: Record<string, PrimitiveJsonValue>) =>
			base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
		const card = (protectedHeader: string) => ({
			...sampleCard(),
			signatures: [{ protected: protectedHeader, signature: "AA" }],
		});
		expect(
			await verifyAgentCardSignatures(
				card(encode({ alg: "RS256", kid: "k" })),
				() => never()
			)
		).toEqual({
			status: "unverifiable",
			reason: "signature uses an unsupported algorithm",
		});
		expect(
			await verifyAgentCardSignatures(
				card(encode({ alg: "EdDSA", kid: "k", crit: ["b64"] })),
				() => never()
			)
		).toEqual({
			status: "unverifiable",
			reason: "signature declares critical header parameters",
		});
		expect(await verifyAgentCardSignatures(card("%%%"), () => never())).toEqual(
			{
				status: "invalid",
				reason: "signature protected header is malformed",
			}
		);
	});
});

describe("validateEndpoint", () => {
	const code = (value: string, allowLoopbackHttp = false) => {
		try {
			validateEndpoint(value, { allowLoopbackHttp });
			return "ok";
		} catch (error) {
			return error instanceof A2AEndpointError ? error.code : "other";
		}
	};

	it("blocks credentials, fragments, and insecure remote URLs", () => {
		expect(code("https://user:secret@example.com/a2a")).toBe(
			"embedded_credentials"
		);
		expect(code("https://example.com/a2a#secret")).toBe("fragment");
		expect(code("http://example.com/a2a")).toBe("insecure_transport");
		expect(code("https://example.com/a2a")).toBe("ok");
	});

	it("permits only explicit loopback HTTP for development", () => {
		expect(code("http://127.0.0.1:7777/a2a", true)).toBe("ok");
		expect(code("http://localhost:7777/a2a", true)).toBe("ok");
		expect(code("http://[::1]:7777/a2a", true)).toBe("ok");
		expect(code("http://127.0.0.1:7777/a2a")).toBe("insecure_transport");
		expect(code("http://192.168.1.2/a2a", true)).toBe("insecure_transport");
		expect(code("https://localhost/a2a", true)).toBe("non_public_address");
	});

	it("blocks private, metadata, and reserved address literals", () => {
		for (const host of [
			"10.0.0.1",
			"169.254.169.254",
			"100.64.0.1",
			"127.0.0.1",
			"[::1]",
			"[fc00::1]",
			"[2001:db8::1]",
			"[::ffff:10.0.0.1]",
			"printer.local",
			"db.internal",
		]) {
			expect(code(`https://${host}/a2a`)).toBe("non_public_address");
		}
		expect(code("https://93.184.216.34/a2a")).toBe("ok");
		expect(code("https://[2606:4700::1111]/a2a")).toBe("ok");
	});
});
