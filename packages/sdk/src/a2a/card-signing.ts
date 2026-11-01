/**
 * A2A v1 Agent Card signature verification, matching Ryu Core
 * (`crates/core/a2a/src/card_signing.rs`).
 *
 * A card is signed with a JWS (RFC 7515) whose detached payload is the
 * RFC 8785 (JCS) canonical JSON of the card without its `signatures` member.
 * Each `signatures` entry carries the base64url protected header and
 * signature. Ryu signs with Ed25519 (`alg: "EdDSA"`, RFC 8037) and names keys
 * by their RFC 7638 JWK thumbprint. Verification reads `alg`, `kid`, `jku`,
 * and `crit` only from the integrity-protected header; the unprotected
 * `header` member is ignored. Verification uses WebCrypto Ed25519.
 */

import { z } from "zod";
import {
	type PrimitiveJsonValue,
	primitiveJsonObjectSchema,
} from "../runnable/primitive-contracts.ts";
import { a2aCardSignatureSchema } from "./types.ts";

/** The only JWS algorithm Ryu emits or accepts for Agent Cards. */
export const CARD_SIGNATURE_ALG = "EdDSA";
/** Upper bound on signatures examined per card. */
export const MAX_CARD_SIGNATURES = 8;
const MAX_KID_BYTES = 256;
const ED25519_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

/** The outcome of checking a card's `signatures` (same shape Core stores). */
export type CardSignatureStatus =
	| { status: "unsigned" }
	| { jku?: string; kid: string; status: "verified" }
	| { reason: string; status: "unverifiable" }
	| { reason: string; status: "invalid" };

/** The integrity-protected JWS header fields a verifier acts on. */
export interface CardSignatureHeader {
	alg: string;
	crit?: string[];
	jku?: string;
	kid?: string;
	typ?: string;
}

/** How a verifier located (or failed to locate) the key a header names. */
export type KeyResolution =
	| { key: CryptoKey; kind: "found" }
	| { kind: "not_published" }
	| { kind: "unavailable"; reason: string };

/** An Ed25519 verification key published in a JWKS. */
export interface CardVerificationKey {
	key: CryptoKey;
	kid: string;
}

const protectedHeaderSchema = z.looseObject({
	alg: z.string(),
	kid: z.string().nullish(),
	jku: z.string().nullish(),
	typ: z.string().nullish(),
	crit: z.array(z.string()).nullish(),
});
const signaturesSchema = z.array(a2aCardSignatureSchema);
const jwkCandidateSchema = z.looseObject({
	kty: z.literal("OKP"),
	crv: z.literal("Ed25519"),
	x: z.string(),
});
const jwksSchema = z.looseObject({ keys: z.array(z.unknown()) });
const stringSchema = z.string();
const numberSchema = z.number();
const booleanSchema = z.boolean();

// ── Encoding ──────────────────────────────────────────────────────────────────

/** base64url without padding (RFC 4648 §5). */
export function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

/**
 * Strict base64url decode: no padding, no foreign characters, and no
 * non-zero trailing bits (the same canonical form Core's decoder requires).
 */
export function base64UrlDecode(text: string): Uint8Array | undefined {
	if (!BASE64URL_PATTERN.test(text) || text.length % 4 === 1) {
		return;
	}
	const padded =
		text.replaceAll("-", "+").replaceAll("_", "/") +
		"=".repeat((4 - (text.length % 4)) % 4);
	let binary: string;
	try {
		binary = atob(padded);
	} catch {
		return;
	}
	const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
	return base64UrlEncode(bytes) === text ? bytes : undefined;
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(text);
}

// ── RFC 8785 canonical JSON ───────────────────────────────────────────────────

function canonicalNumber(value: number): string {
	// ECMAScript Number-to-string is exactly the JCS number form; -0 and
	// non-finite values (which JSON cannot carry) serialize as 0 like Core.
	if (!Number.isFinite(value) || Object.is(value, -0)) {
		return "0";
	}
	return String(value);
}

/**
 * RFC 8785 JSON Canonicalization Scheme: members sorted by UTF-16 code units,
 * no insignificant whitespace, minimal string escapes, ECMAScript numbers.
 */
