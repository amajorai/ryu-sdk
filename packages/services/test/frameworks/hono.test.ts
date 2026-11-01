// Executable snippet for apps/fumadocs/content/docs/standalone/sdk/frameworks/hono.mdx.
//
// The `// docs:start hono-app` … `// docs:end hono-app` region is the page's
// code block; apps/fumadocs/src/lib/standalone-sdk-docs.test.ts fails when
// they differ. `// docs:show <text>` lines render as `<text>` (the published
// import specifiers do not resolve inside this package, so the real imports
// at the top of this file load the same entry points by relative path), and
// leading tabs render as two spaces. The app runs through `app.request()`
// with a stub `globalThis.fetch`, once as Workers sees it (the user agent set
// to `Cloudflare-Workers`, bindings passed as `c.env`) and once as Bun runs
// it (configuration in `process.env`, where `c.env` is not the environment).

// biome-ignore-all lint/suspicious/noExportsInTest: the default export is the documented Hono app.

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type ErrorHandler, Hono } from "hono";
import { env } from "hono/adapter";
import { createMiddleware } from "hono/factory";
import { mailWebhookSignatureHeaders } from "../../../api/src/lib/mail-webhooks.ts";
import { isRyuError, Ryu } from "../../src/index.ts";
import {
	type MailWebhookEvent,
	verifyMailWebhook,
} from "../../src/webhooks/index.ts";

const MAIL_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const BINDINGS = {
	RYU_NOTIFY_URL: "https://notify.example.com",
	RYU_NOTIFY_API_KEY: "test-notify-tenant-key",
	MAIL_WEBHOOK_SECRET: MAIL_SECRET,
};
const PUBLISHED = JSON.parse(
	readFileSync(
		resolve(import.meta.dir, "../fixtures/notify/publish-created.json"),
		"utf8"
	)
) as { body: unknown; headers: Record<string, string>; status: number };

const requests: Request[] = [];
let nextResponse: () => Response;
const realFetch = globalThis.fetch;

beforeAll(() => {
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => {
			requests.push(new Request(input, init));
			return Promise.resolve(nextResponse());
		},
		{ preconnect: realFetch.preconnect }
	);
});

afterAll(() => {
	globalThis.fetch = realFetch;
});

beforeEach(() => {
	requests.length = 0;
	nextResponse = () =>
		new Response(JSON.stringify(PUBLISHED.body), {
			status: PUBLISHED.status,
			headers: PUBLISHED.headers,
		});
});

// docs:start hono-app
// docs:show import { Hono } from "hono";
// docs:show import { env } from "hono/adapter";
// docs:show import { createMiddleware } from "hono/factory";
// docs:show import { isRyuError, Ryu } from "@ryuhq/services";
// docs:show import { type MailWebhookEvent, verifyMailWebhook } from "@ryuhq/services/webhooks";
// docs:show
interface Env {
	Bindings: {
		RYU_NOTIFY_URL?: string;
		RYU_NOTIFY_API_KEY: string;
		MAIL_WEBHOOK_SECRET: string;
	};
	Variables: { mailEvent: MailWebhookEvent };
}

const app = new Hono<Env>();

// Verifies the raw body before any handler reads it; failures reach onError.
const verifiedMail = createMiddleware<Env>(async (c, next) => {
	const event = await verifyMailWebhook({
		payload: await c.req.text(),
		headers: c.req.raw.headers,
		secret: env<Env["Bindings"]>(c).MAIL_WEBHOOK_SECRET,
	});
	c.set("mailEvent", event);
	await next();
});

app.post("/deploys", async (c) => {
	// env(c) is c.env on Workers and the process environment on Node.js, Bun, and Deno.
	const ryu = new Ryu({ env: env<Env["Bindings"]>(c) });
	const event = await ryu.notify.publish({
		title: "Deploy finished",
		level: "success",
	});
	return c.json({ id: event.id }, 201);
});

app.post("/webhooks/mail", verifiedMail, (c) => {
	const event = c.get("mailEvent");
	// Deliveries can repeat: dedupe on event_id before acting on it.
	return c.json({ ok: true, eventId: event.event_id });
});

app.onError((error, c) => {
	if (isRyuError(error)) {
		// 422: a signed body that is not a Mail event; 401: other verification errors.
		const status =
			error.code === "webhook_payload_invalid"
				? 422
				: error.code.startsWith("webhook_")
					? 401
					: 502;
		return c.json({ code: error.code, requestId: error.requestId }, status);
	}
	return c.json({ code: "internal_error" }, 500);
});

export default app;
// docs:end hono-app

function mailDelivery(rawBody?: string): {
	body: string;
	headers: Record<string, string>;
} {
	const body =
		rawBody ??
		JSON.stringify({
			type: "event",
			event_type: "message.received",
			event_id: "evt_hono_1",
			data: { message: { id: "msg_1" }, recipients: ["a@example.com"] },
		});
	return {
		body,
		headers: mailWebhookSignatureHeaders(
			"standard",
			MAIL_SECRET,
			"evt_hono_1",
			String(Math.floor(Date.now() / 1000)),
			body
		),
	};
}

const CONFIG_NAMES = [
	"RYU_NOTIFY_URL",
	"RYU_NOTIFY_API_KEY",
	"MAIL_WEBHOOK_SECRET",
] as const;

/** Runs `body` with `process.env` holding exactly `values` for the app's names. */
async function withProcessEnv(
	values: Partial<Record<(typeof CONFIG_NAMES)[number], string>>,
	body: () => Promise<void>
): Promise<void> {
	const saved = CONFIG_NAMES.map((name) => [name, process.env[name]] as const);
	for (const name of CONFIG_NAMES) {
		const value = values[name];
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	}
	try {
		await body();
	} finally {
		for (const [name, value] of saved) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
	}
}

