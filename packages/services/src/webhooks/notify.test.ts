// Golden vectors are computed with node:crypto exactly as apps/notify/src/service.ts
// signs: destination deliveries at ~1278-1283 (hex HMAC of the raw body) and
// response callbacks at ~1748-1765 (hex HMAC of `${timestamp}.${body}`). The
// source-lockstep test below fails if either signing expression changes.
// node:crypto is used in this test only; src/webhooks stays WebCrypto-only.

import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// The real signer, so the vectors below cannot drift from what Notify sends.
import { standardWebhookHeaders } from "../../../../apps/notify/src/http-conventions.ts";
import {
	RyuConfigurationError,
	RyuWebhookVerificationError,
} from "../errors.ts";
import { verifyNotifyWebhook } from "./notify.ts";

const SECRET = "notify-destination-secret";
const NOW = new Date("2026-10-21T12:00:00Z");
const TIMESTAMP = String(Math.floor(NOW.getTime() / 1000));
const NOTIFY_SERVICE = join(
	import.meta.dir,
	"../../../../apps/notify/src/service.ts"
);

function destinationSignature(body: string, secret = SECRET): string {
	return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function callbackSignature(
	timestamp: string,
	body: string,
	secret = SECRET
): string {
	return `sha256=${createHmac("sha256", secret)
		.update(`${timestamp}.${body}`)
		.digest("hex")}`;
}

/** The source text of a template-literal placeholder, `${name}`. */
function interpolation(name: string): string {
	return `${"$"}{${name}}`;
}

async function failureCode(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof RyuWebhookVerificationError) {
			if (error.service !== "notify") {
				throw new Error(`expected a notify error, got ${error.service}`);
			}
			return error.code;
		}
		throw error;
	}
	throw new Error("expected verification to fail");
}

describe("notify signing source lockstep", () => {
	test("apps/notify still signs destinations over the body and callbacks over timestamp.body", () => {
		const source = readFileSync(NOTIFY_SERVICE, "utf8").replace(/\s+/g, " ");
		expect(source).toContain(
			'createHmac("sha256", destination.secret) .update(body) .digest("hex")'
		);
		expect(source).toContain(
			`createHmac("sha256", secret) .update(\`${interpolation("timestamp")}.${interpolation("body")}\`) .digest("hex")`
		);
		expect(source).toContain(
			`headers.set("x-ryu-notify-signature", \`sha256=${interpolation("signature")}\`)`
		);
		expect(source).toContain('"x-ryu-notify-timestamp": timestamp');
		expect(source).toContain(
			'headers.set("x-ryu-notify-delivery", deliveryId)'
		);
		expect(source).toContain(
			'JSON.stringify({ deliveryId, event: eventForDestination(event), type: "notification", })'
		);
	});
});

