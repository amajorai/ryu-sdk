import { describe, expect, test } from "bun:test";
import {
	verifyMessagingWebhook as clientVerifyMessagingWebhook,
	type MessagingMessage,
	type MessagingNumber,
} from "@ryuhq/client";
import {
	createMessagingWebhookSecret,
	messagingWebhookRequest,
	MESSAGING_WEBHOOK_EVENT_TYPES as SERVER_EVENT_TYPES,
	serializeMessagingMessage,
	serializeMessagingNumber,
} from "../../../api/src/lib/messaging-webhooks.ts";
import { RyuWebhookVerificationError } from "../errors.ts";
import { verifyWebhook, webhookHandler } from "./index.ts";
import {
	isKnownMessagingWebhookEvent,
	MESSAGING_EVENT_TYPES,
	type MessagingWebhookMessage,
	type MessagingWebhookNumber,
	parseMessagingWebhookEvent,
	verifyMessagingWebhook,
} from "./messaging.ts";

// Vectors come from #777's own signer (`messagingWebhookRequest` in
// packages/api) with views from its serializers, and every one must verify
// with both this SDK's verifier and `@ryuhq/client`'s verifyMessagingWebhook.

const NOW = new Date("2026-10-21T12:00:00Z");
const NOW_MS = NOW.getTime();
const ORG = "64a0000000000000000000a1";
const CREATED = new Date("2026-10-21T11:59:00Z");

const MESSAGE_VIEW = serializeMessagingMessage({
	_id: "msg_1",
	organizationId: ORG,
	channel: "sms",
	direction: "outbound",
	status: "delivered",
	from: "+15555550100",
	to: "+6591234567",
	isoCountryCode: "SG",
	numberId: "num_1",
	body: "Your order has shipped.",
	bodyType: "text",
	encoding: "GSM",
	segments: 1,
	heldMicroUsd: 9000,
	priceMicroUsd: 8400,
	chargedMicroUsd: 8400,
	chargeState: "settled",
	metadata: { order: "1842" },
	createdAt: CREATED,
	updatedAt: CREATED,
});

const NUMBER_VIEW = serializeMessagingNumber({
	_id: "num_1",
	organizationId: ORG,
	phoneNumber: "+15555550100",
	isoCountryCode: "US",
	numberType: "TOLL_FREE",
	capabilities: ["SMS"],
	messageType: "TRANSACTIONAL",
	status: "suspended",
	monthlyLeaseMicroUsd: 2_000_000,
	leasePeriod: 2,
	createdAt: CREATED,
	updatedAt: CREATED,
	suspendedAt: CREATED,
});

function signed(
	secret: string,
	eventType: string,
	data: Record<string, unknown>,
	eventId = `evt_${eventType}`
) {
	return messagingWebhookRequest(
		secret,
		{
			data,
			eventId,
			eventType: eventType as (typeof SERVER_EVENT_TYPES)[number],
		},
		NOW_MS
	);
}

