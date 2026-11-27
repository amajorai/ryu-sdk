import { describe, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mailWebhookSignatureHeaders } from "../../../api/src/lib/mail-webhooks.ts";
import { RyuWebhookVerificationError } from "../errors.ts";
import { Ryu } from "../ryu.ts";
import { verifyWebhook, webhookHandler } from "./index.ts";
import type { MailWebhookEvent } from "./mail.ts";
import type { NotifyWebhookDelivery } from "./notify.ts";

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const NOW = new Date("2026-10-21T12:00:00Z");
const TIMESTAMP = String(Math.floor(NOW.getTime() / 1000));
const MAIL_BODY = JSON.stringify({
	type: "event",
	event_type: "message.delivered",
	event_id: "evt_1",
	data: { message: { id: "msg_1" } },
});
const URL = "https://app.example.com/webhooks/ryu";

function mailRequest(
	headers: Record<string, string>,
	body = MAIL_BODY,
	method = "POST"
): Request {
	return new Request(URL, {
		method,
		headers: { "content-type": "application/json", ...headers },
		body: method === "GET" ? undefined : body,
	});
}

function signedMailHeaders(
	secret = SECRET,
	body = MAIL_BODY
): Record<string, string> {
	return mailWebhookSignatureHeaders(
		"standard",
		secret,
		"evt_1",
		TIMESTAMP,
		body
	);
}