describe("verifyNotifyWebhook destination (body-only signature, opted in)", () => {
	// The JSON destination envelope apps/notify sendDestination posts.
	const body = JSON.stringify({
		deliveryId: "dlv_1",
		event: { id: "evt_1", title: "Deploy finished", level: "success" },
		type: "notification",
	});
	const headers = {
		"x-ryu-notify-event": "evt_1",
		"x-ryu-notify-delivery": "dlv_1",
		"x-ryu-notify-signature": destinationSignature(body),
	};

	test("verifies the body signature and returns ids and the parsed body", async () => {
		const delivery = await verifyNotifyWebhook({
			kind: "destination",
			allowBodyOnlySignature: true,
			headers,
			payload: body,
			secret: SECRET,
		});
		expect(delivery).toEqual({
			kind: "destination",
			eventId: "evt_1",
			deliveryId: "dlv_1",
			body: JSON.parse(body),
			replayProtected: false,
		});
	});

	test("refuses the replayable body-only signature by default", async () => {
		const refused = await verifyNotifyWebhook({
			kind: "destination",
			headers,
			payload: body,
			secret: SECRET,
		}).catch((error: unknown) => error);
		expect(refused).toMatchObject({ code: "webhook_missing_headers" });
		expect(String(refused)).toContain("allowBodyOnlySignature");
		for (const options of [
			{ requireTimestamp: true },
			{ allowBodyOnlySignature: true, requireTimestamp: true },
			{ allowBodyOnlySignature: false },
		]) {
			expect(
				await failureCode(
					verifyNotifyWebhook({
						kind: "destination",
						headers,
						payload: body,
						secret: SECRET,
						...options,
					})
				)
			).toBe("webhook_missing_headers");
		}
		// requireTimestamp: false is the same explicit opt-in as allowBodyOnlySignature.
		const delivery = await verifyNotifyWebhook({
			kind: "destination",
			headers,
			payload: body,
			requireTimestamp: false,
			secret: SECRET,
		});
		expect(delivery.replayProtected).toBe(false);
	});

	test("accepts a Headers object, a Uint8Array payload and uppercase hex", async () => {
		const delivery = await verifyNotifyWebhook({
			kind: "destination",
			allowBodyOnlySignature: true,
			headers: new Headers({
				...headers,
				"x-ryu-notify-signature": destinationSignature(body).toUpperCase(),
			}),
			payload: new TextEncoder().encode(body),
			secret: SECRET,
		});
		expect(delivery.deliveryId).toBe("dlv_1");
	});

	test("returns a non-JSON body (ntfy format) as the raw string", async () => {
		const text = "Deploy finished";
		const delivery = await verifyNotifyWebhook({
			kind: "destination",
			allowBodyOnlySignature: true,
			headers: {
				...headers,
				"x-ryu-notify-signature": destinationSignature(text),
			},
			payload: text,
			secret: SECRET,
		});
		expect(delivery.body).toBe(text);
		// A plain-text body carries no signed id, so the unsigned headers are not echoed.
		expect(delivery.deliveryId).toBeNull();
		expect(delivery.eventId).toBeNull();
	});

	test("ids come from the signed body: a forged id header is rejected", async () => {
		for (const forged of [
			{ "x-ryu-notify-delivery": "dlv_FORGED" },
			{ "x-ryu-notify-event": "evt_FORGED" },
		]) {
			expect(
				await failureCode(
					verifyNotifyWebhook({
						kind: "destination",
						allowBodyOnlySignature: true,
						headers: { ...headers, ...forged },
						payload: body,
						secret: SECRET,
					})
				)
			).toBe("webhook_invalid_signature");
		}
		const withoutIdHeaders = await verifyNotifyWebhook({
			kind: "destination",
			allowBodyOnlySignature: true,
			headers: { "x-ryu-notify-signature": headers["x-ryu-notify-signature"] },
			payload: body,
			secret: SECRET,
		});
		expect(withoutIdHeaders.deliveryId).toBe("dlv_1");
		expect(withoutIdHeaders.eventId).toBe("evt_1");
	});

	test("ignores the timestamp: a destination signature has no replay window", async () => {
		const delivery = await verifyNotifyWebhook({
			kind: "destination",
			allowBodyOnlySignature: true,
			headers,
			payload: body,
			secret: SECRET,
			now: new Date("2099-01-01T00:00:00Z"),
		});
		expect(delivery.eventId).toBe("evt_1");
	});

	test("rejects a tampered body, the wrong secret and a missing signature", async () => {
		expect(
			await failureCode(
				verifyNotifyWebhook({
					kind: "destination",
					allowBodyOnlySignature: true,
					headers,
					payload: body.replace("finished", "failed"),
					secret: SECRET,
				})
			)
		).toBe("webhook_invalid_signature");
		expect(
			await failureCode(
				verifyNotifyWebhook({
					kind: "destination",
					allowBodyOnlySignature: true,
					headers,
					payload: body,
					secret: "other",
				})
			)
		).toBe("webhook_invalid_signature");
		expect(
			await failureCode(
				verifyNotifyWebhook({
					kind: "destination",
					allowBodyOnlySignature: true,
					headers: { "x-ryu-notify-event": "evt_1" },
					payload: body,
					secret: SECRET,
				})
			)
		).toBe("webhook_missing_headers");
		expect(
			await failureCode(
				verifyNotifyWebhook({
					kind: "destination",
					allowBodyOnlySignature: true,
					headers,
					payload: body,
					secret: "",
				})
			)
		).toBe("webhook_invalid_secret");
	});
});

