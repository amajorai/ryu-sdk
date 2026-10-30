// Executable snippets for apps/fumadocs/content/docs/standalone/sdk/frameworks/nextjs.mdx.
//
// Each `// docs:start <id>` … `// docs:end <id>` region is one code block of
// that page, and apps/fumadocs/src/lib/standalone-sdk-docs.test.ts fails when
// the page's blocks are not byte-identical to the rendered regions, in order.
// Rendering a region:
//
// - a `// docs:show <text>` line becomes `<text>` (a bare `// docs:show` is an
//   empty line). Import lines are shown this way because the published
//   specifiers (`@ryuhq/services`, `@ryuhq/services/webhooks`) do not resolve
//   inside this package; the real imports at the top of this file load the
//   same entry points by relative path;
// - the common indentation is removed and each leading tab becomes two spaces.
//
// Each Next.js module is a namespace, so its `export`s stay real and two
// route files can both export `POST`. The namespaces run against a stub
// `globalThis.fetch` and test env vars, exactly as the page's code would on a
// Next.js server.

// biome-ignore-all lint/style/noNamespace: each namespace stands for one Next.js module file.
// biome-ignore-all lint/suspicious/noExportsInTest: the exports are the documented route handlers and server action.

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
import { mailWebhookSignatureHeaders } from "../../../api/src/lib/mail-webhooks.ts";
import { ENV_VARS, messageWithoutHint, Ryu } from "../../src/index.ts";
import {
	type MailWebhookEvent,
	RyuWebhookVerificationError,
	verifyMailWebhook,
} from "../../src/webhooks/index.ts";

const NOTIFY_URL = "https://notify.example.com";
const NOTIFY_KEY = "test-notify-tenant-key";
const MAIL_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const PUBLISHED = JSON.parse(
	readFileSync(
		resolve(import.meta.dir, "../fixtures/notify/publish-created.json"),
		"utf8"
	)
) as { body: unknown; headers: Record<string, string>; status: number };

interface RecordedRequest {
	body: string;
	headers: Headers;
	method: string;
	url: string;
}

const requests: RecordedRequest[] = [];
let nextResponse: () => Response = () =>
	new Response(JSON.stringify(PUBLISHED.body), {
		status: PUBLISHED.status,
		headers: PUBLISHED.headers,
	});
const realFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};
const TEST_ENV: Record<string, string> = {
	RYU_NOTIFY_URL: NOTIFY_URL,
	RYU_NOTIFY_API_KEY: NOTIFY_KEY,
	MAIL_WEBHOOK_SECRET: MAIL_SECRET,
};

const inbound: MailWebhookEvent[] = [];
/** The app's own code in the docs; here it records what the route handed over. */
function queueInboundMail(event: MailWebhookEvent): Promise<void> {
	inbound.push(event);
	return Promise.resolve();
}

beforeAll(() => {
	for (const [name, value] of Object.entries(TEST_ENV)) {
		savedEnv[name] = process.env[name];
		process.env[name] = value;
	}
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			requests.push({
				body: await request.text(),
				headers: request.headers,
				method: request.method,
				url: request.url,
			});
			return nextResponse();
		},
		{ preconnect: realFetch.preconnect }
	);
});

afterAll(() => {
	globalThis.fetch = realFetch;
	for (const [name, value] of Object.entries(savedEnv)) {
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	}
});

beforeEach(() => {
	requests.length = 0;
	inbound.length = 0;
	nextResponse = () =>
		new Response(JSON.stringify(PUBLISHED.body), {
			status: PUBLISHED.status,
			headers: PUBLISHED.headers,
		});
});

// docs:start nextjs-env
// docs:show # .env.local: read on the server only. Never prefix these with NEXT_PUBLIC_,
// docs:show # which Next.js inlines into the browser bundle.
// docs:show # RYU_NOTIFY_URL defaults to https://notify.ryuhq.com; set it only for another URL.
// docs:show RYU_NOTIFY_API_KEY=<your tenant key>
// docs:show MAIL_WEBHOOK_SECRET=<the whsec_ secret of your Mail webhook>
// docs:end nextjs-env

namespace NotifyRoute {
	// docs:start nextjs-notify-route
	// docs:show import { Ryu } from "@ryuhq/services";
	// docs:show
	// Reads RYU_NOTIFY_API_KEY (and RYU_NOTIFY_URL, when set) from the server environment.
	const ryu = new Ryu({ result: "object" });

	export async function POST(request: Request): Promise<Response> {
		const { build } = (await request.json()) as { build: string };
		const { data, error } = await ryu.notify.publish({
			title: `Deploy ${build} finished`,
			level: "success",
			topic: "deployments",
		});
		if (error) {
			return Response.json(
				{ code: error.code, requestId: error.requestId },
				{ status: 502 }
			);
		}
		return Response.json({ id: data.id }, { status: 201 });
	}
	// docs:end nextjs-notify-route
}