describe("webhookHandler (mail)", () => {
	test("answers 200 {ok:true} and calls onEvent once with the typed event", async () => {
		const events: MailWebhookEvent[] = [];
		const handler = webhookHandler({
			service: "mail",
			secret: SECRET,
			now: () => NOW,
			onEvent: (event) => {
				events.push(event);
			},
		});
		const response = await handler(mailRequest(signedMailHeaders()));
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/json");
		expect(await response.json()).toEqual({ ok: true });
		expect(events.map((event) => event.event_type)).toEqual([
			"message.delivered",
		]);
	});

	test("answers 401 JSON with the code and skips onEvent on a bad signature", async () => {
		let called = false;
		const handler = webhookHandler({
			service: "mail",
			secret: SECRET,
			now: () => NOW,
			onEvent: () => {
				called = true;
			},
		});
		const response = await handler(
			mailRequest(
				signedMailHeaders("whsec_dGhpcyBpcyBhIGRpZmZlcmVudCBrZXkhIQ==")
			)
		);
		expect(response.status).toBe(401);
		const body = (await response.json()) as {
			ok: boolean;
			error: { code: string; message: string };
		};
		expect(body.ok).toBe(false);
		expect(body.error.code).toBe("webhook_invalid_signature");
		expect(JSON.stringify(body)).not.toContain(SECRET.slice(6));
		expect(called).toBe(false);
	});

	test("answers 401 when headers are missing or the timestamp is stale", async () => {
		const handler = webhookHandler({
			service: "mail",
			secret: SECRET,
			now: () => new Date(NOW.getTime() + 3_600_000),
			onEvent: () => undefined,
		});
		const missing = await handler(mailRequest({}));
		expect(missing.status).toBe(401);
		expect(
			((await missing.json()) as { error: { code: string } }).error.code
		).toBe("webhook_missing_headers");
		const stale = await handler(mailRequest(signedMailHeaders()));
		expect(stale.status).toBe(401);
		expect(
			((await stale.json()) as { error: { code: string } }).error.code
		).toBe("webhook_timestamp_out_of_range");
	});

	test("answers 405 to non-POST requests", async () => {
		const handler = webhookHandler({
			service: "mail",
			secret: SECRET,
			onEvent: () => undefined,
		});
		const response = await handler(mailRequest({}, MAIL_BODY, "GET"));
		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("POST");
	});

	test("answers 500 without detail when onEvent throws and hands the error to onError", async () => {
		const failure = new Error("database password=hunter2 unreachable");
		const reported: unknown[] = [];
		const handler = webhookHandler({
			service: "mail",
			secret: SECRET,
			now: () => NOW,
			onEvent: () => {
				throw failure;
			},
			onError: (error, request) => {
				reported.push(error, request.url);
			},
		});
		const response = await handler(mailRequest(signedMailHeaders()));
		expect(response.status).toBe(500);
		const text = await response.text();
		expect(text).not.toContain("hunter2");
		expect(JSON.parse(text)).toEqual({
			ok: false,
			error: { code: "handler_error", message: "The webhook handler failed." },
		});
		expect(reported).toEqual([failure, URL]);
	});

	test("reports an onEvent failure with console.error when onError is absent", async () => {
		const failure = new Error("boom");
		const spy = spyOn(console, "error").mockImplementation(() => undefined);
		try {
			const handler = webhookHandler({
				service: "mail",
				secret: SECRET,
				now: () => NOW,
				onEvent: () => {
					throw failure;
				},
			});
			const response = await handler(mailRequest(signedMailHeaders()));
			expect(response.status).toBe(500);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy.mock.calls[0]?.[1]).toBe(failure);
		} finally {
			spy.mockRestore();
		}
	});

	test("still answers 500 when onError itself throws", async () => {
		const handler = webhookHandler({
			service: "mail",
			secret: SECRET,
			now: () => NOW,
			onEvent: () => {
				throw new Error("first");
			},
			onError: () => {
				throw new Error("reporter down");
			},
		});
		const response = await handler(mailRequest(signedMailHeaders()));
		expect(response.status).toBe(500);
	});

	test("passes a verified event of a type newer than this SDK to onEvent with 200", async () => {
		const body = JSON.stringify({
			type: "event",
			event_type: "message.new_type",
			event_id: "evt_1",
			data: {},
		});
		const events: MailWebhookEvent[] = [];
		const handler = webhookHandler({
			service: "mail",
			secret: SECRET,
			now: () => NOW,
			onEvent: (event) => {
				events.push(event);
			},
		});
		const response = await handler(
			mailRequest(signedMailHeaders(SECRET, body), body)
		);
		expect(response.status).toBe(200);
		expect(events.map((event) => event.event_type)).toEqual([
			"message.new_type",
		]);
	});

	test("answers 422, not 401, to an authentic body that is not a Mail event", async () => {
		let called = false;
		const handler = webhookHandler({
			service: "mail",
			secret: SECRET,
			now: () => NOW,
			onEvent: () => {
				called = true;
			},
		});
		for (const body of ["not json", JSON.stringify({ hello: "world" })]) {
			const response = await handler(
				mailRequest(signedMailHeaders(SECRET, body), body)
			);
			expect(response.status).toBe(422);
			expect(
				((await response.json()) as { error: { code: string } }).error.code
			).toBe("webhook_payload_invalid");
		}
		expect(called).toBe(false);
	});

	test("awaits an async onEvent before answering", async () => {
		const order: string[] = [];
		const handler = webhookHandler({
			service: "mail",
			secret: SECRET,
			now: () => NOW,
			onEvent: async () => {
				await Promise.resolve();
				order.push("handled");
			},
		});
		await handler(mailRequest(signedMailHeaders()));
		order.push("answered");
		expect(order).toEqual(["handled", "answered"]);
	});
});

