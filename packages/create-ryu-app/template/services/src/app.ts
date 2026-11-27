/**
 * __APP_DISPLAY_NAME__: a small server on Ryu's standalone services.
 *
 *   POST /notify          publish a notification with Ryu Notify
 *   POST /mail            send an email with Ryu Mail (a ryu_ key with mail:send)
 *   POST /webhooks/mail   receive verified Mail webhook events
 *   POST /webhooks/notify receive verified Notify destination deliveries
 *
 * Successful responses are `{ data }`, failures `{ error }`. Every Ryu failure
 * is a typed `RyuError`; `toErrorResponse` turns it into an HTTP answer.
 */

import { isRyuError, Ryu, type RyuError } from "@ryuhq/services";
import {
	type MailWebhookEvent,
	type NotifyWebhookDelivery,
	webhookHandler,
} from "@ryuhq/services/webhooks";
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppSettings } from "./settings.ts";

/** What `createApp` takes. Everything has a default except the settings. */
export interface AppOptions {
	/** Runs once per verified Mail event. Deliveries can repeat: dedupe on `event.event_id`. */
	onMailEvent?(event: MailWebhookEvent): void | Promise<void>;
	/** Runs once per verified Notify delivery. Dedupe on `delivery.deliveryId`. */
	onNotifyDelivery?(delivery: NotifyWebhookDelivery): void | Promise<void>;
	/** The Ryu client. Default `new Ryu()`, which reads its keys from the environment. */
	ryu?: Ryu;
	settings: AppSettings;
}

/** The body of an error response. */
export interface ErrorBody {
	code: string;
	hint?: string;
	message: string;
	/** Env vars to set, for a configuration error. */
	missing?: string[];
	/** Quote it to Ryu support to trace the call. */
	requestId?: string;
}

type Level = "info" | "success" | "warning" | "error";
const LEVELS: readonly Level[] = ["info", "success", "warning", "error"];

class BadRequest extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(body: Record<string, unknown>, field: string): string {
	const value = body[field];
	if (typeof value !== "string" || value.trim() === "") {
		throw new BadRequest(`"${field}" must be a non-empty string.`);
	}
	return value;
}

function optionalText(
	body: Record<string, unknown>,
	field: string
): string | undefined {
	const value = body[field];
	if (value === undefined) {
		return;
	}
	if (typeof value !== "string") {
		throw new BadRequest(`"${field}" must be a string.`);
	}
	return value;
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		throw new BadRequest("The request body must be JSON.");
	}
	if (!isRecord(body)) {
		throw new BadRequest("The request body must be a JSON object.");
	}
	return body;
}

function parseLevel(body: Record<string, unknown>): Level | undefined {
	const level = optionalText(body, "level");
	if (level === undefined) {
		return;
	}
	const known = LEVELS.find((candidate) => candidate === level);
	if (!known) {
		throw new BadRequest(`"level" must be one of: ${LEVELS.join(", ")}.`);
	}
	return known;
}

function missingVars(error: RyuError): string[] | undefined {
	const details = error.details;
	if (isRecord(details) && Array.isArray(details.missing)) {
		return details.missing.filter(
			(name): name is string => typeof name === "string"
		);
	}
	return;
}

/** The HTTP status this server answers with for a Ryu failure. */
function statusFor(error: RyuError): ContentfulStatusCode {
	if (error.code === "configuration_error") {
		// Our own setup is incomplete: a server error, not the caller's fault.
		return 500;
	}
	if (error.status === 400 || error.status === 422) {
		// Ryu rejected the input the caller gave us.
		return 400;
	}
	if (error.status === 429) {
		return 429;
	}
	// A bad key, a missing scope, or Ryu being unreachable: an upstream failure.
	return 502;
}