namespace MailWebhookRoute {
	// docs:start nextjs-mail-webhook
	// docs:show import { RyuWebhookVerificationError, verifyMailWebhook } from "@ryuhq/services/webhooks";
	// docs:show
	export async function POST(request: Request): Promise<Response> {
		// Verify the raw body: parsing and re-serializing the JSON breaks the signature.
		const payload = await request.text();
		try {
			const event = await verifyMailWebhook({
				payload,
				headers: request.headers,
				secret: process.env.MAIL_WEBHOOK_SECRET ?? "",
			});
			if (event.event_type === "message.received") {
				// Your own code. Deliveries can repeat, so dedupe on event.event_id.
				await queueInboundMail(event);
			}
			return Response.json({ ok: true });
		} catch (error) {
			if (error instanceof RyuWebhookVerificationError) {
				// 422: signed but not a Mail event, so a retry will not help; 401 otherwise.
				const status = error.code === "webhook_payload_invalid" ? 422 : 401;
				return Response.json({ code: error.code }, { status });
			}
			throw error;
		}
	}
	// docs:end nextjs-mail-webhook
}

namespace ServerAction {
	// docs:start nextjs-server-action
	// docs:show "use server";
	// docs:show
	// docs:show import { messageWithoutHint, Ryu } from "@ryuhq/services";
	// docs:show
	const ryu = new Ryu({ result: "object" });

	export async function notifyTeam(
		formData: FormData
	): Promise<{ ok: boolean; message: string }> {
		const title = String(formData.get("title") ?? "").trim();
		if (title === "") {
			return { ok: false, message: "Enter a title." };
		}
		const { error } = await ryu.notify.publish({ title, level: "info" });
		// error.message ends with a setup hint for you; strip it before a visitor sees it.
		return error
			? { ok: false, message: messageWithoutHint(error) }
			: { ok: true, message: "Sent." };
	}
	// docs:end nextjs-server-action
}

function mailDelivery(
	eventType: string,
	rawBody?: string
): { body: string; headers: Headers } {
	const body =
		rawBody ??
		JSON.stringify({
			type: "event",
			event_type: eventType,
			event_id: "evt_next_1",
			data: { message: { id: "msg_1" }, recipients: ["a@example.com"] },
		});
	const timestamp = String(Math.floor(Date.now() / 1000));
	return {
		body,
		headers: new Headers({
			"content-type": "application/json",
			...mailWebhookSignatureHeaders(
				"standard",
				MAIL_SECRET,
				"evt_next_1",
				timestamp,
				body
			),
		}),
	};
}

describe("Next.js .env.local", () => {
	const SOURCE = readFileSync(import.meta.path, "utf8");
	const region =
		SOURCE.split("// docs:start nextjs-env\n")[1]?.split(
			"// docs:end nextjs-env"
		)[0] ?? "";
	const variables = region
		.split("\n")
		.map((line) => line.replace(/^\/\/ docs:show ?/, ""))
		.filter((line) => /^[A-Z_]+=/.test(line))
		.map((line) => line.slice(0, line.indexOf("=")));

	test("names only SDK variables and the app's own webhook secret", () => {
		const sdkNames = new Set(ENV_VARS.map((row) => row.name));
		// RYU_NOTIFY_URL has a hosted default, so the sample only mentions it.
		expect(variables).toEqual(["RYU_NOTIFY_API_KEY", "MAIL_WEBHOOK_SECRET"]);
		for (const name of variables.filter((n) => n.startsWith("RYU_"))) {
			expect(sdkNames.has(name)).toBe(true);
		}
	});

	test("never uses a NEXT_PUBLIC_ name", () => {
		expect(variables.some((name) => name.startsWith("NEXT_PUBLIC_"))).toBe(
			false
		);
	});
});

describe("Next.js route handler: Notify publish", () => {
	test("publishes with the bearer key, an Idempotency-Key and the request's build", async () => {
		const response = await NotifyRoute.POST(
			new Request("https://app.example.com/api/deploys", {
				method: "POST",
				body: JSON.stringify({ build: "184" }),
			})
		);
		expect(response.status).toBe(201);
		expect(await response.json()).toEqual({
			id: "evt_220eb04632bc4239be622f93ea63a8ec",
		});
		expect(requests).toHaveLength(1);
		const [sent] = requests;
		expect(sent?.method).toBe("POST");
		expect(sent?.url).toBe(`${NOTIFY_URL}/v1/events`);
		expect(sent?.headers.get("authorization")).toBe(`Bearer ${NOTIFY_KEY}`);
		expect(sent?.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
		expect(JSON.parse(sent?.body ?? "{}")).toMatchObject({
			title: "Deploy 184 finished",
			level: "success",
			topic: "deployments",
		});
	});

	test("answers 502 with the Notify code and request id when the call fails", async () => {
		nextResponse = () =>
			Response.json(
				{
					ok: false,
					type: "notify.error",
					code: "unauthorized",
					message: "Unknown tenant key.",
					status: 401,
					requestId: "req_next_401",
					error: {
						code: "unauthorized",
						message: "Unknown tenant key.",
						requestId: "req_next_401",
						status: 401,
					},
				},
				{ status: 401 }
			);
		const response = await NotifyRoute.POST(
			new Request("https://app.example.com/api/deploys", {
				method: "POST",
				body: JSON.stringify({ build: "185" }),
			})
		);
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			code: "unauthorized",
			requestId: "req_next_401",
		});
	});
});