describe("webhookHandler body handling", () => {
	test("a body over maxBodyBytes gets 413 and onEvent is not called", async () => {
		let called = false;
		const handler = webhookHandler({
			service: "mail",
			secret: SECRET,
			now: () => NOW,
			maxBodyBytes: 16,
			onEvent: () => {
				called = true;
			},
		});
		const response = await handler(mailRequest(signedMailHeaders()));
		expect(response.status).toBe(413);
		expect(called).toBe(false);
		const streamed = new Request(URL, {
			method: "POST",
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array(10));
					controller.enqueue(new Uint8Array(10));
					controller.close();
				},
			}),
			// @ts-expect-error Bun and Node need duplex for a streamed request body.
			duplex: "half",
		});
		expect((await handler(streamed)).status).toBe(413);
	});

	test("verifies the raw bytes: a leading BOM is not stripped before the HMAC", async () => {
		const bomBody = `\uFEFF${MAIL_BODY}`;
		const events: MailWebhookEvent[] = [];
		const handler = webhookHandler({
			service: "mail",
			secret: SECRET,
			now: () => NOW,
			onEvent: (event) => {
				events.push(event);
			},
		});
		// Signed over the body without the BOM, sent with one: must not verify.
		const response = await handler(
			mailRequest(signedMailHeaders(SECRET, MAIL_BODY), bomBody)
		);
		expect(response.status).toBe(401);
		expect(events).toHaveLength(0);
		// Signed over the bytes as sent, BOM included: verifies.
		const signed = await handler(
			mailRequest(signedMailHeaders(SECRET, bomBody), bomBody)
		);
		expect(signed.status).toBe(200);
		expect(events).toHaveLength(1);
	});

	test("bad toleranceSeconds or maxBodyBytes fail when the handler is built", () => {
		const onEvent = () => undefined;
		expect(() =>
			webhookHandler({
				service: "mail",
				secret: SECRET,
				toleranceSeconds: Number.NaN,
				onEvent,
			})
		).toThrow("toleranceSeconds");
		expect(() =>
			webhookHandler({
				service: "notify",
				secret: SECRET,
				maxBodyBytes: 0,
				onEvent,
			})
		).toThrow("maxBodyBytes");
	});
});

describe("webhookHandler and verifyWebhook with an unset secret", () => {
	test("an unset or empty secret is not thrown at build time but answers 401 per delivery", async () => {
		// A Worker builds the handler inside fetch() from its bindings; a throw
		// there would answer 5xx and the sender would retry.
		const titles = {
			mail: "Ryu Mail",
			messaging: "Ryu Messaging",
			notify: "Ryu Notify",
		} as const;
		for (const service of ["mail", "messaging", "notify"] as const) {
			for (const secret of [undefined, ""]) {
				let called = false;
				const handle = (request: Request) =>
					webhookHandler({
						service,
						secret: secret as unknown as string,
						now: () => NOW,
						onEvent: () => {
							called = true;
						},
					})(request);
				const response = await handle(mailRequest(signedMailHeaders()));
				expect(response.status).toBe(401);
				expect(await response.json()).toEqual({
					ok: false,
					error: {
						code: "webhook_invalid_secret",
						message: `${titles[service]} webhook: the signing secret is empty.`,
					},
				});
				expect(called).toBe(false);
			}
		}
	});

	test("verifyWebhook({service}) rejects with webhook_invalid_secret, not a TypeError", async () => {
		const headers = signedMailHeaders();
		for (const service of ["mail", "messaging", "notify"] as const) {
			const attempt = verifyWebhook({
				service,
				headers,
				payload: MAIL_BODY,
				secret: undefined as unknown as string,
				now: NOW,
			});
			await expect(attempt).rejects.toBeInstanceOf(RyuWebhookVerificationError);
			await expect(attempt).rejects.toMatchObject({
				code: "webhook_invalid_secret",
			});
		}
	});
});