describe("verifyNotifyWebhook destination with Standard Webhooks headers", () => {
	const body = JSON.stringify({
		deliveryId: "dlv_2",
		event: { id: "evt_2", title: "Deploy finished" },
		type: "notification",
	});
	const nowSeconds = Number(TIMESTAMP);

	function deliveryHeaders(
		overrides: Record<string, string> = {},
		id = "dlv_2",
		timestampSeconds = nowSeconds,
		signedBody = body
	): Record<string, string> {
		return {
			"x-ryu-notify-event": "evt_2",
			"x-ryu-notify-delivery": id,
			"x-ryu-notify-signature": destinationSignature(signedBody),
			...standardWebhookHeaders(id, timestampSeconds, signedBody, SECRET),
			...overrides,
		};
	}

	test("apps/notify signs destinations with standardWebhookHeaders keyed by the raw secret", () => {
		const source = readFileSync(NOTIFY_SERVICE, "utf8").replace(/\s+/g, " ");
		expect(source).toContain(
			"standardWebhookHeaders( deliveryId, timestampSeconds, body, destination.secret )"
		);
		const signed = standardWebhookHeaders("dlv_x", nowSeconds, "{}", SECRET);
		expect(signed["webhook-signature"]).toBe(
			`v1,${createHmac("sha256", SECRET).update(`dlv_x.${TIMESTAMP}.{}`).digest("base64")}`
		);
	});

	test("verifies the signed id, timestamp and body and reports replay protection", async () => {
		const delivery = await verifyNotifyWebhook({
			kind: "destination",
			headers: deliveryHeaders(),
			payload: body,
			secret: SECRET,
			now: NOW,
		});
		expect(delivery).toEqual({
			kind: "destination",
			eventId: "evt_2",
			deliveryId: "dlv_2",
			body: JSON.parse(body),
			replayProtected: true,
		});
	});

	test("is preferred: a valid webhook-* set wins even when the legacy signature is wrong", async () => {
		const delivery = await verifyNotifyWebhook({
			kind: "destination",
			headers: deliveryHeaders({ "x-ryu-notify-signature": "sha256=00" }),
			payload: new TextEncoder().encode(body),
			secret: SECRET,
			now: NOW,
		});
		expect(delivery.replayProtected).toBe(true);
	});

	test("rejects a stale or future timestamp, honouring toleranceSeconds", async () => {
		for (const offset of [-301, 301]) {
			expect(
				await failureCode(
					verifyNotifyWebhook({
						kind: "destination",
						headers: deliveryHeaders({}, "dlv_2", nowSeconds + offset),
						payload: body,
						secret: SECRET,
						now: NOW,
					})
				)
			).toBe("webhook_timestamp_out_of_range");
		}
		const relaxed = await verifyNotifyWebhook({
			kind: "destination",
			headers: deliveryHeaders({}, "dlv_2", nowSeconds - 301),
			payload: body,
			secret: SECRET,
			now: NOW,
			toleranceSeconds: 600,
		});
		expect(relaxed.deliveryId).toBe("dlv_2");
	});

	test("never falls back to the body-only signature when webhook-* fails", async () => {
		// A replayed delivery with a re-stamped timestamp: the legacy
		// signature still matches the body, but the signed timestamp does not.
		const replayed = deliveryHeaders({
			"webhook-timestamp": String(nowSeconds),
			...{
				"webhook-signature": standardWebhookHeaders(
					"dlv_2",
					nowSeconds - 3600,
					body,
					SECRET
				)["webhook-signature"],
			},
		});
		expect(
			await failureCode(
				verifyNotifyWebhook({
					kind: "destination",
					headers: replayed,
					payload: body,
					secret: SECRET,
					now: NOW,
				})
			)
		).toBe("webhook_invalid_signature");
	});

	test("takes the delivery id from webhook-id and rejects ids that disagree", async () => {
		// webhook-id is signed; the body's deliveryId must agree with it.
		expect(
			await failureCode(
				verifyNotifyWebhook({
					kind: "destination",
					headers: deliveryHeaders({}, "dlv_OTHER"),
					payload: body,
					secret: SECRET,
					now: NOW,
				})
			)
		).toBe("webhook_invalid_signature");
		// A forged webhook-id breaks the signature.
		expect(
			await failureCode(
				verifyNotifyWebhook({
					kind: "destination",
					headers: deliveryHeaders({ "webhook-id": "dlv_FORGED" }),
					payload: body,
					secret: SECRET,
					now: NOW,
				})
			)
		).toBe("webhook_invalid_signature");
		// The unsigned x-ryu-notify-delivery header must match too.
		expect(
			await failureCode(
				verifyNotifyWebhook({
					kind: "destination",
					headers: deliveryHeaders({ "x-ryu-notify-delivery": "dlv_FORGED" }),
					payload: body,
					secret: SECRET,
					now: NOW,
				})
			)
		).toBe("webhook_invalid_signature");
	});

	test("an ntfy (plain-text) delivery gets its id from webhook-id", async () => {
		const text = "Deploy finished";
		const delivery = await verifyNotifyWebhook({
			kind: "destination",
			headers: deliveryHeaders({}, "dlv_3", nowSeconds, text),
			payload: text,
			secret: SECRET,
			now: NOW,
		});
		expect(delivery).toMatchObject({
			body: text,
			deliveryId: "dlv_3",
			eventId: null,
			replayProtected: true,
		});
	});

	test("a test delivery's test_ id verifies", async () => {
		const testBody = JSON.stringify({
			deliveryId: "test_abc",
			event: { id: "evt_test_abc", title: "Test" },
			type: "notification",
		});
		const delivery = await verifyNotifyWebhook({
			kind: "destination",
			headers: {
				...standardWebhookHeaders("test_abc", nowSeconds, testBody, SECRET),
			},
			payload: testBody,
			secret: SECRET,
			now: NOW,
		});
		expect(delivery.deliveryId).toBe("test_abc");
	});

	test("accepts any matching entry in a rotated signature list", async () => {
		const valid = deliveryHeaders()["webhook-signature"];
		const delivery = await verifyNotifyWebhook({
			kind: "destination",
			headers: deliveryHeaders({
				"webhook-signature": `v1,AAAA ${valid} v2,zzz`,
			}),
			payload: body,
			secret: SECRET,
			now: NOW,
		});
		expect(delivery.deliveryId).toBe("dlv_2");
	});

	test("an incomplete webhook-* set is refused, never downgraded to the legacy signature", async () => {
		for (const header of [
			"webhook-id",
			"webhook-timestamp",
			"webhook-signature",
		]) {
			const { [header]: _dropped, ...partial } = deliveryHeaders();
			expect(
				await failureCode(
					verifyNotifyWebhook({
						kind: "destination",
						headers: partial,
						payload: body,
						secret: SECRET,
						now: NOW,
					})
				)
			).toBe("webhook_missing_headers");
		}
		// Only one webhook-* header beside a valid legacy signature.
		expect(
			await failureCode(
				verifyNotifyWebhook({
					kind: "destination",
					headers: {
						"x-ryu-notify-signature": destinationSignature(body),
						"webhook-id": "dlv_2",
					},
					payload: body,
					secret: SECRET,
					now: NOW,
				})
			)
		).toBe("webhook_missing_headers");
	});

	test("a replay with every webhook-* header stripped is refused unless allowBodyOnlySignature opts in", async () => {
		const {
			"webhook-id": _id,
			"webhook-timestamp": _timestamp,
			"webhook-signature": _signature,
			...stripped
		} = deliveryHeaders();
		// The default refuses the stripped replay.
		expect(
			await failureCode(
				verifyNotifyWebhook({
					kind: "destination",
					headers: stripped,
					payload: body,
					secret: SECRET,
					now: NOW,
				})
			)
		).toBe("webhook_missing_headers");
		const legacy = await verifyNotifyWebhook({
			kind: "destination",
			allowBodyOnlySignature: true,
			headers: stripped,
			payload: body,
			secret: SECRET,
			now: NOW,
		});
		expect(legacy.replayProtected).toBe(false);
		expect(
			await failureCode(
				verifyNotifyWebhook({
					kind: "destination",
					headers: stripped,
					payload: body,
					secret: SECRET,
					now: NOW,
					requireTimestamp: true,
				})
			)
		).toBe("webhook_missing_headers");
	});

	test("requireTimestamp refuses the body-only fallback", async () => {
		expect(
			await failureCode(
				verifyNotifyWebhook({
					kind: "destination",
					headers: {
						"x-ryu-notify-signature": destinationSignature(body),
					},
					payload: body,
					secret: SECRET,
					requireTimestamp: true,
				})
			)
		).toBe("webhook_missing_headers");
		const ok = await verifyNotifyWebhook({
			kind: "destination",
			headers: deliveryHeaders(),
			payload: body,
			secret: SECRET,
			now: NOW,
			requireTimestamp: true,
		});
		expect(ok.replayProtected).toBe(true);
	});

	test("an empty secret is refused before any signature check", async () => {
		expect(
			await failureCode(
				verifyNotifyWebhook({
					kind: "destination",
					headers: deliveryHeaders(),
					payload: body,
					secret: "",
					now: NOW,
				})
			)
		).toBe("webhook_invalid_secret");
	});

	test("an unset secret is reported before missing headers, as for Mail", async () => {
		for (const kind of ["destination", "callback"] as const) {
			for (const secret of [undefined, null, ""]) {
				expect(
					await failureCode(
						verifyNotifyWebhook({
							kind,
							headers: {},
							payload: body,
							secret: secret as unknown as string,
							now: NOW,
						})
					)
				).toBe("webhook_invalid_secret");
			}
		}
	});
});

