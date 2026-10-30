import { describe, expect, test } from "bun:test";
import {
	legacyMailWebhookSignature,
	mailWebhookSignatureHeaders,
	standardMailWebhookSignature,
} from "../../../api/src/lib/mail-webhooks.ts";
import {
	RyuConfigurationError,
	RyuWebhookVerificationError,
} from "../errors.ts";
import { verifyStandardWebhook } from "./standard.ts";

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const OTHER_SECRET = "whsec_dGhpcyBpcyBhIGRpZmZlcmVudCBrZXkhIQ==";
const ID = "evt_2fQk7";
const NOW = new Date("2026-10-21T12:00:00Z");
const TIMESTAMP = String(Math.floor(NOW.getTime() / 1000));
const BODY = JSON.stringify({
	type: "event",
	event_type: "message.received",
	event_id: ID,
	data: { message: { id: "msg_1", subject: "Hi ✓" } },
});

function standardSignature(
	secret = SECRET,
	body = BODY,
	timestamp = TIMESTAMP
): string {
	const signature = standardMailWebhookSignature(secret, ID, timestamp, body);
	if (!signature) {
		throw new Error("fixture secret must be strict base64");
	}
	return signature;
}

async function failure(
	promise: Promise<unknown>
): Promise<RyuWebhookVerificationError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof RyuWebhookVerificationError) {
			return error;
		}
		throw error;
	}
	throw new Error("expected verification to fail");
}