describe("webhookHandler (notify)", () => {
	const destinationSecret = "notify-secret";
	const body = JSON.stringify({
		deliveryId: "dlv_7",
		event: { id: "evt_7", title: "Deployed" },
		type: "notification",
	});

	test("verifies body-only destination deliveries only with allowBodyOnlySignature", async () => {
		const deliveries: NotifyWebhookDelivery[] = [];
		const handler = webhookHandler({
			service: "notify",
			secret: destinationSecret,
			allowBodyOnlySignature: true,
			onEvent: (delivery) => {
				deliveries.push(delivery);
			},
		});
		const signature = createHmac("sha256", destinationSecret)
			.update(body)
			.digest("hex");
		const response = await handler(
			new Request(URL, {
				method: "POST",
				body,
				headers: {
					"x-ryu-notify-event": "evt_7",
					"x-ryu-notify-delivery": "dlv_7",
					"x-ryu-notify-signature": `sha256=${signature}`,
				},
			})
		);
		expect(response.status).toBe(200);
		expect(deliveries).toEqual([
			{
				kind: "destination",
				eventId: "evt_7",
				deliveryId: "dlv_7",
				body: JSON.parse(body),
				replayProtected: false,
			},
		]);
	});

	test("verifies callbacks when kind is callback and rejects forgeries with 401", async () => {
		const handler = webhookHandler({
			service: "notify",
			kind: "callback",
			secret: destinationSecret,
			now: () => NOW,
			onEvent: () => undefined,
		});
		const signature = createHmac("sha256", destinationSecret)
			.update(`${TIMESTAMP}.${body}`)
			.digest("hex");
		const request = (sig: string) =>
			new Request(URL, {
				method: "POST",
				body,
				headers: {
					"x-ryu-notify-event": "evt_7",
					"x-ryu-notify-timestamp": TIMESTAMP,
					"x-ryu-notify-signature": `sha256=${sig}`,
				},
			});
		expect((await handler(request(signature))).status).toBe(200);
		expect((await handler(request("0".repeat(64)))).status).toBe(401);
	});

	test("a body-only destination delivery is refused with 401 by default and by requireTimestamp", async () => {
		let calls = 0;
		const handler = webhookHandler({
			service: "notify",
			secret: destinationSecret,
			onEvent: () => {
				calls += 1;
			},
		});
		const signature = createHmac("sha256", destinationSecret)
			.update(body)
			.digest("hex");
		const response = await handler(
			new Request(URL, {
				method: "POST",
				body,
				headers: { "x-ryu-notify-signature": `sha256=${signature}` },
			})
		);
		expect(response.status).toBe(401);
		const required = webhookHandler({
			service: "notify",
			secret: destinationSecret,
			allowBodyOnlySignature: true,
			requireTimestamp: true,
			onEvent: () => {
				calls += 1;
			},
		});
		const again = await required(
			new Request(URL, {
				method: "POST",
				body,
				headers: { "x-ryu-notify-signature": `sha256=${signature}` },
			})
		);
		expect(again.status).toBe(401);
		expect(calls).toBe(0);
	});
});

describe("verifyWebhook dispatch", () => {
	test("verifies Mail through the generic entry point and ryu.webhooks.verify", async () => {
		const options = {
			service: "mail" as const,
			headers: signedMailHeaders(),
			payload: MAIL_BODY,
			secret: SECRET,
			now: NOW,
		};
		const direct = await verifyWebhook(options);
		expect(direct.event_type).toBe("message.delivered");
		expect(await new Ryu({ env: {} }).webhooks.verify(options)).toEqual(direct);
	});

	test("verifies Notify through the generic entry point", async () => {
		const body = "{}";
		const signature = createHmac("sha256", "s").update(body).digest("hex");
		const delivery = await verifyWebhook({
			service: "notify",
			headers: { "x-ryu-notify-signature": `sha256=${signature}` },
			payload: body,
			secret: "s",
			allowBodyOnlySignature: true,
		});
		expect(delivery.kind).toBe("destination");
		expect(delivery.body).toEqual({});
	});

	test("refuses a body-only Notify delivery through the generic entry point by default", async () => {
		const body = "{}";
		const signature = createHmac("sha256", "s").update(body).digest("hex");
		await expect(
			verifyWebhook({
				service: "notify",
				headers: { "x-ryu-notify-signature": `sha256=${signature}` },
				payload: body,
				secret: "s",
			})
		).rejects.toMatchObject({ code: "webhook_missing_headers" });
	});

	test("passes requireTimestamp through to the Notify verifier", async () => {
		const body = "{}";
		const signature = createHmac("sha256", "s").update(body).digest("hex");
		const attempt = verifyWebhook({
			service: "notify",
			headers: { "x-ryu-notify-signature": `sha256=${signature}` },
			payload: body,
			secret: "s",
			requireTimestamp: true,
		});
		await expect(attempt).rejects.toMatchObject({
			code: "webhook_missing_headers",
		});
	});
});
