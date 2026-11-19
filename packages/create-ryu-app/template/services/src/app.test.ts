/**
 * Drives every route through `app.request()` with a stub `fetch` in place of
 * Ryu, so `bun test` needs no keys and no network.
 */

import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Ryu } from "@ryuhq/services";
import type { MailWebhookEvent } from "@ryuhq/services/webhooks";
import { createApp } from "./app.ts";
import { DEFAULT_PORT, readPort, readSettings } from "./settings.ts";

const MAIL_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const NOTIFY_SECRET = "notify-destination-secret";
const ENV = {
	RYU_API_KEY: "ryu_test_key",
	RYU_ORGANIZATION_ID: "org_test",
	RYU_NOTIFY_API_KEY: "notify-test-key",
};

interface Captured {
	headers: Headers;
	method: string;
	url: string;
}

/** A Ryu client whose requests are answered by `respond` and recorded in `calls`. */
function stubRyu(respond: (request: Request) => Response) {
	const calls: Captured[] = [];
	const ryu = new Ryu({
		env: ENV,
		maxRetries: 0,
		fetch: (input, init) => {
			const request = new Request(input, init);
			calls.push({
				headers: request.headers,
				method: request.method,
				url: request.url,
			});
			return Promise.resolve(respond(request));
		},
	});
	return { calls, ryu };
}

function json(body: unknown, status = 200, headers: HeadersInit = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

function post(path: string, body: unknown, headers: HeadersInit = {}) {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

/** Standard Webhooks headers: HMAC-SHA256 over `${id}.${timestamp}.${body}`. */
function standardHeaders(key: Buffer, id: string, body: string) {
	const timestamp = String(Math.floor(Date.now() / 1000));
	const signature = createHmac("sha256", key)
		.update(`${id}.${timestamp}.${body}`)
		.digest("base64");
	return {
		"content-type": "application/json",
		"webhook-id": id,
		"webhook-timestamp": timestamp,
		"webhook-signature": `v1,${signature}`,
	};
}

/** A Notify event as `POST /v1/events` returns it. */
function notification(id: string, title: string) {
	const at = "2026-10-01T00:00:00.000Z";
	return {
		id,
		title,
		actions: [],
		attachment: null,
		body: "",
		data: {},
		externalId: null,
		fingerprint: null,
		icon: null,
		level: "success",
		occurredAt: at,
		priority: 3,
		project: null,
		recipient: null,
		source: "app",
		tags: [],
		topic: null,
		type: "notification",
		url: null,
		response: null,
		acknowledgedAt: null,
		archivedAt: null,
		createdAt: at,
	};
}

const SETTINGS = readSettings({
	MAIL_FROM: "inbox_1",
	MAIL_WEBHOOK_SECRET: MAIL_SECRET,
	NOTIFY_WEBHOOK_SECRET: NOTIFY_SECRET,
});

describe("POST /notify", () => {
	test("publishes with RYU_NOTIFY_API_KEY and forwards the Idempotency-Key", async () => {
		const { calls, ryu } = stubRyu(() =>
			json({ event: notification("evt_1", "Deployed"), ok: true }, 201)
		);
		const app = createApp({ ryu, settings: SETTINGS });
		const response = await app.request(
			post(
				"/notify",
				{ title: "Deployed", level: "success" },
				{ "idempotency-key": "deploy-1" }
			)
		);
		expect(response.status).toBe(201);
		expect(await response.json()).toEqual({ data: { id: "evt_1" } });
		expect(calls[0]?.url).toBe("https://notify.ryuhq.com/v1/events");
		expect(calls[0]?.headers.get("authorization")).toBe(
			"Bearer notify-test-key"
		);
		expect(calls[0]?.headers.get("idempotency-key")).toBe("deploy-1");
	});

	test("rejects a body without a title before calling Ryu", async () => {
		const { calls, ryu } = stubRyu(() => json({}));
		const app = createApp({ ryu, settings: SETTINGS });
		const response = await app.request(post("/notify", { level: "info" }));
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: "invalid_request" },
		});
		expect(calls).toEqual([]);
	});

	test("a missing Notify key is a configuration error naming the variable", async () => {
		const ryu = new Ryu({ env: { RYU_API_KEY: "ryu_test_key" } });
		const app = createApp({ ryu, settings: SETTINGS });
		const response = await app.request(post("/notify", { title: "Hi" }));
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({
			error: { code: "configuration_error", missing: ["RYU_NOTIFY_API_KEY"] },
		});
	});

	test("a rate limit keeps its status and Retry-After", async () => {
		const { ryu } = stubRyu(() =>
			json({ error: "slow down", code: "rate_limited" }, 429, {
				"retry-after": "120",
			})
		);
		const app = createApp({ ryu, settings: SETTINGS });
		const response = await app.request(post("/notify", { title: "Hi" }));
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("120");
	});
});

