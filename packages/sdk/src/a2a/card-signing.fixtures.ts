/**
 * Test-only Agent Card signer that produces the same JWS Core's
 * `sign_agent_card` emits: a JCS protected header `{alg, jku?, kid, typ}` and
 * an Ed25519 signature over `protected.base64url(JCS(card without signatures))`.
 */

import type { PrimitiveJsonValue } from "../runnable/primitive-contracts.ts";
import {
	agentCardSigningPayload,
	base64UrlEncode,
	canonicalizeJson,
	ed25519JwkThumbprint,
} from "./card-signing.ts";

const PKCS8_ED25519_PREFIX = Uint8Array.from([
	0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04,
	0x22, 0x04, 0x20,
]);

/** A deterministic Ed25519 signing key built from a 32-byte seed. */
export interface FixtureSigningKey {
	jwks: { keys: Record<string, string>[] };
	kid: string;
	privateKey: CryptoKey;
	publicKey: Uint8Array;
}

export async function fixtureSigningKey(
	seedByte: number
): Promise<FixtureSigningKey> {
	const seed = new Uint8Array(32).fill(seedByte);
	const privateKey = await crypto.subtle.importKey(
		"pkcs8",
		new Uint8Array([...PKCS8_ED25519_PREFIX, ...seed]),
		{ name: "Ed25519" },
		true,
		["sign"]
	);
	const jwk = await crypto.subtle.exportKey("jwk", privateKey);
	const x = jwk.x ?? "";
	const publicKey = Uint8Array.from(
		atob(x.replaceAll("-", "+").replaceAll("_", "/")),
		(char) => char.charCodeAt(0)
	);
	const kid = await ed25519JwkThumbprint(publicKey);
	return {
		privateKey,
		publicKey,
		kid,
		jwks: {
			keys: [{ kty: "OKP", crv: "Ed25519", x, kid, use: "sig", alg: "EdDSA" }],
		},
	};
}

/** Sign `card` and return it with the new entry appended to `signatures`. */
export async function signCard(
	card: Record<string, PrimitiveJsonValue>,
	key: FixtureSigningKey,
	jku?: string
): Promise<Record<string, PrimitiveJsonValue>> {
	const base = { alg: "EdDSA", typ: "JOSE", kid: key.kid };
	const header = jku ? { ...base, jku } : base;
	const encoder = new TextEncoder();
	const protectedHeader = base64UrlEncode(
		encoder.encode(canonicalizeJson(header))
	);
	const payload = base64UrlEncode(
		encoder.encode(agentCardSigningPayload(card))
	);
	const signature = await crypto.subtle.sign(
		{ name: "Ed25519" },
		key.privateKey,
		encoder.encode(`${protectedHeader}.${payload}`)
	);
	const existing = Array.isArray(card.signatures) ? card.signatures : [];
	return {
		...card,
		signatures: [
			...existing,
			{
				protected: protectedHeader,
				signature: base64UrlEncode(new Uint8Array(signature)),
			},
		],
	};
}

/** The sample card Core's card-signing tests use. */
export function sampleCard(url = "https://node.example.com/a2a") {
	return {
		name: "Ryu",
		description: "A Ryu agent endpoint",
		version: "1.2.3",
		supportedInterfaces: [
			{ url, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
		],
		capabilities: {
			streaming: true,
			pushNotifications: true,
			extendedAgentCard: false,
		},
		defaultInputModes: ["text/plain"],
		defaultOutputModes: ["text/plain"],
		skills: [],
		iconUrl: "https://node.example.com/a2a-card/icon.svg",
	};
}
