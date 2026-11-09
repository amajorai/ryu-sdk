import { describe, expect, test } from "bun:test";
import { mailWebhookSignatureHeaders } from "../../../api/src/lib/mail-webhooks.ts";
import { MAIL_EVENT_TYPES as SERVER_MAIL_EVENT_TYPES } from "../../../mail/src/contract.ts";
import { RyuWebhookVerificationError } from "../errors.ts";
import {
	isKnownMailWebhookEvent,
	type KnownMailWebhookEvent,
	MAIL_EVENT_TYPES,
	type MailWebhookEvent,
	parseMailWebhookEvent,
	verifyMailWebhook,
} from "./mail.ts";

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const NOW = new Date("2026-10-21T12:00:00Z");
const TIMESTAMP = String(Math.floor(NOW.getTime() / 1000));

/** A delivery body exactly as packages/api deliverOnce and the Rust sidecar build it. */
function deliveryBody(eventType: string, eventId = "evt_1"): string {
	return JSON.stringify({
		type: "event",
		event_type: eventType,
		event_id: eventId,
		data: { message: { id: "msg_1" }, recipients: ["a@example.com"] },
	});
}

async function failureCode(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof RyuWebhookVerificationError) {
			return error.code;
		}
		throw error;
	}
	throw new Error("expected verification to fail");
}

describe("MAIL_EVENT_TYPES lockstep", () => {
	test("equals packages/mail/src/contract.ts in order", () => {
		expect([...MAIL_EVENT_TYPES]).toEqual([...SERVER_MAIL_EVENT_TYPES]);
	});
});

describe("verifyMailWebhook", () => {
	test("returns a typed event for every known event type", async () => {
		for (const eventType of MAIL_EVENT_TYPES) {
			const body = deliveryBody(eventType, `evt_${eventType}`);
			const event = await verifyMailWebhook({
				headers: mailWebhookSignatureHeaders(
					"standard",
					SECRET,
					`evt_${eventType}`,
					TIMESTAMP,
					body
				),
				payload: body,
				secret: SECRET,
				now: NOW,
			});
			expect(event.event_type).toBe(eventType);
			expect(event.event_id).toBe(`evt_${eventType}`);
			expect(event.type).toBe("event");
		}
	});

	test("narrows on event_type", async () => {
		const body = deliveryBody("message.bounced");
		const event: MailWebhookEvent = await verifyMailWebhook({
			headers: mailWebhookSignatureHeaders(
				"standard",
				SECRET,
				"evt_1",
				TIMESTAMP,
				body
			),
			payload: body,
			secret: SECRET,
			now: NOW,
		});
		if (event.event_type !== "message.bounced") {
			throw new Error("unexpected event type");
		}
		expect(event.data.recipients).toEqual(["a@example.com"]);
	});

	test("supports the legacy scheme", async () => {
		const body = deliveryBody("message.sent");
		const event = await verifyMailWebhook({
			headers: mailWebhookSignatureHeaders(
				"legacy",
				SECRET,
				"evt_1",
				TIMESTAMP,
				body
			),
			payload: body,
			secret: SECRET,
			now: NOW,
			scheme: "legacy",
		});
		expect(event.event_type).toBe("message.sent");
	});

	test("returns a correctly signed event of a type newer than this SDK", async () => {
		const body = deliveryBody("message.teleported");
		const event = await verifyMailWebhook({
			headers: mailWebhookSignatureHeaders(
				"standard",
				SECRET,
				"evt_1",
				TIMESTAMP,
				body
			),
			payload: body,
			secret: SECRET,
			now: NOW,
		});
		expect(event.event_type).toBe("message.teleported");
		expect(event.event_id).toBe("evt_1");
		expect(isKnownMailWebhookEvent(event)).toBe(false);
	});

	test("isKnownMailWebhookEvent narrows known event types", async () => {
		const body = deliveryBody("message.opened");
		const event = await verifyMailWebhook({
			headers: mailWebhookSignatureHeaders(
				"standard",
				SECRET,
				"evt_1",
				TIMESTAMP,
				body
			),
			payload: body,
			secret: SECRET,
			now: NOW,
		});
		if (!isKnownMailWebhookEvent(event)) {
			throw new Error("expected a known event");
		}
		const known: KnownMailWebhookEvent = event;
		expect(known.event_type).toBe("message.opened");
	});

	test("rejects a forged delivery before looking at the body", async () => {
		const body = deliveryBody("message.received");
		expect(
			await failureCode(
				verifyMailWebhook({
					headers: mailWebhookSignatureHeaders(
						"standard",
						"whsec_dGhpcyBpcyBhIGRpZmZlcmVudCBrZXkhIQ==",
						"evt_1",
						TIMESTAMP,
						body
					),
					payload: body,
					secret: SECRET,
					now: NOW,
				})
			)
		).toBe("webhook_invalid_signature");
	});
});

describe("parseMailWebhookEvent", () => {
	test.each<[unknown]>([
		[null],
		[[]],
		[{ type: "event" }],
		[{ type: "other", event_type: "message.sent", event_id: "e", data: {} }],
		[{ type: "event", event_type: "message.sent", event_id: 1, data: {} }],
		[{ type: "event", event_type: "message.sent", event_id: "e", data: null }],
		[{ type: "event", event_type: 7, event_id: "e", data: {} }],
	])("rejects malformed envelope %#", (body) => {
		expect(() => parseMailWebhookEvent(body)).toThrow(
			RyuWebhookVerificationError
		);
	});
});