describe("verifyStandardWebhook", () => {
	test("accepts the hosted Mail signer's headers and returns the parsed body", async () => {
		const headers = mailWebhookSignatureHeaders(
			"standard",
			SECRET,
			ID,
			TIMESTAMP,
			BODY
		);
		const body = await verifyStandardWebhook({
			headers,
			payload: BODY,
			secret: SECRET,
			now: NOW,
		});
		expect(body).toEqual(JSON.parse(BODY));
	});

	test("an unset (NaN), infinite, negative or huge toleranceSeconds throws instead of accepting any timestamp", async () => {
		const ancient = "1000000000";
		for (const toleranceSeconds of [
			Number(undefined),
			Number.POSITIVE_INFINITY,
			-5,
			10 ** 9,
		]) {
			await expect(
				verifyStandardWebhook({
					headers: {
						"webhook-id": ID,
						"webhook-timestamp": ancient,
						"webhook-signature": standardSignature(SECRET, BODY, ancient),
					},
					payload: BODY,
					secret: SECRET,
					now: NOW,
					toleranceSeconds,
				})
			).rejects.toBeInstanceOf(RyuConfigurationError);
		}
	});

	test("accepts a Headers object and a Uint8Array payload", async () => {
		const body = await verifyStandardWebhook({
			headers: new Headers({
				"Webhook-Id": ID,
				"Webhook-Timestamp": TIMESTAMP,
				"Webhook-Signature": standardSignature(),
			}),
			payload: new TextEncoder().encode(BODY),
			secret: SECRET,
			now: NOW,
		});
		expect(body).toEqual(JSON.parse(BODY));
	});

	test("accepts a list where the valid signature is the second entry", async () => {
		const stale = standardSignature(OTHER_SECRET);
		const body = await verifyStandardWebhook({
			headers: {
				"webhook-id": ID,
				"webhook-timestamp": TIMESTAMP,
				"webhook-signature": `${stale} v1a,ignored ${standardSignature()}`,
			},
			payload: BODY,
			secret: SECRET,
			now: NOW,
		});
		expect(body).toEqual(JSON.parse(BODY));
	});

	test("joins repeated signature headers from a Node header record", async () => {
		const body = await verifyStandardWebhook({
			headers: {
				"webhook-id": ID,
				"webhook-timestamp": TIMESTAMP,
				"webhook-signature": [
					standardSignature(OTHER_SECRET),
					standardSignature(),
				],
			},
			payload: BODY,
			secret: SECRET,
			now: NOW,
		});
		expect(body).toEqual(JSON.parse(BODY));
	});

	test("strips the comma Headers.get() puts between repeated signature headers", async () => {
		const headers = new Headers({
			"webhook-id": ID,
			"webhook-timestamp": TIMESTAMP,
		});
		headers.append("webhook-signature", standardSignature());
		headers.append("webhook-signature", standardSignature(OTHER_SECRET));
		expect(headers.get("webhook-signature")).toContain(", ");
		const body = await verifyStandardWebhook({
			headers,
			payload: BODY,
			secret: SECRET,
			now: NOW,
		});
		expect(body).toEqual(JSON.parse(BODY));
	});

	test("rejects a tampered body", async () => {
		const error = await failure(
			verifyStandardWebhook({
				headers: {
					"webhook-id": ID,
					"webhook-timestamp": TIMESTAMP,
					"webhook-signature": standardSignature(),
				},
				payload: BODY.replace("Hi", "Ho"),
				secret: SECRET,
				now: NOW,
			})
		);
		expect(error.code).toBe("webhook_invalid_signature");
		expect(error.service).toBe("mail");
		expect(error.retryable).toBe(false);
	});

	test("rejects the wrong secret", async () => {
		const error = await failure(
			verifyStandardWebhook({
				headers: {
					"webhook-id": ID,
					"webhook-timestamp": TIMESTAMP,
					"webhook-signature": standardSignature(),
				},
				payload: BODY,
				secret: OTHER_SECRET,
				now: NOW,
			})
		);
		expect(error.code).toBe("webhook_invalid_signature");
	});

	test("an unset or empty secret is webhook_invalid_secret, never a TypeError", async () => {
		// An unset env var or Workers binding arrives as undefined.
		for (const secret of [undefined, null, "", 42]) {
			const error = await failure(
				verifyStandardWebhook({
					headers: {
						"webhook-id": ID,
						"webhook-timestamp": TIMESTAMP,
						"webhook-signature": standardSignature(),
					},
					payload: BODY,
					secret: secret as unknown as string,
					now: NOW,
				})
			);
			expect(error.code).toBe("webhook_invalid_secret");
			expect(error.message).toBe(
				"Ryu Mail webhook: the signing secret is empty."
			);
		}
		// Checked before the headers: the missing binding is the fix to make.
		const headerless = await failure(
			verifyStandardWebhook({
				headers: {},
				payload: BODY,
				secret: undefined as unknown as string,
				now: NOW,
			})
		);
		expect(headerless.code).toBe("webhook_invalid_secret");
	});

	test("rejects a secret that is not whsec_<base64>", async () => {
		const error = await failure(
			verifyStandardWebhook({
				headers: {
					"webhook-id": ID,
					"webhook-timestamp": TIMESTAMP,
					"webhook-signature": standardSignature(),
				},
				payload: BODY,
				secret: "whsec_not base64!",
				now: NOW,
			})
		);
		expect(error.code).toBe("webhook_invalid_secret");
	});

	test("rejects timestamps outside the tolerance window in both directions", async () => {
		for (const offset of [-301, 301]) {
			const timestamp = String(Number(TIMESTAMP) + offset);
			const error = await failure(
				verifyStandardWebhook({
					headers: {
						"webhook-id": ID,
						"webhook-timestamp": timestamp,
						"webhook-signature": standardSignature(SECRET, BODY, timestamp),
					},
					payload: BODY,
					secret: SECRET,
					now: NOW,
				})
			);
			expect(error.code).toBe("webhook_timestamp_out_of_range");
		}
	});

	test("an Invalid Date now fails closed instead of skipping the replay check", async () => {
		const error = await failure(
			verifyStandardWebhook({
				headers: {
					"webhook-id": ID,
					"webhook-timestamp": TIMESTAMP,
					"webhook-signature": standardSignature(),
				},
				payload: BODY,
				secret: SECRET,
				now: new Date(Number.NaN),
			})
		);
		expect(error.code).toBe("webhook_timestamp_out_of_range");
		expect(error.message).toContain("NaNs from now");
	});

	test("accepts a timestamp inside a custom tolerance", async () => {
		const timestamp = String(Number(TIMESTAMP) - 500);
		const body = await verifyStandardWebhook({
			headers: {
				"webhook-id": ID,
				"webhook-timestamp": timestamp,
				"webhook-signature": standardSignature(SECRET, BODY, timestamp),
			},
			payload: BODY,
			secret: SECRET,
			now: NOW,
			toleranceSeconds: 600,
		});
		expect(body).toEqual(JSON.parse(BODY));
	});

	test("rejects a timestamp that is not unix seconds", async () => {
		const error = await failure(
			verifyStandardWebhook({
				headers: {
					"webhook-id": ID,
					"webhook-timestamp": "2026-10-21T12:00:00Z",
					"webhook-signature": standardSignature(),
				},
				payload: BODY,
				secret: SECRET,
				now: NOW,
			})
		);
		expect(error.code).toBe("webhook_timestamp_out_of_range");
	});

	test("falls back to svix-* headers when webhook-* are absent", async () => {
		const headers = mailWebhookSignatureHeaders(
			"standard",
			SECRET,
			ID,
			TIMESTAMP,
			BODY
		);
		const svixOnly = Object.fromEntries(
			Object.entries(headers).filter(([name]) => name.startsWith("svix-"))
		);
		expect(Object.keys(svixOnly).sort()).toEqual([
			"svix-id",
			"svix-signature",
			"svix-timestamp",
		]);
		const body = await verifyStandardWebhook({
			headers: svixOnly,
			payload: BODY,
			secret: SECRET,
			now: NOW,
		});
		expect(body).toEqual(JSON.parse(BODY));
	});

	test("reports missing headers", async () => {
		const error = await failure(
			verifyStandardWebhook({
				headers: { "webhook-id": ID, "webhook-timestamp": TIMESTAMP },
				payload: BODY,
				secret: SECRET,
				now: NOW,
			})
		);
		expect(error.code).toBe("webhook_missing_headers");
		expect(error.docs).toContain("/standalone/sdk/webhooks");
	});

	test("legacy scheme verifies the raw-key svix-signature", async () => {
		const headers = mailWebhookSignatureHeaders(
			"legacy",
			SECRET,
			ID,
			TIMESTAMP,
			BODY
		);
		expect(headers["svix-signature"]).toBe(
			legacyMailWebhookSignature(SECRET, ID, TIMESTAMP, BODY)
		);
		const body = await verifyStandardWebhook({
			headers,
			payload: BODY,
			secret: SECRET,
			now: NOW,
			scheme: "legacy",
		});
		expect(body).toEqual(JSON.parse(BODY));
		// The same delivery's webhook-signature still verifies under the standard key.
		const standard = await verifyStandardWebhook({
			headers,
			payload: BODY,
			secret: SECRET,
			now: NOW,
		});
		expect(standard).toEqual(JSON.parse(BODY));
	});

	test("legacy scheme accepts a secret that is not base64", async () => {
		const secret = "whsec_raw secret with spaces";
		const body = await verifyStandardWebhook({
			headers: {
				"svix-id": ID,
				"svix-timestamp": TIMESTAMP,
				"svix-signature": legacyMailWebhookSignature(
					secret,
					ID,
					TIMESTAMP,
					BODY
				),
			},
			payload: BODY,
			secret,
			now: NOW,
			scheme: "legacy",
		});
		expect(body).toEqual(JSON.parse(BODY));
	});

	test("legacy scheme verifies webhook-* headers alone with the standard key", async () => {
		const headers = mailWebhookSignatureHeaders(
			"legacy",
			SECRET,
			ID,
			TIMESTAMP,
			BODY
		);
		const webhookOnly = Object.fromEntries(
			Object.entries(headers).filter(([name]) => name.startsWith("webhook-"))
		);
		expect(Object.keys(webhookOnly).sort()).toEqual([
			"webhook-id",
			"webhook-signature",
			"webhook-timestamp",
		]);
		const body = await verifyStandardWebhook({
			headers: webhookOnly,
			payload: BODY,
			secret: SECRET,
			now: NOW,
			scheme: "legacy",
		});
		expect(body).toEqual(JSON.parse(BODY));
	});

	test("legacy scheme rejects a raw-key signature sent as webhook-signature", async () => {
		const error = await failure(
			verifyStandardWebhook({
				headers: {
					"webhook-id": ID,
					"webhook-timestamp": TIMESTAMP,
					"webhook-signature": legacyMailWebhookSignature(
						SECRET,
						ID,
						TIMESTAMP,
						BODY
					),
				},
				payload: BODY,
				secret: SECRET,
				now: NOW,
				scheme: "legacy",
			})
		);
		expect(error.code).toBe("webhook_invalid_signature");
	});

	test("a legacy signature does not pass the standard scheme", async () => {
		const error = await failure(
			verifyStandardWebhook({
				headers: {
					"svix-id": ID,
					"svix-timestamp": TIMESTAMP,
					"svix-signature": legacyMailWebhookSignature(
						SECRET,
						ID,
						TIMESTAMP,
						BODY
					),
				},
				payload: BODY,
				secret: SECRET,
				now: NOW,
			})
		);
		expect(error.code).toBe("webhook_invalid_signature");
	});

	test("a verified body that is not JSON is webhook_payload_invalid", async () => {
		const body = "not json";
		const error = await failure(
			verifyStandardWebhook({
				headers: {
					"webhook-id": ID,
					"webhook-timestamp": TIMESTAMP,
					"webhook-signature": standardSignature(SECRET, body),
				},
				payload: body,
				secret: SECRET,
				now: NOW,
			})
		);
		expect(error.code).toBe("webhook_payload_invalid");
	});

	test("names the service passed in on errors", async () => {
		const error = await failure(
			verifyStandardWebhook({
				headers: {},
				payload: BODY,
				secret: SECRET,
				service: "notify",
			})
		);
		expect(error.service).toBe("notify");
	});

	test("errors never carry the secret", async () => {
		const error = await failure(
			verifyStandardWebhook({
				headers: {
					"webhook-id": ID,
					"webhook-timestamp": TIMESTAMP,
					"webhook-signature": standardSignature(),
				},
				payload: BODY,
				secret: OTHER_SECRET,
				now: NOW,
			})
		);
		expect(JSON.stringify(error.toJSON())).not.toContain(OTHER_SECRET.slice(6));
		expect(error.message).not.toContain(OTHER_SECRET.slice(6));
	});

	test("fails with a configuration error when WebCrypto is missing", async () => {
		const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
		Object.defineProperty(globalThis, "crypto", {
			value: undefined,
			configurable: true,
			writable: true,
		});
		try {
			let caught: unknown;
			try {
				await verifyStandardWebhook({
					headers: {},
					payload: BODY,
					secret: SECRET,
				});
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(RyuConfigurationError);
			expect((caught as RyuConfigurationError).code).toBe(
				"webcrypto_unavailable"
			);
		} finally {
			if (original) {
				Object.defineProperty(globalThis, "crypto", original);
			}
		}
	});
});