describe("POST /mail", () => {
	test("sends from MAIL_FROM with the ryu_ key and organization", async () => {
		const { calls, ryu } = stubRyu(() => json({ id: "msg_1", status: "sent" }));
		const app = createApp({ ryu, settings: SETTINGS });
		const response = await app.request(
			post("/mail", {
				to: "person@example.com",
				subject: "Hi",
				text: "Hello",
			})
		);
		expect(response.status).toBe(201);
		expect(await response.json()).toEqual({ data: { id: "msg_1" } });
		expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
			"POST https://api.ryuhq.com/api/mail/inboxes/inbox_1/send",
		]);
		expect(calls[0]?.headers.get("x-api-key")).toBe("ryu_test_key");
		expect(calls[0]?.headers.get("x-ryu-organization")).toBe("org_test");
		expect(calls[0]?.headers.get("idempotency-key")).toBeTruthy();
	});

	test("a key without mail:send surfaces Ryu's typed error code", async () => {
		const { ryu } = stubRyu(() =>
			json(
				{
					error: "This API key does not have the mail:send scope.",
					code: "insufficient_scope",
					requiredScope: "mail:send",
				},
				403
			)
		);
		const app = createApp({ ryu, settings: SETTINGS });
		const response = await app.request(
			post("/mail", { to: "a@example.com", subject: "Hi", text: "Hello" })
		);
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({
			error: { code: "insufficient_scope" },
		});
	});

	test("answers a configuration error when MAIL_FROM is unset", async () => {
		const { calls, ryu } = stubRyu(() => json({}));
		const app = createApp({ ryu, settings: readSettings({}) });
		const response = await app.request(
			post("/mail", { to: "a@example.com", subject: "Hi", text: "Hello" })
		);
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({
			error: { code: "configuration_error", missing: ["MAIL_FROM"] },
		});
		expect(calls).toEqual([]);
	});
});

describe("webhooks", () => {
	const mailKey = Buffer.from(MAIL_SECRET.slice("whsec_".length), "base64");

	test("a signed Mail event reaches onMailEvent", async () => {
		const received: MailWebhookEvent[] = [];
		const { ryu } = stubRyu(() => json({}));
		const app = createApp({
			ryu,
			settings: SETTINGS,
			onMailEvent: (event) => {
				received.push(event);
			},
		});
		const body = JSON.stringify({
			type: "event",
			event_type: "message.received",
			event_id: "evt_mail_1",
			data: { message: { id: "msg_1" } },
		});
		const response = await app.request(
			post("/webhooks/mail", body, standardHeaders(mailKey, "evt_mail_1", body))
		);
		expect(response.status).toBe(200);
		expect(received.map((event) => event.event_id)).toEqual(["evt_mail_1"]);
	});

	test("a forged Mail delivery is refused with 401 and never handled", async () => {
		let handled = false;
		const { ryu } = stubRyu(() => json({}));
		const app = createApp({
			ryu,
			settings: SETTINGS,
			onMailEvent: () => {
				handled = true;
			},
		});
		const body = JSON.stringify({ type: "event", event_id: "evt_forged" });
		const response = await app.request(
			post(
				"/webhooks/mail",
				body,
				standardHeaders(Buffer.from("wrong-key"), "evt_forged", body)
			)
		);
		expect(response.status).toBe(401);
		expect(handled).toBe(false);
	});

	test("a signed Notify delivery reaches onNotifyDelivery", async () => {
		const deliveries: (string | null)[] = [];
		const { ryu } = stubRyu(() => json({}));
		const app = createApp({
			ryu,
			settings: SETTINGS,
			onNotifyDelivery: (delivery) => {
				deliveries.push(delivery.deliveryId);
			},
		});
		const body = JSON.stringify({
			deliveryId: "dlv_1",
			event: { id: "evt_1", title: "Deployed" },
			type: "notification",
		});
		const response = await app.request(
			post(
				"/webhooks/notify",
				body,
				standardHeaders(Buffer.from(NOTIFY_SECRET), "dlv_1", body)
			)
		);
		expect(response.status).toBe(200);
		expect(deliveries).toEqual(["dlv_1"]);
	});

	test("a webhook route without its secret answers 503 naming the variable", async () => {
		const { ryu } = stubRyu(() => json({}));
		const app = createApp({ ryu, settings: readSettings({}) });
		const response = await app.request(post("/webhooks/notify", "{}"));
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: { missing: ["NOTIFY_WEBHOOK_SECRET"] },
		});
	});
});

describe("readPort", () => {
	test("falls back to 3000 when PORT is unset, empty or blank", () => {
		expect(DEFAULT_PORT).toBe(3000);
		expect(readPort({})).toBe(3000);
		expect(readPort({ PORT: "" })).toBe(3000);
		expect(readPort({ PORT: "  " })).toBe(3000);
	});

	test("falls back to 3000 when PORT is not a valid port", () => {
		for (const value of ["abc", "0", "-1", "3000.5", "1e3", "70000"]) {
			expect({ value, port: readPort({ PORT: value }) }).toEqual({
				value,
				port: 3000,
			});
		}
	});

	test("uses a valid PORT, trimmed", () => {
		expect(readPort({ PORT: "8080" })).toBe(8080);
		expect(readPort({ PORT: " 4321 " })).toBe(4321);
	});
});