describe("Next.js route handler: Mail webhook", () => {
	test("verifies the raw body and hands a received message to the app", async () => {
		const { body, headers } = mailDelivery("message.received");
		const response = await MailWebhookRoute.POST(
			new Request("https://app.example.com/api/mail-webhook", {
				method: "POST",
				body,
				headers,
			})
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(inbound.map((event) => event.event_id)).toEqual(["evt_next_1"]);
		expect(requests).toHaveLength(0);
	});

	test("acknowledges other event types without queueing them", async () => {
		const { body, headers } = mailDelivery("message.delivered");
		const response = await MailWebhookRoute.POST(
			new Request("https://app.example.com/api/mail-webhook", {
				method: "POST",
				body,
				headers,
			})
		);
		expect(response.status).toBe(200);
		expect(inbound).toHaveLength(0);
	});

	test("answers 401 with the verification code for a tampered body", async () => {
		const { body, headers } = mailDelivery("message.received");
		const response = await MailWebhookRoute.POST(
			new Request("https://app.example.com/api/mail-webhook", {
				method: "POST",
				body: body.replace("msg_1", "msg_2"),
				headers,
			})
		);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({
			code: "webhook_invalid_signature",
		});
		expect(inbound).toHaveLength(0);
	});

	test("answers 422 for a signed body that is not a Mail event", async () => {
		const { body, headers } = mailDelivery("", '{"type":"event"}');
		const response = await MailWebhookRoute.POST(
			new Request("https://app.example.com/api/mail-webhook", {
				method: "POST",
				body,
				headers,
			})
		);
		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({ code: "webhook_payload_invalid" });
		expect(inbound).toHaveLength(0);
	});

	test("the shown imports are the ones the route uses", () => {
		expect(typeof verifyMailWebhook).toBe("function");
		expect(RyuWebhookVerificationError.prototype).toBeInstanceOf(Error);
	});
});

describe("Next.js server action", () => {
	test("publishes the form's title", async () => {
		const form = new FormData();
		form.set("title", "Standup in 5 minutes");
		expect(await ServerAction.notifyTeam(form)).toEqual({
			ok: true,
			message: "Sent.",
		});
		expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
			title: "Standup in 5 minutes",
			level: "info",
		});
	});

	test("refuses an empty title without a request", async () => {
		const form = new FormData();
		form.set("title", "   ");
		expect(await ServerAction.notifyTeam(form)).toEqual({
			ok: false,
			message: "Enter a title.",
		});
		expect(requests).toHaveLength(0);
	});

	test("returns the RyuError message in object mode instead of throwing", async () => {
		nextResponse = () =>
			Response.json(
				{
					ok: false,
					type: "notify.error",
					code: "invalid_request",
					message: "title is too long.",
					status: 400,
					requestId: "req_next_400",
					error: {
						code: "invalid_request",
						message: "title is too long.",
						requestId: "req_next_400",
						status: 400,
					},
				},
				{ status: 400 }
			);
		const form = new FormData();
		form.set("title", "x");
		expect(await ServerAction.notifyTeam(form)).toEqual({
			ok: false,
			message: "title is too long.",
		});
	});
});

describe("Next.js server action hints", () => {
	test("returns the message without the operator hint when the key is refused", async () => {
		nextResponse = () =>
			Response.json(
				{
					ok: false,
					type: "notify.error",
					code: "unauthorized",
					message: "The API key is invalid.",
					status: 401,
					requestId: "req_next_401",
					error: {
						code: "unauthorized",
						message: "The API key is invalid.",
						requestId: "req_next_401",
						status: 401,
					},
				},
				{ status: 401 }
			);
		const form = new FormData();
		form.set("title", "Standup in 5 minutes");
		const result = await ServerAction.notifyTeam(form);
		expect(result.ok).toBe(false);
		expect(result.message).not.toContain("Hint:");
		expect(result.message).not.toContain("RYU_NOTIFY_API_KEY");
		expect(result.message).toBe("The API key is invalid.");
	});
});

describe("Next.js snippets use the real SDK surface", () => {
	test("Ryu is the class the snippets construct", () => {
		expect(new Ryu({ result: "object", env: false }).resultMode).toBe("object");
	});
});