/** Turns any thrown value into a JSON error response. */
export function toErrorResponse(c: Context, error: unknown): Response {
	if (error instanceof BadRequest) {
		const body: ErrorBody = { code: "invalid_request", message: error.message };
		return c.json({ error: body }, 400);
	}
	if (!isRyuError(error)) {
		const body: ErrorBody = {
			code: "internal_error",
			message: "Something went wrong.",
		};
		return c.json({ error: body }, 500);
	}
	const body: ErrorBody = {
		code: error.code,
		message: error.message,
		hint: error.hint ?? undefined,
		missing: missingVars(error),
		requestId: error.requestId ?? undefined,
	};
	if (error.retryAfterSeconds !== null) {
		c.header("retry-after", String(error.retryAfterSeconds));
	}
	return c.json({ error: body }, statusFor(error));
}

function notConfigured(c: Context, variable: string): Response {
	const body: ErrorBody = {
		code: "webhook_not_configured",
		message: `Set ${variable} to receive these webhooks.`,
		missing: [variable],
	};
	return c.json({ error: body }, 503);
}

/** Builds the Hono app. `src/index.ts` serves it; tests call `app.request()`. */
export function createApp(options: AppOptions): Hono {
	const ryu = options.ryu ?? new Ryu();
	const { settings } = options;
	const app = new Hono();

	app.get("/", (c) =>
		c.json({
			data: {
				name: "__APP_NAME__",
				routes: [
					"POST /notify",
					"POST /mail",
					"POST /webhooks/mail",
					"POST /webhooks/notify",
				],
			},
		})
	);

	// Notify: needs RYU_NOTIFY_API_KEY. An Idempotency-Key header makes a
	// retried request publish once.
	app.post("/notify", async (c) => {
		const body = await readJson(c);
		const input = {
			title: requiredText(body, "title"),
			body: optionalText(body, "body"),
			level: parseLevel(body),
		};
		const idempotencyKey = c.req.header("idempotency-key");
		const notify = idempotencyKey
			? ryu.notify.with({ idempotencyKey })
			: ryu.notify;
		const event = await notify.publish(input);
		return c.json({ data: { id: event.id } }, 201);
	});

	// Mail: needs RYU_API_KEY, a ryu_ key with the mail:send scope, and
	// MAIL_FROM, the sending inbox's ID.
	app.post("/mail", async (c) => {
		if (!settings.mailFrom) {
			const error: ErrorBody = {
				code: "configuration_error",
				message: "Set MAIL_FROM to the ID of the inbox to send from.",
				missing: ["MAIL_FROM"],
			};
			return c.json({ error }, 500);
		}
		const body = await readJson(c);
		const message = await ryu.mail.send(
			{
				from: settings.mailFrom,
				to: [requiredText(body, "to")],
				subject: requiredText(body, "subject"),
				text: requiredText(body, "text"),
			},
			{ idempotencyKey: c.req.header("idempotency-key") }
		);
		return c.json({ data: { id: message.id } }, 201);
	});

	// Webhooks: the handler reads the raw body, verifies the signature and
	// answers 401 for a forged or stale delivery before your code runs.
	const { mailWebhookSecret, notifyWebhookSecret } = settings;
	const mailWebhook = mailWebhookSecret
		? webhookHandler({
				service: "mail",
				secret: mailWebhookSecret,
				onEvent: (event) => options.onMailEvent?.(event),
			})
		: null;
	const notifyWebhook = notifyWebhookSecret
		? webhookHandler({
				service: "notify",
				secret: notifyWebhookSecret,
				onEvent: (delivery) => options.onNotifyDelivery?.(delivery),
			})
		: null;

	app.post("/webhooks/mail", (c) =>
		mailWebhook
			? mailWebhook(c.req.raw)
			: notConfigured(c, "MAIL_WEBHOOK_SECRET")
	);
	app.post("/webhooks/notify", (c) =>
		notifyWebhook
			? notifyWebhook(c.req.raw)
			: notConfigured(c, "NOTIFY_WEBHOOK_SECRET")
	);

	app.onError((error, c) => toErrorResponse(c, error));

	return app;
}