describe("Hono app on Workers", () => {
	// hono/adapter's env(c) picks c.env when the user agent is Cloudflare-Workers.
	const realNavigator = Object.getOwnPropertyDescriptor(
		globalThis,
		"navigator"
	);
	beforeAll(() => {
		Object.defineProperty(globalThis, "navigator", {
			value: { userAgent: "Cloudflare-Workers" },
			configurable: true,
		});
	});
	afterAll(() => {
		if (realNavigator) {
			Object.defineProperty(globalThis, "navigator", realNavigator);
		}
	});

	test("publishes to Notify with the bindings from c.env", async () => {
		const response = await app.request(
			"/deploys",
			{ method: "POST" },
			BINDINGS
		);
		expect(response.status).toBe(201);
		expect(await response.json()).toEqual({
			id: "evt_220eb04632bc4239be622f93ea63a8ec",
		});
		expect(requests).toHaveLength(1);
		const [sent] = requests;
		expect(sent?.url).toBe("https://notify.example.com/v1/events");
		expect(sent?.headers.get("authorization")).toBe(
			"Bearer test-notify-tenant-key"
		);
		expect(sent?.headers.get("idempotency-key")).toBeTruthy();
	});

	test("reads no process.env: without bindings the call fails with a configuration error", async () => {
		const response = await app.request("/deploys", { method: "POST" }, {});
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			code: "configuration_error",
			requestId: null,
		});
		expect(requests).toHaveLength(0);
	});

	test("maps a failed Ryu call through the isRyuError handler", async () => {
		nextResponse = () =>
			Response.json(
				{
					ok: false,
					type: "notify.error",
					code: "unauthorized",
					message: "Unknown tenant key.",
					status: 401,
					requestId: "req_hono_401",
					error: {
						code: "unauthorized",
						message: "Unknown tenant key.",
						requestId: "req_hono_401",
						status: 401,
					},
				},
				{ status: 401 }
			);
		const response = await app.request(
			"/deploys",
			{ method: "POST" },
			BINDINGS
		);
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			code: "unauthorized",
			requestId: "req_hono_401",
		});
	});

	test("the webhook middleware passes a verified Mail event to the handler", async () => {
		const { body, headers } = mailDelivery();
		const response = await app.request(
			"/webhooks/mail",
			{ method: "POST", body, headers },
			BINDINGS
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			eventId: "evt_hono_1",
		});
	});

	test("a forged Mail delivery is answered 401 and never reaches the handler", async () => {
		const { body, headers } = mailDelivery();
		const response = await app.request(
			"/webhooks/mail",
			{ method: "POST", body: `${body} `, headers },
			BINDINGS
		);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({
			code: "webhook_invalid_signature",
			requestId: null,
		});
	});

	test("a signed delivery that is not a Mail event is answered 422", async () => {
		const { body, headers } = mailDelivery('{"type":"event"}');
		const response = await app.request(
			"/webhooks/mail",
			{ method: "POST", body, headers },
			BINDINGS
		);
		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			code: "webhook_payload_invalid",
			requestId: null,
		});
	});

	test("a delivery without signature headers is answered 401", async () => {
		const response = await app.request(
			"/webhooks/mail",
			{ method: "POST", body: "{}" },
			BINDINGS
		);
		expect(response.status).toBe(401);
		expect(((await response.json()) as { code: string }).code).toBe(
			"webhook_missing_headers"
		);
	});

	test("errors that are not RyuErrors answer 500", async () => {
		// Hono keeps the onError handler on the app; reuse it on a probe route.
		const { errorHandler } = app as unknown as { errorHandler: ErrorHandler };
		const probe = new Hono();
		probe.onError(errorHandler);
		probe.get("/boom", () => {
			throw new Error("boom");
		});
		const response = await probe.request("/boom");
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ code: "internal_error" });
	});

	test("reads no process.env: without bindings the webhook secret is missing", async () => {
		await withProcessEnv(BINDINGS, async () => {
			const { body, headers } = mailDelivery();
			const response = await app.request(
				"/webhooks/mail",
				{ method: "POST", body, headers },
				{}
			);
			expect(response.status).toBe(401);
		});
	});
});

describe("Hono app on Bun", () => {
	test("publishes to Notify with the configuration from process.env", async () => {
		await withProcessEnv(BINDINGS, async () => {
			const response = await app.request("/deploys", { method: "POST" });
			expect(response.status).toBe(201);
			expect(requests[0]?.url).toBe("https://notify.example.com/v1/events");
			expect(requests[0]?.headers.get("authorization")).toBe(
				"Bearer test-notify-tenant-key"
			);
		});
	});

	test("verifies a Mail delivery with the secret from process.env", async () => {
		await withProcessEnv(BINDINGS, async () => {
			const { body, headers } = mailDelivery();
			const response = await app.request("/webhooks/mail", {
				method: "POST",
				body,
				headers,
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				ok: true,
				eventId: "evt_hono_1",
			});
		});
	});

	test("without the key in process.env the call fails with a configuration error", async () => {
		await withProcessEnv({}, async () => {
			const response = await app.request("/deploys", { method: "POST" });
			expect(response.status).toBe(502);
			expect(await response.json()).toEqual({
				code: "configuration_error",
				requestId: null,
			});
			expect(requests).toHaveLength(0);
		});
	});

	test("the shown imports are the entry points the app uses", () => {
		expect(typeof Hono).toBe("function");
		expect(typeof env).toBe("function");
		expect(typeof createMiddleware).toBe("function");
		expect(typeof verifyMailWebhook).toBe("function");
		expect(new Ryu({ env: false }).resultMode).toBe("throw");
	});
});