describe("verifyNotifyWebhook callback", () => {
	const body = JSON.stringify({
		eventId: "evt_9",
		response: {
			status: "approved",
			callbackUrl: "https://hooks.example.com/r",
		},
		type: "notification.response",
	});

	function callbackHeaders(timestamp = TIMESTAMP, signedBody = body) {
		return {
			"content-type": "application/json",
			"x-ryu-notify-event": "evt_9",
			"x-ryu-notify-timestamp": timestamp,
			"x-ryu-notify-signature": callbackSignature(timestamp, signedBody),
		};
	}

	test("verifies timestamp.body and returns the parsed body", async () => {
		const delivery = await verifyNotifyWebhook({
			kind: "callback",
			headers: callbackHeaders(),
			payload: body,
			secret: SECRET,
			now: NOW,
		});
		expect(delivery).toEqual({
			kind: "callback",
			eventId: "evt_9",
			deliveryId: null,
			body: JSON.parse(body),
			replayProtected: true,
		});
	});

	test("rejects a callback timestamp outside the tolerance window", async () => {
		const stale = String(Number(TIMESTAMP) - 301);
		expect(
			await failureCode(
				verifyNotifyWebhook({
					kind: "callback",
					headers: callbackHeaders(stale),
					payload: body,
					secret: SECRET,
					now: NOW,
				})
			)
		).toBe("webhook_timestamp_out_of_range");
		expect(
			await verifyNotifyWebhook({
				kind: "callback",
				headers: callbackHeaders(stale),
				payload: body,
				secret: SECRET,
				now: NOW,
				toleranceSeconds: 600,
			})
		).toMatchObject({ eventId: "evt_9" });
	});

	test("a callback's event header must match the signed eventId", async () => {
		expect(
			await failureCode(
				verifyNotifyWebhook({
					kind: "callback",
					headers: { ...callbackHeaders(), "x-ryu-notify-event": "evt_B" },
					payload: body,
					secret: SECRET,
					now: NOW,
				})
			)
		).toBe("webhook_invalid_signature");
	});

	test("a non-finite or out-of-range toleranceSeconds is a configuration error", async () => {
		for (const toleranceSeconds of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			-1,
			10 ** 9,
		]) {
			await expect(
				verifyNotifyWebhook({
					kind: "callback",
					headers: callbackHeaders("1000000000"),
					payload: body,
					secret: SECRET,
					now: NOW,
					toleranceSeconds,
				})
			).rejects.toBeInstanceOf(RyuConfigurationError);
		}
	});

	test("rejects a callback whose timestamp was changed after signing", async () => {
		const headers = {
			...callbackHeaders(),
			"x-ryu-notify-timestamp": String(Number(TIMESTAMP) + 5),
		};
		expect(
			await failureCode(
				verifyNotifyWebhook({
					kind: "callback",
					headers,
					payload: body,
					secret: SECRET,
					now: NOW,
				})
			)
		).toBe("webhook_invalid_signature");
	});

	test("a destination-style signature does not pass as a callback", async () => {
		expect(
			await failureCode(
				verifyNotifyWebhook({
					kind: "callback",
					headers: {
						...callbackHeaders(),
						"x-ryu-notify-signature": destinationSignature(body),
					},
					payload: body,
					secret: SECRET,
					now: NOW,
				})
			)
		).toBe("webhook_invalid_signature");
	});

	test("requires the timestamp header", async () => {
		expect(
			await failureCode(
				verifyNotifyWebhook({
					kind: "callback",
					headers: {
						"x-ryu-notify-signature": callbackSignature(TIMESTAMP, body),
					},
					payload: body,
					secret: SECRET,
					now: NOW,
				})
			)
		).toBe("webhook_missing_headers");
	});

	test("a verified callback body that is not JSON is webhook_payload_invalid", async () => {
		const text = "approved";
		expect(
			await failureCode(
				verifyNotifyWebhook({
					kind: "callback",
					headers: callbackHeaders(TIMESTAMP, text),
					payload: text,
					secret: SECRET,
					now: NOW,
				})
			)
		).toBe("webhook_payload_invalid");
	});
});