export function canonicalizeJson(value: PrimitiveJsonValue): string {
	if (value === null) {
		return "null";
	}
	const text = stringSchema.safeParse(value);
	if (text.success) {
		return JSON.stringify(text.data);
	}
	const number = numberSchema.safeParse(value);
	if (number.success) {
		return canonicalNumber(number.data);
	}
	const flag = booleanSchema.safeParse(value);
	if (flag.success) {
		return flag.data ? "true" : "false";
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalizeJson(item)).join(",")}]`;
	}
	const members = Object.entries(value).sort(([left], [right]) => {
		if (left < right) {
			return -1;
		}
		return left > right ? 1 : 0;
	});
	return `{${members
		.map(([key, item]) => `${JSON.stringify(key)}:${canonicalizeJson(item)}`)
		.join(",")}}`;
}

/** The JWS payload for a card: JCS of the card JSON without `signatures`. */
export function agentCardSigningPayload(card: PrimitiveJsonValue): string {
	const parsed = primitiveJsonObjectSchema.safeParse(card);
	if (!parsed.success || Array.isArray(card)) {
		throw new Error("[ryu-sdk] agent card must be a JSON object");
	}
	const { signatures: _signatures, ...members } = parsed.data;
	return canonicalizeJson(members);
}

// ── Keys ──────────────────────────────────────────────────────────────────────

/** RFC 7638 JWK thumbprint of an Ed25519 public key (base64url SHA-256). */
export async function ed25519JwkThumbprint(
	publicKey: Uint8Array
): Promise<string> {
	const required = canonicalizeJson({
		crv: "Ed25519",
		kty: "OKP",
		x: base64UrlEncode(publicKey),
	});
	const digest = await crypto.subtle.digest("SHA-256", utf8(required));
	return base64UrlEncode(new Uint8Array(digest));
}

/** Import a raw Ed25519 public key for verification; undefined when invalid. */
export async function importEd25519PublicKey(
	publicKey: Uint8Array
): Promise<CryptoKey | undefined> {
	if (publicKey.length !== ED25519_KEY_BYTES) {
		return;
	}
	try {
		return await crypto.subtle.importKey(
			"raw",
			new Uint8Array(publicKey),
			{ name: "Ed25519" },
			false,
			["verify"]
		);
	} catch {
		return;
	}
}

/**
 * Ed25519 verification keys from a JWKS document. Entries that are not
 * Ed25519 OKP signing keys are skipped; a key without a string `kid` is
 * indexed by its RFC 7638 thumbprint.
 */
export async function ed25519KeysFromJwks(
	jwks: PrimitiveJsonValue
): Promise<CardVerificationKey[]> {
	const parsed = jwksSchema.safeParse(jwks);
	if (!parsed.success) {
		return [];
	}
	const keys: CardVerificationKey[] = [];
	for (const entry of parsed.data.keys) {
		const jwk = jwkCandidateSchema.safeParse(entry);
		if (!jwk.success) {
			continue;
		}
		const purpose = stringSchema.safeParse(jwk.data.use);
		if (purpose.success && purpose.data !== "sig") {
			continue;
		}
		const bytes = base64UrlDecode(jwk.data.x);
		const key = bytes ? await importEd25519PublicKey(bytes) : undefined;
		if (!(bytes && key)) {
			continue;
		}
		const kid = stringSchema.safeParse(jwk.data.kid);
		keys.push({
			key,
			kid: kid.success ? kid.data : await ed25519JwkThumbprint(bytes),
		});
	}
	return keys;
}

// ── Verification ──────────────────────────────────────────────────────────────

/** Decode a signature entry's protected header. */
export function decodeProtectedHeader(
	protectedHeader: string
): CardSignatureHeader | undefined {
	const bytes = base64UrlDecode(protectedHeader);
	if (!bytes) {
		return;
	}
	let json: PrimitiveJsonValue;
	try {
		json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		return;
	}
	const header = protectedHeaderSchema.safeParse(json);
	if (!header.success) {
		return;
	}
	const decoded: CardSignatureHeader = { alg: header.data.alg };
	if (header.data.kid != null) {
		decoded.kid = header.data.kid;
	}
	if (header.data.jku != null) {
		decoded.jku = header.data.jku;
	}
	if (header.data.typ != null) {
		decoded.typ = header.data.typ;
	}
	if (header.data.crit != null) {
		decoded.crit = header.data.crit;
	}
	return decoded;
}

/** Signature entries on a raw card, or an error message when malformed. */
export function cardSignatures(
	card: PrimitiveJsonValue
):
	| { entries: z.output<typeof signaturesSchema>; ok: true }
	| { ok: false; reason: string } {
	const object = primitiveJsonObjectSchema.safeParse(card);
	const raw = object.success ? object.data.signatures : undefined;
	if (raw === undefined || raw === null) {
		return { ok: true, entries: [] };
	}
	const parsed = signaturesSchema.safeParse(raw);
	return parsed.success
		? { ok: true, entries: parsed.data }
		: { ok: false, reason: "signatures must be an array of JWS objects" };
}

type SignatureOutcome =
	| { jku?: string; kid: string; ok: true }
	| { ok: false; reason: string; verdict: "invalid" | "unverifiable" };

async function verifyOne(
	entry: z.output<typeof a2aCardSignatureSchema>,
	payload: string,
	resolveKey: (
		header: CardSignatureHeader
	) => KeyResolution | Promise<KeyResolution>
): Promise<SignatureOutcome> {
	const header = decodeProtectedHeader(entry.protected);
	if (!header) {
		return {
			ok: false,
			verdict: "invalid",
			reason: "signature protected header is malformed",
		};
	}
	if (header.alg !== CARD_SIGNATURE_ALG) {
		return {
			ok: false,
			verdict: "unverifiable",
			reason: "signature uses an unsupported algorithm",
		};
	}
	if (header.crit && header.crit.length > 0) {
		return {
			ok: false,
			verdict: "unverifiable",
			reason: "signature declares critical header parameters",
		};
	}
	const kid = header.kid;
	if (!kid || utf8(kid).length > MAX_KID_BYTES) {
		return {
			ok: false,
			verdict: "invalid",
			reason: "signature header has no valid kid",
		};
	}
	const resolution = await resolveKey(header);
	if (resolution.kind === "not_published") {
		return {
			ok: false,
			verdict: "invalid",
			reason: "signing key is not published by the key source",
		};
	}
	if (resolution.kind === "unavailable") {
		return { ok: false, verdict: "unverifiable", reason: resolution.reason };
	}
	const signature = base64UrlDecode(entry.signature);
	if (signature?.length !== ED25519_SIGNATURE_BYTES) {
		return {
			ok: false,
			verdict: "invalid",
			reason: "signature value is malformed",
		};
	}
	const signingInput = utf8(
		`${entry.protected}.${base64UrlEncode(utf8(payload))}`
	);
	const valid = await crypto.subtle
		.verify(
			{ name: "Ed25519" },
			resolution.key,
			new Uint8Array(signature),
			signingInput
		)
		.catch(() => false);
	if (!valid) {
		return {
			ok: false,
			verdict: "invalid",
			reason: "signature does not match the card",
		};
	}
	return header.jku === undefined
		? { ok: true, kid }
		: { ok: true, kid, jku: header.jku };
}

/**
 * Verify the `signatures` on a raw Agent Card JSON value (the card exactly as
 * received, so members this SDK does not model still count). The first
 * signature that verifies wins; otherwise any invalid signature makes the card
 * invalid, and signatures whose key could not be consulted leave it
 * unverifiable.
 */
export async function verifyAgentCardSignatures(
	card: PrimitiveJsonValue,
	resolveKey: (
		header: CardSignatureHeader
	) => KeyResolution | Promise<KeyResolution>
): Promise<CardSignatureStatus> {
	const signatures = cardSignatures(card);
	if (!signatures.ok) {
		return { status: "invalid", reason: signatures.reason };
	}
	if (signatures.entries.length === 0) {
		return { status: "unsigned" };
	}
	let payload: string;
	try {
		payload = agentCardSigningPayload(card);
	} catch {
		return { status: "invalid", reason: "agent card must be a JSON object" };
	}
	let invalid: string | undefined;
	let unverifiable: string | undefined;
	for (const entry of signatures.entries.slice(0, MAX_CARD_SIGNATURES)) {
		const outcome = await verifyOne(entry, payload, resolveKey);
		if (outcome.ok) {
			return outcome.jku === undefined
				? { status: "verified", kid: outcome.kid }
				: { status: "verified", kid: outcome.kid, jku: outcome.jku };
		}
		if (outcome.verdict === "invalid") {
			invalid ??= outcome.reason;
		} else {
			unverifiable ??= outcome.reason;
		}
	}
	if (invalid !== undefined) {
		return { status: "invalid", reason: invalid };
	}
	return {
		status: "unverifiable",
		reason: unverifiable ?? "no signature could be checked",
	};
}