function dataFor(eventType: string): Record<string, unknown> {
	return eventType.startsWith("message.")
		? { message: MESSAGE_VIEW }
		: { number: NUMBER_VIEW };
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

describe("MESSAGING_EVENT_TYPES lockstep", () => {
	test("equals the server's MESSAGING_WEBHOOK_EVENT_TYPES in order", () => {
		expect([...MESSAGING_EVENT_TYPES]).toEqual([...SERVER_EVENT_TYPES]);
	});

	test("the webhook message and number shapes equal @ryuhq/client's", () => {
		// Type-level: each direction must assign, so neither copy can drift.
		const message = MESSAGE_VIEW as MessagingMessage;
		const asWebhook: MessagingWebhookMessage = message;
		const back: MessagingMessage = asWebhook;
		const number = NUMBER_VIEW as MessagingNumber;
		const numberAsWebhook: MessagingWebhookNumber = number;
		const numberBack: MessagingNumber = numberAsWebhook;
		expect(Object.keys(back).sort()).toEqual(Object.keys(MESSAGE_VIEW).sort());
		expect(Object.keys(numberBack).sort()).toEqual(
			Object.keys(NUMBER_VIEW).sort()
		);
	});
});

describe("verifyMessagingWebhook", () => {
	test("vectors from #777's signer verify with this SDK and with @ryuhq/client", async () => {
		const secret = createMessagingWebhookSecret();
		for (const eventType of SERVER_EVENT_TYPES) {
			const { body, headers } = signed(secret, eventType, dataFor(eventType));
			const ours = await verifyMessagingWebhook({
				headers,
				payload: body,
				secret,
				now: NOW,
			});
			const theirs = await clientVerifyMessagingWebhook(secret, headers, body, {
				now: NOW,
			});
			expect(ours).toEqual(JSON.parse(body));
			expect(theirs).toEqual(JSON.parse(body));
			expect(isKnownMessagingWebhookEvent(ours)).toBe(true);
			expect(ours.event_id).toBe(headers["webhook-id"] ?? "");
		}
	});

	test("the svix-* copies verify, and the typed data narrows on event_type", async () => {
		const secret = createMessagingWebhookSecret();
		const { body, headers } = signed(secret, "message.delivered", {
			message: MESSAGE_VIEW,
		});
		const svixOnly = Object.fromEntries(
			Object.entries(headers).filter(([name]) => !name.startsWith("webhook-"))
		);
		const event = await verifyMessagingWebhook({
			headers: new Headers(svixOnly),
			payload: new TextEncoder().encode(body),
			secret,
			now: NOW,
		});
		if (
			!isKnownMessagingWebhookEvent(event) ||
			event.event_type !== "message.delivered"
		) {
			throw new Error("expected a message.delivered event");
		}
		expect(event.data.message.chargedMicroUsd).toBe(8400);
		expect(event.data.message.status).toBe("delivered");
	});

	test("ryu.webhooks.verify and verifyWebhook dispatch service messaging", async () => {
		const secret = createMessagingWebhookSecret();
		const { body, headers } = signed(secret, "number.suspended", {
			number: NUMBER_VIEW,
		});
		const event = await verifyWebhook({
			service: "messaging",
			headers,
			payload: body,
			secret,
			now: NOW,
		});
		expect(event.event_type).toBe("number.suspended");
	});

	test("an event type newer than this SDK is authentic and not typed", async () => {
		const secret = createMessagingWebhookSecret();
		const { body, headers } = signed(secret, "number.renewed", {
			number: NUMBER_VIEW,
		});
		const event = await verifyMessagingWebhook({
			headers,
			payload: body,
			secret,
			now: NOW,
		});
		expect(event.event_type).toBe("number.renewed");
		expect(isKnownMessagingWebhookEvent(event)).toBe(false);
		const theirs = await clientVerifyMessagingWebhook(secret, headers, body, {
			now: NOW,
		});
		expect(theirs.event_type).toBe("number.renewed");
	});

	test("rejects forgeries, stale timestamps, bad secrets and missing headers like #777's verifier", async () => {
		const secret = createMessagingWebhookSecret();
		const other = createMessagingWebhookSecret();
		const { body, headers } = signed(secret, "message.failed", {
			message: MESSAGE_VIEW,
		});
		expect(
			await failureCode(
				verifyMessagingWebhook({
					headers,
					payload: body,
					secret: other,
					now: NOW,
				})
			)
		).toBe("webhook_invalid_signature");
		expect(
			await failureCode(
				verifyMessagingWebhook({
					headers,
					payload: body.replace("8400", "8401"),
					secret,
					now: NOW,
				})
			)
		).toBe("webhook_invalid_signature");
		expect(
			await failureCode(
				verifyMessagingWebhook({
					headers,
					payload: body,
					secret,
					now: new Date(NOW_MS + 301_000),
				})
			)
		).toBe("webhook_timestamp_out_of_range");
		expect(
			await failureCode(
				verifyMessagingWebhook({
					headers,
					payload: body,
					secret: "whsec_not base64!",
					now: NOW,
				})
			)
		).toBe("webhook_invalid_secret");
		expect(
			await failureCode(
				verifyMessagingWebhook({ headers: {}, payload: body, secret, now: NOW })
			)
		).toBe("webhook_missing_headers");
		// #777's verifier refuses the same forged and stale deliveries.
		await expect(
			clientVerifyMessagingWebhook(other, headers, body, { now: NOW })
		).rejects.toMatchObject({ reason: "invalid_signature" });
		await expect(
			clientVerifyMessagingWebhook(secret, headers, body, {
				now: new Date(NOW_MS + 301_000),
			})
		).rejects.toMatchObject({ reason: "timestamp_out_of_range" });
	});

	test("an authentic body that is not a Messaging event is webhook_payload_invalid", async () => {
		const secret = createMessagingWebhookSecret();
		const { body, headers } = signed(secret, "message.received", {
			message: { body: "no id" },
		});
		expect(
			await failureCode(
				verifyMessagingWebhook({ headers, payload: body, secret, now: NOW })
			)
		).toBe("webhook_payload_invalid");
		expect(() => parseMessagingWebhookEvent({ type: "event" })).toThrow(
			RyuWebhookVerificationError
		);
		expect(() => parseMessagingWebhookEvent([])).toThrow(
			RyuWebhookVerificationError
		);
	});

	test("errors name the messaging service and link the webhooks page", async () => {
		const error = await verifyMessagingWebhook({
			headers: {},
			payload: "{}",
			secret: "whsec_AAAA",
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(RyuWebhookVerificationError);
		expect((error as RyuWebhookVerificationError).service).toBe("messaging");
		expect((error as RyuWebhookVerificationError).docs).toContain(
			"/standalone/sdk/webhooks"
		);
	});

	test("webhookHandler answers 200 for an authentic delivery and 401 for a forgery", async () => {
		const secret = createMessagingWebhookSecret();
		const { body, headers } = signed(secret, "message.received", {
			message: { ...MESSAGE_VIEW, direction: "inbound", status: "received" },
		});
		const seen: string[] = [];
		const handler = webhookHandler({
			service: "messaging",
			secret,
			now: () => NOW,
			onEvent: (event) => {
				seen.push(event.event_type);
			},
		});
		const ok = await handler(
			new Request("https://hooks.example.com/messaging", {
				method: "POST",
				headers,
				body,
			})
		);
		expect(ok.status).toBe(200);
		expect(seen).toEqual(["message.received"]);
		const forged = await handler(
			new Request("https://hooks.example.com/messaging", {
				method: "POST",
				headers,
				body: body.replace("received", "delivered"),
			})
		);
		expect(forged.status).toBe(401);
		expect(seen).toHaveLength(1);
	});
});
