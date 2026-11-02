import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MailAPI, type MailRealtimeTicket } from "@ryuhq/client";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { jsonErrorNegotiation } from "../../../../apps/server/src/problem-details.ts";
import { resolveServiceConfig } from "../config.ts";
import { createEnvReader } from "../env.ts";
import {
	isRyuError,
	messageWithoutHint,
	RyuAbortError,
	RyuConfigurationError,
	RyuConflictError,
	type RyuError,
	RyuInvalidRequestError,
	RyuNotFoundError,
} from "../errors.ts";
import { Ryu } from "../ryu.ts";
import { shouldRetry } from "../transport/retry.ts";
import {
	inboxCacheFor,
	loadReactEmailRender,
	MAIL_ID_ARGUMENTS,
	MAIL_MESSAGE_CODES,
	mailErrorCode,
	senderAddress,
} from "./helpers.ts";
import { MAIL_DEFAULT_PAGE_SIZE, mailPageSize } from "./iterate.ts";
import {
	createMailNamespace,
	MAIL_CANONICAL_METHODS,
	MAIL_NAMESPACE,
	MAIL_TOP_LEVEL_METHODS,
} from "./namespace.ts";

interface Recorded {
	body: string | null;
	headers: Headers;
	method: string;
	url: string;
}

type Respond = (request: Recorded) => Response | Promise<Response>;

function stubFetch(respond: Respond) {
	const calls: Recorded[] = [];
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const body = init?.body;
		const recorded: Recorded = {
			body: typeof body === "string" ? body : null,
			headers: new Headers(init?.headers),
			method: init?.method ?? "GET",
			url: String(input),
		};
		calls.push(recorded);
		return await respond(recorded);
	};
	return { calls, fetch };
}

const HOSTED_ENV = { RYU_MAIL_GATEWAY_KEY: "rgw_mail_gateway_secret" };
const BASE_URL_ORIGIN = "https://api.ryuhq.com";
const SELF_HOSTED_ENV = {
	RYU_MAIL_API_KEY: "self-hosted-mail-secret",
	RYU_MAIL_URL: "http://127.0.0.1:7996",
};

const INBOX = {
	address: "agent@acme.example",
	agentId: null,
	clientId: null,
	createdAt: "2026-10-01T00:00:00.000Z",
	id: "inbox_1",
	metadata: {},
	name: "Agent",
	podId: null,
	provider: "webhook",
	updatedAt: "2026-10-01T00:00:00.000Z",
};

function message(id: string, createdAt: string) {
	return {
		attachments: [],
		bcc: [],
		cc: [],
		createdAt,
		direction: "outbound",
		id,
		inboxId: "inbox_1",
		labels: [],
		references: [],
		status: "sent",
		subject: "Hi",
		to: ["a@example.com"],
	};
}

function json(body: unknown, init: ResponseInit = {}): Response {
	return Response.json(body, init);
}

/** Routes the stub by method and path; anything else is a 599 so a test fails loudly. */
function mailServer(
	routes: Record<string, (request: Recorded) => Response>
): Respond {
	return (request) => {
		const { pathname } = new URL(request.url);
		const handler = routes[`${request.method} ${pathname}`];
		return handler
			? handler(request)
			: new Response(`unexpected ${request.method} ${pathname}`, {
					status: 599,
				});
	};
}

async function rejection(promise: Promise<unknown>): Promise<RyuError> {
	try {
		await promise;
	} catch (error) {
		if (isRyuError(error)) {
			return error;
		}
		throw error;
	}
	throw new Error("expected the call to reject");
}

describe("auth modes", () => {
	test("hosted mode sends the gateway key as x-gateway-key to api.ryuhq.com and drops Authorization", async () => {
		const { calls, fetch } = stubFetch(() => json({ inboxes: [INBOX] }));
		const ryu = new Ryu({ env: HOSTED_ENV, fetch });
		const inboxes = await ryu.mail.inboxes.list();
		expect(inboxes.map((inbox) => inbox.id)).toEqual(["inbox_1"]);
		const [call] = calls;
		expect(call?.url).toBe("https://api.ryuhq.com/api/mail/inboxes");
		expect(call?.headers.get("x-gateway-key")).toBe("rgw_mail_gateway_secret");
		expect(call?.headers.get("authorization")).toBeNull();
		expect(call?.headers.get("x-api-key")).toBeNull();
		expect(call?.headers.get("accept")).toContain("application/json");
	});

	test("hosted mode never sends RYU_API_KEY", async () => {
		const { calls, fetch } = stubFetch(() => json({ inboxes: [] }));
		const ryu = new Ryu({
			env: { ...HOSTED_ENV, RYU_API_KEY: "ryu_control_plane_secret" },
			fetch,
		});
		await ryu.mail.inboxes.list();
		const sent = [...(calls[0]?.headers.values() ?? [])].join(" ");
		expect(sent).not.toContain("ryu_control_plane_secret");
	});

	test("self-hosted mode sends a Bearer token to RYU_MAIL_URL", async () => {
		const { calls, fetch } = stubFetch(() => json({ inboxes: [] }));
		const ryu = new Ryu({ env: SELF_HOSTED_ENV, fetch });
		await ryu.mail.inboxes.list();
		const [call] = calls;
		expect(call?.url).toBe("http://127.0.0.1:7996/api/mail/inboxes");
		expect(call?.headers.get("authorization")).toBe(
			"Bearer self-hosted-mail-secret"
		);
		expect(call?.headers.get("x-gateway-key")).toBeNull();
	});

	test("self-hosted mode without RYU_MAIL_URL is a configuration error naming it", async () => {
		const { calls, fetch } = stubFetch(() => json({}));
		const ryu = new Ryu({
			env: { RYU_MAIL_API_KEY: "k" },
			fetch,
			result: "object",
		});
		const { error } = await ryu.mail.inboxes.list();
		expect(error).toBeInstanceOf(RyuConfigurationError);
		expect(error?.details).toEqual({ missing: ["RYU_MAIL_URL"] });
		expect(calls).toHaveLength(0);
	});

	test("the signed attachment URL is fetched without any credential", async () => {
		const signed = "https://bucket.s3.example.com/att_1?X-Amz-Signature=abc";
		const { calls, fetch } = stubFetch((request) =>
			request.url.startsWith("https://bucket.s3.example.com/")
				? new Response(new Uint8Array([1, 2, 3]))
				: json({ url: signed })
		);
		const ryu = new Ryu({ env: HOSTED_ENV, fetch });
		const bytes = await ryu.mail.messages.downloadAttachment(
			"inbox_1",
			"msg_1",
			"att_1"
		);
		expect([...bytes]).toEqual([1, 2, 3]);
		expect(calls).toHaveLength(2);
		const [api, s3] = calls;
		expect(api?.headers.get("x-gateway-key")).toBe("rgw_mail_gateway_secret");
		expect(s3?.url).toBe(signed);
		expect(s3?.headers.get("x-gateway-key")).toBeNull();
		expect(s3?.headers.get("authorization")).toBeNull();
	});
});

describe("credential-free status()", () => {
	const STATUS = {
		apiVersion: "v1",
		configured: true,
		domain: "mail.example.com",
		domainMode: "managed",
		inbound: "sns",
		sendConfigured: true,
	};
	const keyHeaders = ["authorization", "x-api-key", "x-gateway-key"];

	test("hosted status() runs without a Mail key on the control plane and sends none", async () => {
		const { calls, fetch } = stubFetch(
			mailServer({ "GET /api/mail/status": () => json(STATUS) })
		);
		const anonymous = new Ryu({ env: {}, fetch });
		const status = await anonymous.mail.status();
		expect(status).toMatchObject({ configured: true, sendConfigured: true });
		expect(calls[0]?.url).toBe("https://api.ryuhq.com/api/mail/status");
		for (const header of [...keyHeaders, "x-ryu-organization"]) {
			expect({ header, sent: calls[0]?.headers.has(header) }).toEqual({
				header,
				sent: false,
			});
		}
		// RYU_API_URL, and a RYU_MAIL_URL on the control-plane origin, apply.
		await new Ryu({
			env: { RYU_API_URL: "https://cp.example.com" },
			fetch,
		}).mail.status();
		expect(calls[1]?.url).toBe("https://cp.example.com/api/mail/status");
		await new Ryu({
			env: {
				RYU_API_URL: "https://cp.example.com",
				RYU_MAIL_URL: "https://cp.example.com",
			},
			fetch,
		}).mail.status();
		expect(calls[2]?.url).toBe("https://cp.example.com/api/mail/status");
		// The organization alone is not a credential and is not sent either.
		await new Ryu({
			env: { RYU_ORGANIZATION_ID: "org_42" },
			fetch,
		}).mail.status();
		expect(calls[3]?.headers.has("x-ryu-organization")).toBe(false);
		expect((await anonymous.safe.mail.status()).error).toBeNull();
		expect(anonymous.isConfigured("mail")).toBe(false);
		expect(anonymous.canCallWithoutCredentials("mail")).toBe(true);
	});

	test("configured clients keep sending their key", async () => {
		const { calls, fetch } = stubFetch(
			mailServer({ "GET /api/mail/status": () => json(STATUS) })
		);
		await new Ryu({ env: HOSTED_ENV, fetch }).mail.status();
		expect(calls[0]?.headers.get("x-gateway-key")).toBe(
			HOSTED_ENV.RYU_MAIL_GATEWAY_KEY
		);
		await new Ryu({ env: SELF_HOSTED_ENV, fetch }).mail.status();
		expect(calls[1]?.url).toBe("http://127.0.0.1:7996/api/mail/status");
		expect(calls[1]?.headers.get("authorization")).toBe(
			`Bearer ${SELF_HOSTED_ENV.RYU_MAIL_API_KEY}`
		);
	});

	test("a control-plane RYU_MAIL_URL without a key asks for a hosted key, not the self-hosted bearer", async () => {
		const { calls, fetch } = stubFetch(() => json(STATUS));
		const hosted = new Ryu({
			env: { RYU_MAIL_URL: "https://api.ryuhq.com" },
			fetch,
		});
		const error = await rejection(hosted.mail.inboxes.list());
		expect(error).toBeInstanceOf(RyuConfigurationError);
		expect(error.details).toEqual({
			missing: ["RYU_API_KEY", "RYU_MAIL_GATEWAY_KEY"],
		});
		expect(error.message).toContain("Hosted Ryu Mail needs a key");
		expect(error.hint).not.toContain("RYU_MAIL_API_KEY");
		expect(hosted.isConfigured("mail")).toBe(false);
		// status() stays credential-free on the control-plane origin.
		expect(hosted.canCallWithoutCredentials("mail")).toBe(true);
		await hosted.mail.status();
		expect(calls).toHaveLength(1);
	});

	test("a self-hosted URL without its token still needs it, and no other method is credential-free", async () => {
		const { calls, fetch } = stubFetch(() => json(STATUS));
		const selfHosted = new Ryu({
			env: { RYU_MAIL_URL: SELF_HOSTED_ENV.RYU_MAIL_URL },
			fetch,
		});
		const error = await rejection(selfHosted.mail.status());
		expect(error).toBeInstanceOf(RyuConfigurationError);
		expect(error.details).toEqual({ missing: ["RYU_MAIL_API_KEY"] });
		expect(selfHosted.canCallWithoutCredentials("mail")).toBe(false);
		// A ryu_ key is never sent to a self-hosted URL, also not by status().
		const keyed = new Ryu({
			env: {
				RYU_API_KEY: "ryu_never_sent",
				RYU_MAIL_URL: SELF_HOSTED_ENV.RYU_MAIL_URL,
			},
			fetch,
		});
		expect(await rejection(keyed.mail.status())).toBeInstanceOf(
			RyuConfigurationError
		);
		const anonymous = new Ryu({ env: {}, fetch });
		for (const call of [
			() => anonymous.mail.inboxes.list(),
			() => anonymous.mail.messages.get("m1"),
			() => anonymous.mail.listInboxes(),
		]) {
			expect(await rejection(call())).toBeInstanceOf(RyuConfigurationError);
		}
		const badUrl = new Ryu({ env: { RYU_API_URL: "not a url" }, fetch });
		expect(await rejection(badUrl.mail.status())).toBeInstanceOf(
			RyuConfigurationError
		);
		expect(badUrl.canCallWithoutCredentials("mail")).toBe(false);
		expect(calls).toHaveLength(0);
	});

	test("canCallWithoutCredentials is true only for services with credential-free methods", () => {
		const ryu = new Ryu({ env: {} });
		expect(ryu.canCallWithoutCredentials("messaging")).toBe(true);
		expect(ryu.canCallWithoutCredentials("mail")).toBe(true);
		for (const service of [
			"managedAgents",
			"notify",
			"box",
			"gateway",
			"connect",
			"passport",
			"sites",
		] as const) {
			expect({ service, free: ryu.canCallWithoutCredentials(service) }).toEqual(
				{ service, free: false }
			);
		}
	});
});

describe("auth mode: hosted Mail on a ryu_ key", () => {
	const KEY_ENV = {
		RYU_API_KEY: "ryu_mail_scoped_secret",
		RYU_ORGANIZATION_ID: "org_42",
	};

	test("sends RYU_API_KEY as x-api-key with X-Ryu-Organization to api.ryuhq.com", async () => {
		const { calls, fetch } = stubFetch(() => json({ inboxes: [INBOX] }));
		const ryu = new Ryu({ env: KEY_ENV, fetch });
		await ryu.mail.inboxes.list();
		const [call] = calls;
		expect(call?.url).toBe("https://api.ryuhq.com/api/mail/inboxes");
		expect(call?.headers.get("x-api-key")).toBe("ryu_mail_scoped_secret");
		expect(call?.headers.get("x-ryu-organization")).toBe("org_42");
		expect(call?.headers.get("authorization")).toBeNull();
		expect(call?.headers.get("x-gateway-key")).toBeNull();
	});

	test("mail.send works from the apiKey option alone; no organization header without one", async () => {
		const { calls, fetch } = stubFetch(
			mailServer({
				"POST /api/mail/inboxes/inbox_1/send": () =>
					json({ id: "msg_1", status: "sent" }),
			})
		);
		const ryu = new Ryu({ apiKey: "ryu_opt", env: false, fetch });
		await ryu.mail.send({
			from: "inbox_1",
			to: ["person@example.com"],
			subject: "Hi",
			text: "Hello",
		});
		const [call] = calls;
		expect(call?.headers.get("x-api-key")).toBe("ryu_opt");
		expect(call?.headers.get("x-ryu-organization")).toBeNull();
		expect(call?.headers.get("idempotency-key")).toBeTruthy();
	});

	test("a node gateway key wins over RYU_API_KEY", async () => {
		const { calls, fetch } = stubFetch(() => json({ inboxes: [] }));
		const ryu = new Ryu({ env: { ...KEY_ENV, ...HOSTED_ENV }, fetch });
		await ryu.mail.inboxes.list();
		const sent = [...(calls[0]?.headers.values() ?? [])].join(" ");
		expect(calls[0]?.headers.get("x-gateway-key")).toBe(
			"rgw_mail_gateway_secret"
		);
		expect(sent).not.toContain("ryu_mail_scoped_secret");
		expect(calls[0]?.headers.get("x-ryu-organization")).toBeNull();
	});

	test("an apiKey option wins over an env gateway key", async () => {
		const { calls, fetch } = stubFetch(() => json({ inboxes: [] }));
		const ryu = new Ryu({ apiKey: "ryu_opt", env: HOSTED_ENV, fetch });
		await ryu.mail.inboxes.list();
		expect(calls[0]?.headers.get("x-api-key")).toBe("ryu_opt");
		expect(calls[0]?.headers.get("x-gateway-key")).toBeNull();
	});

	test("connectRealtime throws realtime_unavailable and never puts the key in a socket URL", async () => {
		const opened: string[] = [];
		const original = globalThis.WebSocket;
		globalThis.WebSocket = class {
			constructor(url: string) {
				opened.push(url);
			}
		} as unknown as typeof WebSocket;
		try {
			const { calls, fetch } = stubFetch(() => json({}));
			const ryu = new Ryu({ env: KEY_ENV, fetch });
			let caught: unknown;
			try {
				await ryu.mail.connectRealtime(() => undefined);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(RyuConfigurationError);
			expect((caught as RyuError).code).toBe("realtime_unavailable");
			expect(JSON.stringify(caught)).not.toContain("ryu_mail_scoped_secret");
			expect(opened).toEqual([]);
			expect(calls).toEqual([]);
		} finally {
			globalThis.WebSocket = original;
		}
	});

	test("connectRealtime with a node gateway key (hosted) throws realtime_unavailable and opens no socket", async () => {
		const opened: string[] = [];
		const original = globalThis.WebSocket;
		globalThis.WebSocket = class {
			constructor(url: string) {
				opened.push(url);
			}
		} as unknown as typeof WebSocket;
		try {
			const { calls, fetch } = stubFetch(() => json({}));
			const ryu = new Ryu({ env: HOSTED_ENV, fetch });
			let caught: unknown;
			try {
				await ryu.mail.connectRealtime(() => undefined);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(RyuConfigurationError);
			expect((caught as RyuError).code).toBe("realtime_unavailable");
			expect((caught as RyuError).message).toContain("hosted Mail");
			expect(JSON.stringify(caught)).not.toContain(
				HOSTED_ENV.RYU_MAIL_GATEWAY_KEY
			);
			expect(opened).toEqual([]);
			expect(calls).toEqual([]);
		} finally {
			globalThis.WebSocket = original;
		}
	});

	test("connectRealtimeWithTicket mints a ticket with the hosted key and offers it as a subprotocol", async () => {
		const ticket = "mrt_2r7Yf0kQ6bWm9pXcJ3hT1sLeAa8uVnZg4oDiRyKqE5w";
		const original = globalThis.WebSocket;
		try {
			for (const env of [KEY_ENV, HOSTED_ENV]) {
				const opened: { protocols: unknown; url: string }[] = [];
				globalThis.WebSocket = class {
					constructor(url: string, protocols?: string[]) {
						opened.push({ protocols, url });
					}
					addEventListener(): void {
						// Only the handshake arguments are inspected.
					}
				} as unknown as typeof WebSocket;
				const { calls, fetch } = stubFetch(
					mailServer({
						"POST /api/mail/realtime/tickets": () =>
							json({
								ticket,
								expiresAt: "2026-10-23T12:00:30.000Z",
								expiresIn: 30,
								path: "/api/mail/realtime",
								protocols: ["ryu-mail.v1", `ryu-ticket.${ticket}`],
							}),
					})
				);
				const ryu = new Ryu({ env, fetch });
				await ryu.mail.connectRealtimeWithTicket(() => undefined, {
					eventTypes: ["message.received"],
				});
				expect(calls).toHaveLength(1);
				if (env === KEY_ENV) {
					expect(calls[0]?.headers.get("x-api-key")).toBe(KEY_ENV.RYU_API_KEY);
					expect(calls[0]?.headers.get("x-ryu-organization")).toBe("org_42");
				} else {
					expect(calls[0]?.headers.get("x-gateway-key")).toBe(
						HOSTED_ENV.RYU_MAIL_GATEWAY_KEY
					);
				}
				expect(opened).toEqual([
					{
						protocols: ["ryu-mail.v1", `ryu-ticket.${ticket}`],
						url: "wss://api.ryuhq.com/api/mail/realtime",
					},
				]);
				expect(JSON.stringify(opened)).not.toContain("secret");
			}
		} finally {
			globalThis.WebSocket = original;
		}
	});

	test("connectRealtimeWithTicket refuses before minting when the runtime has no WebSocket", async () => {
		const original = globalThis.WebSocket;
		const { calls, fetch } = stubFetch(() => json({}));
		const ryu = new Ryu({ env: KEY_ENV, fetch });
		Reflect.deleteProperty(globalThis, "WebSocket");
		try {
			let caught: unknown;
			try {
				await ryu.mail.connectRealtimeWithTicket(() => undefined);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(RyuConfigurationError);
			expect((caught as RyuError).code).toBe("realtime_websocket_unavailable");
			expect(calls).toEqual([]);
		} finally {
			globalThis.WebSocket = original;
		}
	});

	test("createRealtimeTicket returns the socket url, like the Python SDK", async () => {
		const ticket = "mrt_2r7Yf0kQ6bWm9pXcJ3hT1sLeAa8uVnZg4oDiRyKqE5w";
		const { fetch } = stubFetch(
			mailServer({
				"POST /api/mail/realtime/tickets": () =>
					json({
						ticket,
						expiresAt: "2026-10-23T12:00:30.000Z",
						expiresIn: 30,
						path: "/api/mail/realtime",
						protocols: ["ryu-mail.v1", `ryu-ticket.${ticket}`],
					}),
			})
		);
		const minted: MailRealtimeTicket = await new Ryu({
			env: KEY_ENV,
			fetch,
		}).mail.createRealtimeTicket();
		expect(minted.url).toBe("wss://api.ryuhq.com/api/mail/realtime");
		expect(Object.keys(minted).sort()).toEqual([
			"expiresAt",
			"expiresIn",
			"path",
			"protocols",
			"ticket",
			"url",
		]);
	});

	test("the hosted connectRealtime refusal points at connectRealtimeWithTicket", async () => {
		const ryu = new Ryu({
			env: KEY_ENV,
			fetch: stubFetch(() => json({})).fetch,
		});
		let caught: unknown;
		try {
			await ryu.mail.connectRealtime(() => undefined);
		} catch (error) {
			caught = error;
		}
		expect((caught as RyuError).message).toContain("connectRealtimeWithTicket");
	});

	test("self-hosted Mail refuses the ticket methods without a request", async () => {
		const { calls, fetch } = stubFetch(() => json({}));
		const ryu = new Ryu({ env: SELF_HOSTED_ENV, fetch });
		for (const call of [
			() => ryu.mail.createRealtimeTicket(),
			() => ryu.mail.connectRealtimeWithTicket(() => undefined),
		]) {
			let caught: unknown;
			try {
				await call();
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(RyuConfigurationError);
			expect((caught as RyuError).code).toBe("realtime_ticket_unavailable");
		}
		expect(calls).toEqual([]);
	});

	test("an address as from reads the inbox list first (mail:read); an inbox id sends with one request", async () => {
		const { calls, fetch } = stubFetch(
			mailServer({
				"GET /api/mail/inboxes": () => json({ inboxes: [INBOX] }),
				[`POST /api/mail/inboxes/${INBOX.id}/send`]: () =>
					json({ id: "msg_1", status: "sent" }),
			})
		);
		const ryu = new Ryu({ env: KEY_ENV, fetch });
		const input = { to: ["person@example.com"], subject: "Hi", text: "Hello" };
		await ryu.mail.send({ ...input, from: INBOX.id });
		expect(calls.map((call) => call.method)).toEqual(["POST"]);
		await ryu.mail.send({ ...input, from: INBOX.address });
		expect(
			calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)
		).toEqual([
			`POST /api/mail/inboxes/${INBOX.id}/send`,
			"GET /api/mail/inboxes",
			`POST /api/mail/inboxes/${INBOX.id}/send`,
		]);
	});

	test("never sends the ryu_ key or organization to a self-hosted Mail URL", async () => {
		const { calls, fetch } = stubFetch(() => json({ inboxes: [] }));
		const ryu = new Ryu({ env: { ...KEY_ENV, ...SELF_HOSTED_ENV }, fetch });
		await ryu.mail.inboxes.list();
		const sent = [...(calls[0]?.headers.entries() ?? [])].join(" ");
		expect(calls[0]?.headers.get("authorization")).toBe(
			"Bearer self-hosted-mail-secret"
		);
		expect(sent).not.toContain("ryu_mail_scoped_secret");
		expect(calls[0]?.headers.get("x-ryu-organization")).toBeNull();
	});

	test("the signed attachment URL gets neither the key nor the organization", async () => {
		const signed = "https://bucket.s3.example.com/att_1?X-Amz-Signature=abc";
		const { calls, fetch } = stubFetch((request) =>
			request.url.startsWith("https://bucket.s3.example.com/")
				? new Response(new Uint8Array([1]))
				: json({ url: signed })
		);
		const ryu = new Ryu({ env: KEY_ENV, fetch });
		await ryu.mail.messages.downloadAttachment("inbox_1", "msg_1", "att_1");
		const [api, s3] = calls;
		expect(api?.headers.get("x-ryu-organization")).toBe("org_42");
		expect(s3?.headers.get("x-api-key")).toBeNull();
		expect(s3?.headers.get("x-ryu-organization")).toBeNull();
	});

	test("a missing Mail scope is a RyuPermissionError with insufficient_scope and a scope hint", async () => {
		const { fetch } = stubFetch(() =>
			json(
				{
					error: "This API key does not have the mail:send scope.",
					code: "insufficient_scope",
					requiredScope: "mail:send",
				},
				{ status: 403 }
			)
		);
		const ryu = new Ryu({ env: KEY_ENV, fetch, result: "object" });
		const { error } = await ryu.mail.inboxes.list();
		expect(error?.code).toBe("insufficient_scope");
		expect(error?.status).toBe(403);
		expect(error?.hint).toContain("check its scopes");
		expect(error?.hint).toContain("RYU_API_KEY");
	});
});

describe("errors", () => {
	test("a text/plain HTTPException negotiated to problem+json maps to a typed code", async () => {
		const app = new Hono();
		app.use("/api/*", jsonErrorNegotiation());
		app.get("/api/mail/inboxes/:id", () => {
			throw new HTTPException(404, { message: "inbox not found" });
		});
		const { calls, fetch } = stubFetch((request) =>
			app.fetch(
				new Request(request.url, {
					headers: request.headers,
					method: request.method,
				})
			)
		);
		const ryu = new Ryu({ env: HOSTED_ENV, fetch });
		const error = await rejection(ryu.mail.inboxes.get("inbox_missing"));
		expect(error).toBeInstanceOf(RyuNotFoundError);
		expect(error.code).toBe("not_found");
		expect(error.envelope).toBe("problem+json");
		expect(messageWithoutHint(error)).toBe("inbox not found");
		expect(error.service).toBe("mail");
		expect(calls).toHaveLength(1);
	});

	test("{error, code} bodies keep their code; {message} bodies use the status default", async () => {
		const { fetch } = stubFetch(
			mailServer({
				"POST /api/mail/inboxes": () =>
					json(
						{ error: "address already in use", code: "address_taken" },
						{ status: 409 }
					),
				"PATCH /api/mail/inboxes/inbox_1": () =>
					json({ message: "request body too large" }, { status: 413 }),
			})
		);
		const ryu = new Ryu({ env: SELF_HOSTED_ENV, fetch, result: "object" });
		const taken = await ryu.mail.inboxes.create({
			name: "A",
			address: "a@acme.example",
		});
		expect(taken.error).toBeInstanceOf(RyuConflictError);
		expect(taken.error?.code).toBe("address_taken");
		expect(taken.error?.message).toBe("address already in use");
		expect(taken.error?.envelope).toBe("code-error");

		const large = await ryu.mail.inboxes.update("inbox_1", { name: "B" });
		expect(large.error).toBeInstanceOf(RyuInvalidRequestError);
		expect(large.error?.code).toBe("payload_too_large");
		expect(large.error?.message).toBe("request body too large");
		expect(large.error?.envelope).toBe("error-message");
	});

	test("mailErrorCode names the send conflicts Mail reports only as prose", () => {
		expect(
			mailErrorCode(
				409,
				"a request with this Idempotency-Key is still in progress; retry shortly"
			)
		).toBe("idempotency_in_progress");
		expect(
			mailErrorCode(
				502,
				" the mail provider did not confirm this send, so it may have been sent; check this inbox's sent messages before sending it again "
			)
		).toBe("outcome_unknown");
		expect(
			mailErrorCode(
				409,
				"idempotency key was reused with a different inbox or request"
			)
		).toBe("idempotency_key_reused");
		expect(
			mailErrorCode(
				500,
				"Mail transport acknowledged the message but its replay record could not be saved; reconcile this request before retrying"
			)
		).toBe("outcome_unknown");
		// The status must match too, and unknown prose has no code.
		expect(
			mailErrorCode(
				500,
				"a request with this Idempotency-Key is still in progress; retry shortly"
			)
		).toBeNull();
		expect(mailErrorCode(409, "inbox is disabled")).toBeNull();
		const codes = new Set(MAIL_MESSAGE_CODES.map((entry) => entry.code));
		expect([...codes].sort()).toEqual([
			"idempotency_in_progress",
			"idempotency_key_reused",
			"outcome_unknown",
		]);
	});
});

const IN_PROGRESS =
	"a request with this Idempotency-Key is still in progress; retry shortly";
const HOSTED_OUTCOME_UNKNOWN =
	"the mail provider did not confirm this send, so it may have been sent; check this inbox's sent messages before sending it again";
const SELF_HOSTED_UNRESOLVED =
	"mail send outcome is unresolved; reconcile this request before sending again";
const SELF_HOSTED_REPLAY_NOT_SAVED =
	"Mail transport acknowledged the message but its replay record could not be saved; reconcile this request before retrying";
const SEND_INPUT = { subject: "Hi", text: "Hello", to: ["a@example.com"] };

/** A hosted Mail stand-in: Hono with the API host's problem+json negotiation. */
function hostedMail(
	register: (app: Hono) => void
): ReturnType<typeof stubFetch> {
	const app = new Hono();
	app.use("/api/*", jsonErrorNegotiation());
	register(app);
	return stubFetch((request) =>
		app.fetch(
			new Request(request.url, {
				body: request.body,
				headers: request.headers,
				method: request.method,
			})
		)
	);
}

describe("send-ledger errors on the wire", () => {
	test("a self-hosted 400 'email transport is not configured' carries an SMTP hint and docs", async () => {
		const { fetch } = stubFetch(
			mailServer({
				"POST /api/mail/inboxes/inbox_1/send": () =>
					json({ error: "email transport is not configured" }, { status: 400 }),
			})
		);
		const ryu = new Ryu({ env: SELF_HOSTED_ENV, fetch, result: "object" });
		const { error } = await ryu.mail.messages.send("inbox_1", SEND_INPUT);
		expect(error?.status).toBe(400);
		expect(error?.message).toBe(
			`email transport is not configured. Hint: ${error?.hint}`
		);
		expect(error?.hint).toContain("RYU_SMTP_HOST");
		expect(error?.hint).toContain("sendConfigured");
		expect(error?.docs).toBe(
			"https://docs.ryuhq.com/docs/standalone/mail#start-the-standalone-service"
		);
	});

	test("hosted in-progress 409 (HTTPException -> problem+json) is idempotency_in_progress", async () => {
		const { calls, fetch } = hostedMail((app) => {
			app.post("/api/mail/inboxes/:id/send", () => {
				throw new HTTPException(409, { message: IN_PROGRESS });
			});
		});
		const ryu = new Ryu({
			env: HOSTED_ENV,
			fetch,
			maxRetries: 0,
			result: "object",
		});
		const { error } = await ryu.mail
			.with({ idempotencyKey: "welcome-42" })
			.messages.send("inbox_1", SEND_INPUT);
		expect(error).toBeInstanceOf(RyuConflictError);
		expect(error?.envelope).toBe("problem+json");
		expect(error?.code).toBe("idempotency_in_progress");
		expect(error?.retryable).toBe(true);
		expect(error?.message).toBe(IN_PROGRESS);
		expect(error?.idempotencyKey).toBe("welcome-42");
		expect(
			new Set(calls.map((call) => call.headers.get("idempotency-key")))
		).toEqual(new Set(["welcome-42"]));
	});

	test("hosted keyed-send 502 {error, reason} is outcome_unknown and not retryable", async () => {
		const { calls, fetch } = stubFetch(
			mailServer({
				"POST /api/mail/inboxes/inbox_1/send": () =>
					json(
						{ error: HOSTED_OUTCOME_UNKNOWN, reason: "provider_timeout" },
						{ status: 502 }
					),
			})
		);
		const ryu = new Ryu({ env: HOSTED_ENV, fetch, result: "object" });
		const { error } = await ryu.mail.messages.send("inbox_1", SEND_INPUT);
		expect(error?.status).toBe(502);
		expect(error?.code).toBe("outcome_unknown");
		expect(error?.retryable).toBe(false);
		expect(error?.message).toBe(HOSTED_OUTCOME_UNKNOWN);
		expect(calls).toHaveLength(1);
	});

	test("a hosted in-progress 409 is retried with the same key until it succeeds", async () => {
		let tries = 0;
		const { calls, fetch } = hostedMail((app) => {
			app.post("/api/mail/inboxes/:id/send", (c) => {
				tries += 1;
				if (tries === 1) {
					throw new HTTPException(409, { message: IN_PROGRESS });
				}
				return c.json(message("msg_1", "2026-10-01T00:00:00.000Z"));
			});
		});
		const ryu = new Ryu({ env: HOSTED_ENV, fetch, result: "object" });
		const { data, error, meta } = await ryu.mail
			.with({ idempotencyKey: "welcome-42" })
			.messages.send("inbox_1", SEND_INPUT);
		expect(error).toBeNull();
		expect(data?.id).toBe("msg_1");
		expect(meta?.attempts).toBe(2);
		expect(calls.map((call) => call.headers.get("idempotency-key"))).toEqual([
			"welcome-42",
			"welcome-42",
		]);
	});

	test("hosted MailSendOutcomeUnknownError (HTTPException 502) is outcome_unknown", async () => {
		const { fetch } = hostedMail((app) => {
			app.post("/api/mail/inboxes/:id/messages/:messageId/reply", () => {
				throw new HTTPException(502, { message: HOSTED_OUTCOME_UNKNOWN });
			});
		});
		const ryu = new Ryu({ env: HOSTED_ENV, fetch, result: "object" });
		const { error } = await ryu.mail.messages.reply("inbox_1", "msg_1", {
			text: "Thanks",
		});
		expect(error?.envelope).toBe("problem+json");
		expect(error?.code).toBe("outcome_unknown");
		expect(error?.retryable).toBe(false);
	});

	test("self-hosted {error} conflicts and the replay-not-saved 500 get their codes", async () => {
		const { calls, fetch } = stubFetch(
			mailServer({
				"POST /api/mail/inboxes/inbox_1/send": () =>
					json(
						{
							error:
								"idempotency key was reused with a different inbox or request",
						},
						{ status: 409 }
					),
				"POST /api/mail/inboxes/inbox_2/send": () =>
					json({ error: SELF_HOSTED_UNRESOLVED }, { status: 409 }),
				"POST /api/mail/inboxes/inbox_3/send": () =>
					json({ error: SELF_HOSTED_REPLAY_NOT_SAVED }, { status: 500 }),
			})
		);
		const ryu = new Ryu({ env: SELF_HOSTED_ENV, fetch, result: "object" });
		const reused = await ryu.mail.messages.send("inbox_1", SEND_INPUT);
		expect(reused.error).toBeInstanceOf(RyuConflictError);
		expect(reused.error?.code).toBe("idempotency_key_reused");
		expect(reused.error?.retryable).toBe(false);
		const unresolved = await ryu.mail.messages.send("inbox_2", SEND_INPUT);
		expect(unresolved.error?.code).toBe("outcome_unknown");
		expect(unresolved.error?.retryable).toBe(false);
		const notSaved = await ryu.mail.messages.send("inbox_3", SEND_INPUT);
		expect(notSaved.error?.status).toBe(500);
		expect(notSaved.error?.code).toBe("outcome_unknown");
		expect(notSaved.error?.retryable).toBe(false);
		expect(calls).toHaveLength(3);
	});

	test("a self-hosted 502 outcome-unknown send is never retried", async () => {
		const { calls, fetch } = stubFetch(
			mailServer({
				"POST /api/mail/inboxes/inbox_1/send": () =>
					json({ error: HOSTED_OUTCOME_UNKNOWN }, { status: 502 }),
			})
		);
		const ryu = new Ryu({ env: SELF_HOSTED_ENV, fetch, result: "object" });
		const { error } = await ryu.mail.messages.send("inbox_1", SEND_INPUT);
		expect(error?.code).toBe("outcome_unknown");
		expect(calls).toHaveLength(1);
	});

	test("other errors keep the code the transport gave them", async () => {
		const { fetch } = stubFetch(
			mailServer({
				"POST /api/mail/inboxes/inbox_1/send": () =>
					json({ error: "inbox is disabled" }, { status: 409 }),
			})
		);
		const ryu = new Ryu({ env: SELF_HOSTED_ENV, fetch, result: "object" });
		const { error } = await ryu.mail.messages.send("inbox_1", SEND_INPUT);
		expect(error?.code).toBe("conflict");
		expect(error?.retryable).toBe(false);
	});

	test("with the refined code, the transport retries in-progress and never outcome_unknown", () => {
		expect(MAIL_NAMESPACE.refineErrorCode).toBe(mailErrorCode);
		const decide = (status: number, message: string) =>
			shouldRetry({
				bodyRetryAfterSeconds: null,
				code: mailErrorCode(status, message),
				rateLimitRemaining: null,
				rateLimitResetSeconds: null,
				replayableBody: true,
				replaySafe: true,
				retryAfterSeconds: null,
				status,
			});
		expect(decide(409, IN_PROGRESS)).toBe(true);
		expect(decide(502, HOSTED_OUTCOME_UNKNOWN)).toBe(false);
		expect(decide(500, SELF_HOSTED_REPLAY_NOT_SAVED)).toBe(false);
		expect(decide(409, SELF_HOSTED_UNRESOLVED)).toBe(false);
	});
});

describe("idempotency", () => {
	/**
	 * Answers every POST with a replay-safe 503 once, then `ok`; the transport
	 * retries a keyed route write, so the key must be the same on both tries.
	 */
	function unavailableThenOk() {
		const seen = new Set<string>();
		return stubFetch((request) => {
			const { pathname } = new URL(request.url);
			if (request.method !== "POST") {
				return new Response(`unexpected ${request.method}`, { status: 599 });
			}
			if (!seen.has(pathname)) {
				seen.add(pathname);
				return json(
					{ error: "upstream unavailable" },
					{ status: 503, headers: { "Retry-After": "0" } }
				);
			}
			return json(message("msg_1", "2026-10-01T00:00:00.000Z"));
		});
	}

	function keys(calls: readonly Recorded[]): (string | null)[] {
		return calls.map((call) => call.headers.get("idempotency-key"));
	}

	test("the caller's key is reused across a replay-safe retry", async () => {
		const { calls, fetch } = unavailableThenOk();
		const ryu = new Ryu({ env: HOSTED_ENV, fetch, result: "object" });
		const { data, error, meta } = await ryu.mail
			.with({ idempotencyKey: "welcome-42" })
			.messages.send("inbox_1", SEND_INPUT);
		expect(error).toBeNull();
		expect(data?.id).toBe("msg_1");
		expect(keys(calls)).toEqual(["welcome-42", "welcome-42"]);
		expect(meta?.attempts).toBe(2);
		expect(meta?.idempotencyKey).toBe("welcome-42");
	});

	test("an automatic key is generated once and reused on the retry", async () => {
		const { calls, fetch } = unavailableThenOk();
		const ryu = new Ryu({ env: HOSTED_ENV, fetch });
		await ryu.mail.send({ from: "inbox_1", ...SEND_INPUT });
		const sent = keys(calls);
		expect(sent).toHaveLength(2);
		expect(sent[0]).toMatch(/^[A-Za-z0-9_-]{16,128}$/u);
		expect(sent[1]).toBe(sent[0] ?? "");
	});

	test("send's trailing idempotencyKey reaches the wire", async () => {
		const { calls, fetch } = unavailableThenOk();
		const ryu = new Ryu({ env: HOSTED_ENV, fetch });
		await ryu.mail.send(
			{ from: "inbox_1", subject: "Hi", text: "x", to: ["a@example.com"] },
			{ idempotencyKey: "trailing-key-0001", headers: { "x-trace": "t1" } }
		);
		expect(keys(calls)).toEqual(["trailing-key-0001", "trailing-key-0001"]);
		expect(calls[0]?.headers.get("x-trace")).toBe("t1");
	});

	test("reply, replyAll, forward and sendDraft carry a key and reuse it on the retry", async () => {
		const { calls, fetch } = unavailableThenOk();
		const ryu = new Ryu({ env: SELF_HOSTED_ENV, fetch });
		await ryu.mail
			.with({ idempotencyKey: "reply-key-0001" })
			.messages.reply("inbox_1", "msg_1", { text: "Thanks" });
		await ryu.mail.messages.replyAll("inbox_1", "msg_1", {
			text: "Thanks all",
		});
		await ryu.mail.messages.forward("inbox_1", "msg_1", {
			subject: "Fwd",
			to: ["b@example.com"],
		});
		await ryu.mail.drafts.send("inbox_1", "draft_1");
		const byPath = new Map<string, (string | null)[]>();
		for (const call of calls) {
			const { pathname } = new URL(call.url);
			byPath.set(pathname, [
				...(byPath.get(pathname) ?? []),
				call.headers.get("idempotency-key"),
			]);
		}
		expect([...byPath.keys()]).toEqual([
			"/api/mail/inboxes/inbox_1/messages/msg_1/reply",
			"/api/mail/inboxes/inbox_1/messages/msg_1/reply-all",
			"/api/mail/inboxes/inbox_1/messages/msg_1/forward",
			"/api/mail/inboxes/inbox_1/drafts/draft_1/send",
		]);
		expect(
			byPath.get("/api/mail/inboxes/inbox_1/messages/msg_1/reply")
		).toEqual(["reply-key-0001", "reply-key-0001"]);
		for (const [path, sent] of byPath) {
			expect({ path, count: sent.length }).toEqual({ path, count: 2 });
			expect(sent[0]).toBeString();
			expect(sent[1]).toBe(sent[0] ?? "");
		}
	});

	test("reads and non-route writes get no key", async () => {
		const { calls, fetch } = stubFetch(
			mailServer({
				"GET /api/mail/inboxes": () => json({ inboxes: [] }),
				"POST /api/mail/inboxes": () => json(INBOX),
			})
		);
		const ryu = new Ryu({ env: HOSTED_ENV, fetch });
		await ryu.mail.inboxes.list();
		await ryu.mail.inboxes.create({ name: "A", address: "a@acme.example" });
		expect(keys(calls)).toEqual([null, null]);
	});

	test("a hosted create can name a localPart and leave out the address", async () => {
		const { calls, fetch } = stubFetch(
			mailServer({ "POST /api/mail/inboxes": () => json(INBOX) })
		);
		const ryu = new Ryu({ env: HOSTED_ENV, fetch });
		await ryu.mail.inboxes.create({ localPart: "support", name: "Support" });
		expect(JSON.parse(String(calls[0]?.body))).toEqual({
			localPart: "support",
			name: "Support",
		});
	});
});

describe("mail.send", () => {
	function sendServer() {
		return stubFetch(
			mailServer({
				"GET /api/mail/inboxes": () =>
					json({
						inboxes: [
							INBOX,
							{ ...INBOX, id: "inbox_2", address: "b@acme.example" },
						],
					}),
				"POST /api/mail/inboxes/inbox_1/send": () =>
					json(message("msg_1", "2026-10-01T00:00:00.000Z")),
				"POST /api/mail/inboxes/inbox_2/send": () =>
					json(message("msg_2", "2026-10-01T00:00:00.000Z")),
			})
		);
	}

	test("resolves an address once and caches it for the Ryu instance", async () => {
		const { calls, fetch } = sendServer();
		const ryu = new Ryu({ env: HOSTED_ENV, fetch });
		const first = await ryu.mail.send({
			from: "Agent <Agent@Acme.Example>",
			html: "<p>Hi</p>",
			subject: "Hi",
			to: ["a@example.com"],
		});
		expect(first.id).toBe("msg_1");
		await ryu.mail.send({
			from: "agent@acme.example",
			subject: "Again",
			text: "x",
			to: ["a@example.com"],
		});
		// The first listing also cached the other inbox's address.
		await ryu.mail.send({
			from: "b@acme.example",
			subject: "Other",
			text: "x",
			to: ["a@example.com"],
		});
		expect(
			calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)
		).toEqual([
			"GET /api/mail/inboxes",
			"POST /api/mail/inboxes/inbox_1/send",
			"POST /api/mail/inboxes/inbox_1/send",
			"POST /api/mail/inboxes/inbox_2/send",
		]);
		const body = JSON.parse(calls[1]?.body ?? "{}") as Record<string, unknown>;
		expect(body).toMatchObject({ html: "<p>Hi</p>", subject: "Hi" });
		expect(body.from).toBeUndefined();

		// Another instance has its own cache.
		const other = new Ryu({ env: HOSTED_ENV, fetch });
		await other.mail.send({
			from: "agent@acme.example",
			subject: "Hi",
			text: "x",
			to: ["a@example.com"],
		});
		expect(calls.filter((call) => call.method === "GET")).toHaveLength(2);
	});

	test("an inbox id skips the lookup", async () => {
		const { calls, fetch } = sendServer();
		const ryu = new Ryu({ env: HOSTED_ENV, fetch });
		await ryu.mail.send({
			from: "inbox_2",
			subject: "Hi",
			text: "x",
			to: ["a@example.com"],
		});
		expect(calls.map((call) => call.method)).toEqual(["POST"]);
	});

	test("an unknown address is inbox_not_found after one fresh lookup", async () => {
		const { calls, fetch } = sendServer();
		const ryu = new Ryu({ env: HOSTED_ENV, fetch, result: "object" });
		const { error } = await ryu.mail.send({
			from: "nobody@acme.example",
			subject: "Hi",
			text: "x",
			to: ["a@example.com"],
		});
		expect(error).toBeInstanceOf(RyuNotFoundError);
		expect(error?.code).toBe("inbox_not_found");
		expect(error?.retryable).toBe(false);
		expect(calls.map((call) => call.method)).toEqual(["GET"]);
	});

	test("inbox_not_found keeps the lookup's request id for support", async () => {
		const { fetch } = stubFetch(
			mailServer({
				"GET /api/mail/inboxes": () =>
					json({ inboxes: [INBOX] }, { headers: { "x-request-id": "req_7" } }),
			})
		);
		const ryu = new Ryu({ env: HOSTED_ENV, fetch, result: "object" });
		const { error, meta } = await ryu.mail.send({
			from: "nobody@acme.example",
			subject: "Hi",
			text: "x",
			to: ["a@example.com"],
		});
		expect(error).toBeInstanceOf(RyuNotFoundError);
		expect(error?.requestId).toBe("req_7");
		expect(meta?.requestId).toBe("req_7");
	});

	test("html and react together, or an empty from, are refused before any request", async () => {
		const { calls, fetch } = sendServer();
		const ryu = new Ryu({ env: HOSTED_ENV, fetch, result: "object" });
		const both = await ryu.mail.send({
			from: "inbox_1",
			html: "<p>x</p>",
			react: {},
			subject: "Hi",
			to: ["a@example.com"],
		});
		expect(both.error?.code).toBe("conflicting_content");
		const empty = await ryu.mail.send({
			from: " ",
			subject: "Hi",
			to: ["a@example.com"],
		});
		expect(empty.error?.code).toBe("invalid_from");
		// An id that would address another route is refused, not sent.
		for (const from of [
			"inbox_1/messages/msg_9/forward?",
			"..",
			"inbox%2F1",
			"inbox 1",
		]) {
			const unsafe = await ryu.mail.send({
				from,
				subject: "Hi",
				text: "x",
				to: ["a@example.com"],
			});
			expect({ from, code: unsafe.error?.code }).toEqual({
				from,
				code: "invalid_from",
			});
		}
		expect(calls).toHaveLength(0);
	});

	test("a react body errors cleanly when @react-email/render is missing", async () => {
		const { calls, fetch } = sendServer();
		const config = resolveServiceConfig(
			"mail",
			{ env: HOSTED_ENV },
			createEnvReader(HOSTED_ENV)
		);
		const mail = createMailNamespace(
			config,
			fetch,
			{},
			{
				cacheOwner: {},
				loadRenderer: () =>
					loadReactEmailRender(() =>
						Promise.reject(
							new Error("Cannot find module '@react-email/render'")
						)
					),
			}
		);
		const error = await rejection(
			mail.send({
				from: "inbox_1",
				react: { type: "Email" },
				subject: "Hi",
				to: ["a@example.com"],
			})
		);
		expect(error).toBeInstanceOf(RyuConfigurationError);
		expect(error.code).toBe("react_renderer_missing");
		expect(error.message).toContain("@react-email/render");
		expect(calls).toHaveLength(0);
	});

	test("a react body is rendered to html with the injected renderer", async () => {
		const { calls, fetch } = sendServer();
		const config = resolveServiceConfig(
			"mail",
			{ env: HOSTED_ENV },
			createEnvReader(HOSTED_ENV)
		);
		const rendered: unknown[] = [];
		const mail = createMailNamespace(
			config,
			fetch,
			{},
			{
				cacheOwner: {},
				loadRenderer: () =>
					Promise.resolve((element: unknown) => {
						rendered.push(element);
						return Promise.resolve("<html>rendered</html>");
					}),
			}
		);
		const element = { type: "WelcomeEmail" };
		await mail.send({
			from: "inbox_1",
			react: element,
			subject: "Hi",
			to: ["a@example.com"],
		});
		expect(rendered).toEqual([element]);
		const body = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
		expect(body.html).toBe("<html>rendered</html>");
		expect(body.react).toBeUndefined();
	});

	test("send's trailing signal aborts the call", async () => {
		// Answers only by failing once the request's signal aborts.
		const fetch = (_input: RequestInfo | URL, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(new Error("aborted"))
				);
			});
		const controller = new AbortController();
		const ryu = new Ryu({ env: HOSTED_ENV, fetch });
		const pending = rejection(
			ryu.mail.send(
				{ from: "inbox_1", subject: "Hi", text: "x", to: ["a@example.com"] },
				{ signal: controller.signal }
			)
		);
		controller.abort();
		const error = await pending;
		expect(error).toBeInstanceOf(RyuAbortError);
	});
});

describe("helpers", () => {
	test("senderAddress tells addresses from inbox ids", () => {
		expect(senderAddress("Agent <Agent@Acme.Example>")).toBe(
			"agent@acme.example"
		);
		expect(senderAddress(" a@b.example ")).toBe("a@b.example");
		expect(senderAddress("inbox_123")).toBeNull();
	});

	test("loadReactEmailRender returns render, or null when the import fails", async () => {
		const render = () => "<p/>";
		expect(await loadReactEmailRender(() => Promise.resolve({ render }))).toBe(
			render
		);
		expect(
			await loadReactEmailRender(() =>
				Promise.reject(new Error("Cannot find module"))
			)
		).toBeNull();
		expect(await loadReactEmailRender(() => Promise.resolve({}))).toBeNull();
	});

	test("mailErrorCode names only the listed prose, by status", () => {
		expect(mailErrorCode(409, IN_PROGRESS)).toBe("idempotency_in_progress");
		expect(mailErrorCode(409, ` ${IN_PROGRESS}\n`)).toBe(
			"idempotency_in_progress"
		);
		expect(mailErrorCode(500, IN_PROGRESS)).toBeNull();
		expect(mailErrorCode(409, "inbox is disabled")).toBeNull();
	});

	test("inboxCacheFor keeps one cache per owner", () => {
		const owner = {};
		expect(inboxCacheFor(owner)).toBe(inboxCacheFor(owner));
		expect(inboxCacheFor(owner)).not.toBe(inboxCacheFor({}));
	});

	test("mailPageSize clamps to what both servers accept", () => {
		expect(mailPageSize(undefined)).toBe(MAIL_DEFAULT_PAGE_SIZE);
		expect(mailPageSize(0)).toBe(1);
		expect(mailPageSize(500)).toBe(200);
		expect(mailPageSize(25.7)).toBe(25);
		expect(mailPageSize(Number.NaN)).toBe(MAIL_DEFAULT_PAGE_SIZE);
	});

	test("the package root exports the page-size rule (the CLI's next-page note uses it)", async () => {
		const root = await import("../index.ts");
		expect(root.mailPageSize).toBe(mailPageSize);
		expect(root.MAIL_DEFAULT_PAGE_SIZE).toBe(50);
		expect(root.MAIL_MAX_PAGE_SIZE).toBe(200);
	});
});

describe("list limits", () => {
	test("drafts.list, events.list and webhooks.deliveries.list pass an optional limit", async () => {
		const { calls, fetch } = stubFetch(() =>
			json({ drafts: [], events: [], deliveries: [] })
		);
		const ryu = new Ryu({ env: HOSTED_ENV, fetch });
		await ryu.mail.drafts.list("inbox_1", { limit: 25 });
		await ryu.mail.drafts.list("inbox_1");
		await ryu.mail.events.list("inbox_1", undefined, { limit: 500 });
		await ryu.mail.events.list(undefined, "message.received", { limit: 10 });
		await ryu.mail.webhooks.deliveries.list("wh_1", { limit: 1000 });
		// The deprecated flat aliases take the same argument.
		await ryu.mail.listDrafts("inbox_1", { limit: 2 });
		expect(calls.map((call) => call.url.replace(BASE_URL_ORIGIN, ""))).toEqual([
			"/api/mail/inboxes/inbox_1/drafts?limit=25",
			"/api/mail/inboxes/inbox_1/drafts",
			"/api/mail/inboxes/inbox_1/events?limit=500",
			"/api/mail/events?eventType=message.received&limit=10",
			"/api/mail/webhooks/wh_1/deliveries?limit=1000",
			"/api/mail/inboxes/inbox_1/drafts?limit=2",
		]);
	});

	test("the id checks still run before a limited list", async () => {
		const { calls, fetch } = stubFetch(() => json({ drafts: [] }));
		const ryu = new Ryu({ env: HOSTED_ENV, fetch, result: "object" });
		const { error } = await ryu.mail.drafts.list("../x", { limit: 5 });
		expect(error).toBeInstanceOf(RyuInvalidRequestError);
		expect(error?.code).toBe("invalid_id");
		expect(calls).toEqual([]);
	});

	test("a limit that is not a positive integer is refused before any request", async () => {
		const { calls, fetch } = stubFetch(() =>
			json({ drafts: [], events: [], deliveries: [] })
		);
		const ryu = new Ryu({ env: HOSTED_ENV, fetch, result: "object" });
		const bad = [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, true, "5"];
		for (const limit of bad as number[]) {
			const results = [
				await ryu.mail.drafts.list("inbox_1", { limit }),
				await ryu.mail.events.list(undefined, undefined, { limit }),
				await ryu.mail.events.list("inbox_1", undefined, { limit }),
				await ryu.mail.webhooks.deliveries.list("wh_1", { limit }),
				await ryu.mail.listDrafts("inbox_1", { limit }),
			];
			for (const { error } of results) {
				expect(error).toBeInstanceOf(RyuInvalidRequestError);
				expect(error?.code).toBe("invalid_limit");
			}
		}
		const { error } = await ryu.mail.listEvents(undefined, undefined, {
			limit: 0,
		});
		expect(error?.message).toBe(
			"Ryu mail.listEvents: limit must be a positive integer."
		);
		expect(calls).toEqual([]);
	});

	test("an empty inbox id is refused, never read as every inbox", async () => {
		const { calls, fetch } = stubFetch(() => json({ events: [] }));
		const ryu = new Ryu({ env: HOSTED_ENV, fetch, result: "object" });
		const { error } = await ryu.mail.events.list("", undefined, { limit: 3 });
		expect(error?.code).toBe("invalid_id");
		expect(calls).toEqual([]);
	});
});

describe("messages.iterate", () => {
	test("pages by createdAt, dedupes boundary ties by id and stops on a short page", async () => {
		const t3 = "2026-10-03T00:00:00.000Z";
		const t2 = "2026-10-02T00:00:00.000Z";
		const t1 = "2026-10-01T00:00:00.000Z";
		const pages = new Map<string | null, unknown[]>([
			[null, [message("m4", t3), message("m3", t2), message("m2", t2)]],
			// A server that includes the boundary timestamp repeats m3 and m2.
			[t2, [message("m3", t2), message("m2", t2), message("m1", t1)]],
			[t1, [message("m0", "2026-09-30T00:00:00.000Z")]],
		]);
		const { calls, fetch } = stubFetch((request) => {
			const url = new URL(request.url);
			return json({
				messages: pages.get(url.searchParams.get("before")) ?? [],
			});
		});
		const ryu = new Ryu({ env: HOSTED_ENV, fetch });
		const ids: string[] = [];
		for await (const item of ryu.mail.messages.iterate("inbox_1", {
			limit: 3,
			direction: "outbound",
		})) {
			ids.push(item.id);
		}
		expect(ids).toEqual(["m4", "m3", "m2", "m1", "m0"]);
		const queries = calls.map((call) => new URL(call.url).searchParams);
		expect(queries.map((query) => query.get("before"))).toEqual([null, t2, t1]);
		expect(queries.every((query) => query.get("limit") === "3")).toBe(true);
		expect(
			queries.every((query) => query.get("direction") === "outbound")
		).toBe(true);
		expect(new URL(calls[0]?.url ?? "").pathname).toBe(
			"/api/mail/inboxes/inbox_1/messages"
		);
	});

	test("collect honours maxItems and a starting before", async () => {
		const { calls, fetch } = stubFetch(() =>
			json({
				messages: [
					message("a", "2026-10-02T00:00:00.000Z"),
					message("b", "2026-10-01T00:00:00.000Z"),
				],
			})
		);
		const ryu = new Ryu({ env: HOSTED_ENV, fetch });
		const items = await ryu.mail.messages
			.iterate("inbox_1", { before: "2026-10-05T00:00:00.000Z", maxItems: 1 })
			.collect();
		expect(items.map((item) => item.id)).toEqual(["a"]);
		expect(new URL(calls[0]?.url ?? "").searchParams.get("before")).toBe(
			"2026-10-05T00:00:00.000Z"
		);
	});

	test("iteration errors are RyuErrors even in object mode", async () => {
		const { fetch } = stubFetch(() =>
			json({ error: "unauthorized" }, { status: 401 })
		);
		const ryu = new Ryu({ env: SELF_HOSTED_ENV, fetch, result: "object" });
		const error = await rejection(
			ryu.mail.messages.iterate("inbox_1").collect()
		);
		expect(error.status).toBe(401);
		expect(error.code).toBe("unauthenticated");
	});
});

describe("1:1 surface", () => {
	test("status stays top level, and webhooks.rotateSecret works on hosted Mail", async () => {
		const { calls, fetch } = stubFetch(
			mailServer({
				"GET /api/mail/status": () =>
					json({ apiVersion: "v1", configured: true, domainMode: "managed" }),
				"PATCH /api/mail/webhooks/wh_1": () =>
					json({
						secret: "whsec_new",
						webhook: { id: "wh_1", url: "https://hooks.example.com/mail" },
					}),
			})
		);
		const ryu = new Ryu({ env: HOSTED_ENV, fetch });
		expect((await ryu.mail.status()).configured).toBe(true);
		const rotated = await ryu.mail.webhooks.rotateSecret("wh_1");
		expect(rotated.secret).toBe("whsec_new");
		expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({ rotateSecret: true });
		expect(calls[1]?.headers.get("x-gateway-key")).toBe(
			"rgw_mail_gateway_secret"
		);
	});

	test("an id that would leave its path segment is refused before any request", async () => {
		const { calls, fetch } = stubFetch(() => json({}));
		const ryu = new Ryu({ env: HOSTED_ENV, fetch, result: "object" });
		for (const call of [
			() => ryu.mail.messages.get("../inboxes/inbox_1/rotate-secret?x="),
			() => ryu.mail.messages.get("../webhooks"),
			() => ryu.mail.messages.reply("inbox_1", "msg_1/forward", {}),
			() => ryu.mail.messages.send("..", { subject: "x", to: ["a@b.c"] }),
			() => ryu.mail.webhooks.delete("wh_1#x"),
			() => ryu.mail.getMessage("../webhooks"),
			() => ryu.mail.sendFromInbox("..", { subject: "x", to: ["a@b.c"] }),
		]) {
			const { error } = await call();
			expect(error).toBeInstanceOf(RyuInvalidRequestError);
			expect(error?.code).toBe("invalid_id");
		}
		const iterate = async () => {
			for await (const _message of ryu.mail.messages.iterate("inbox_1?x=1")) {
				// unreachable: the id is refused first
			}
		};
		await expect(iterate()).rejects.toBeInstanceOf(RyuInvalidRequestError);
		expect(calls).toHaveLength(0);
	});

	test("every guarded id table entry is a MailAPI method", () => {
		for (const method of Object.keys(MAIL_ID_ARGUMENTS)) {
			expect(typeof Reflect.get(MailAPI.prototype, method)).toBe("function");
		}
	});

	test("ryu.safe.mail mirrors the namespace in object mode", async () => {
		const { fetch } = stubFetch(() => json({ inboxes: [INBOX] }));
		const ryu = new Ryu({ env: HOSTED_ENV, fetch });
		const result = await ryu.safe.mail.inboxes.list();
		expect(result.error).toBeNull();
		expect(result.data?.[0]?.address).toBe("agent@acme.example");
		expect(result.meta?.status).toBe(200);
	});
});

describe("resource namespaces", () => {
	/** Arguments for each MailAPI method, so both spellings send a real request. */
	const ARGS: Record<string, unknown[]> = {
		addEntry: ["inbox", "inbox_1", "inbound", "block", { entry: "x@y.z" }],
		changeInboxAddress: ["inbox_1", { localPart: "new" }],
		checkAddress: ["agent", { domainId: "dom_1" }],
		createDomain: [{ domain: "acme.example" }],
		createDraft: ["inbox_1", { subject: "Draft", to: ["a@example.com"] }],
		createInbox: [{ address: "a@acme.example", name: "A" }],
		createPod: [{ name: "Pod" }],
		createWebhook: [
			{ eventTypes: ["message.received"], url: "https://h.example/m" },
			"inbox_1",
		],
		deleteDomain: ["dom_1"],
		deleteDraft: ["inbox_1", "draft_1"],
		deleteInbox: ["inbox_1"],
		deleteMessage: ["inbox_1", "msg_1"],
		deletePod: ["pod_1"],
		deleteThread: ["inbox_1", "thr_1"],
		deleteWebhook: ["wh_1"],
		downloadAttachment: ["inbox_1", "msg_1", "att_1"],
		downloadRaw: ["msg_1"],
		ensureAgentInbox: ["agent_1", { name: "Agent" }],
		forward: ["inbox_1", "msg_1", { subject: "Fwd", to: ["b@example.com"] }],
		getAgentInbox: ["agent_1"],
		getDomain: ["dom_1"],
		getDraft: ["inbox_1", "draft_1"],
		getInbox: ["inbox_1"],
		getMessage: ["msg_1"],
		getPod: ["pod_1"],
		getThread: ["inbox_1", "thr_1"],
		getWebhook: ["wh_1"],
		listDomains: [],
		listDrafts: ["inbox_1"],
		listEntries: ["inbox", "inbox_1", "inbound", "block"],
		listEvents: ["inbox_1", "message.received"],
		listInboxes: [],
		listMessages: ["inbox_1", { limit: 5 }],
		listPods: [],
		listThreads: ["inbox_1", "hello"],
		listWebhookDeliveries: ["wh_1"],
		listWebhookHeaders: ["wh_1"],
		listWebhooks: [],
		removeEntry: ["inbox", "inbox_1", "inbound", "block", "x@y.z"],
		reply: ["inbox_1", "msg_1", { text: "Thanks" }],
		replyAll: ["inbox_1", "msg_1", { text: "Thanks all" }],
		rotateInboundSecret: ["inbox_1"],
		rotateWebhookSecret: ["wh_1"],
		searchMessages: ["inbox_1", "invoice", { limit: 5 }],
		send: ["inbox_1", SEND_INPUT, "send-key-0001"],
		sendDraft: ["inbox_1", "draft_1", "draft-key-0001"],
		updateDomain: ["dom_1", { trackingEnabled: true }],
		updateDraft: ["inbox_1", "draft_1", { subject: "New" }],
		updateInbox: ["inbox_1", { name: "B" }],
		updateMessage: ["inbox_1", "msg_1", { read: true }],
		updateThread: ["inbox_1", "thr_1", { addLabels: ["x"] }],
		updateWebhook: ["wh_1", { url: "https://h.example/n" }],
		updateWebhookHeaders: ["wh_1", { "x-a": "1" }, ["x-b"]],
		verifyDomain: ["dom_1"],
	};

	type AnyMethod = (...args: unknown[]) => PromiseLike<unknown>;

	function at(root: unknown, path: string): AnyMethod {
		let node = root;
		for (const key of path.split(".")) {
			node = (node as Record<string, unknown>)[key];
		}
		return node as AnyMethod;
	}

	/** Explicit idempotency keys in {@link ARGS}; every other key is generated per call. */
	const EXPLICIT_KEYS = new Set(["send-key-0001", "draft-key-0001"]);

	/**
	 * What a call put on the wire. A generated idempotency key differs per
	 * call, so only its presence is compared; an explicit key is compared as is.
	 */
	function wire(calls: readonly Recorded[]) {
		return calls.map((call) => {
			const key = call.headers.get("idempotency-key");
			return {
				body: call.body,
				idempotencyKey:
					key !== null && EXPLICIT_KEYS.has(key) ? key : key !== null,
				method: call.method,
				url: call.url,
			};
		});
	}

	test("every MailAPI method has a canonical home or stays top level", () => {
		const placed = new Set<string>([
			...Object.values(MAIL_CANONICAL_METHODS),
			...MAIL_TOP_LEVEL_METHODS,
		]);
		// Private transport helpers (`private async mintWsTicket()`) are not part of
		// the public surface.
		const clientSource = readFileSync(
			resolve(import.meta.dir, "../../../client/src/mail.ts"),
			"utf8"
		);
		const privateMethods = new Set(
			[...clientSource.matchAll(/^\tprivate (?:async )?\*?(\w+)\(/gmu)].map(
				(match) => match[1]
			)
		);
		const methods = Object.getOwnPropertyNames(MailAPI.prototype).filter(
			(name) =>
				name !== "constructor" &&
				!privateMethods.has(name) &&
				typeof Reflect.get(MailAPI.prototype, name) === "function"
		);
		expect(methods.filter((name) => !placed.has(name))).toEqual([]);
		expect(Object.keys(ARGS).sort()).toEqual(
			[...new Set(Object.values(MAIL_CANONICAL_METHODS))].sort()
		);
	});

	test("each canonical method and its deprecated flat alias send the same request", async () => {
		const { calls, fetch } = stubFetch(() => json({}));
		const ryu = new Ryu({ env: SELF_HOSTED_ENV, fetch, result: "object" });
		for (const [path, method] of Object.entries(MAIL_CANONICAL_METHODS)) {
			const flat = method === "send" ? "sendFromInbox" : method;
			const args = ARGS[method] ?? [];
			const before = calls.length;
			await at(ryu.mail, path)(...args);
			const canonical = wire(calls.slice(before));
			const middle = calls.length;
			await at(ryu.mail, flat)(...args);
			const aliased = wire(calls.slice(middle));
			expect({ path, sent: canonical.length > 0 }).toEqual({
				path,
				sent: true,
			});
			expect({ path, wire: aliased }).toEqual({ path, wire: canonical });
		}
		const explicit = calls
			.map((call) => call.headers.get("idempotency-key"))
			.filter((key) => key !== null && EXPLICIT_KEYS.has(key));
		expect(explicit.sort()).toEqual([
			"draft-key-0001",
			"draft-key-0001",
			"send-key-0001",
			"send-key-0001",
		]);
	});

	test("the canonical tree resolves on the namespace the docs guard builds", () => {
		const config = resolveServiceConfig(
			"mail",
			{},
			createEnvReader(SELF_HOSTED_ENV)
		);
		const mail = MAIL_NAMESPACE.create(
			config,
			() => Promise.reject(new Error("no request")),
			{}
		);
		for (const path of [
			...Object.keys(MAIL_CANONICAL_METHODS),
			"messages.iterate",
			"send",
			"status",
			"connectRealtime",
			"connectRealtimeWithTicket",
			"createRealtimeTicket",
		]) {
			expect({ path, type: typeof at(mail, path) }).toEqual({
				path,
				type: "function",
			});
		}
	});

	test("object mode carries meta on a canonical call, also through ryu.safe and .with()", async () => {
		const { calls, fetch } = stubFetch(
			mailServer({
				"GET /api/mail/webhooks/wh_1/headers": () => json({ headers: ["x-a"] }),
				"POST /api/mail/inboxes/inbox_1/messages/msg_1/reply": () =>
					json(message("msg_2", "2026-10-01T00:00:00.000Z")),
			})
		);
		const objects = new Ryu({ env: HOSTED_ENV, fetch, result: "object" });
		const headers = await objects.mail.webhooks.headers.list("wh_1");
		expect(headers.error).toBeNull();
		expect(headers.data).toEqual(["x-a"]);
		expect(headers.meta?.status).toBe(200);
		expect(headers.meta?.attempts).toBe(1);

		const throwing = new Ryu({ env: HOSTED_ENV, fetch });
		const reply = await throwing.safe.mail
			.with({ idempotencyKey: "reply-key-0002" })
			.messages.reply("inbox_1", "msg_1", { text: "Thanks" });
		expect(reply.error).toBeNull();
		expect(reply.data?.id).toBe("msg_2");
		expect(reply.meta?.idempotencyKey).toBe("reply-key-0002");
		expect(calls[1]?.headers.get("idempotency-key")).toBe("reply-key-0002");
	});

	test("an invalid id names the spelling the caller used", async () => {
		const { calls, fetch } = stubFetch(() => json({}));
		const ryu = new Ryu({ env: HOSTED_ENV, fetch, result: "object" });
		const canonical = await ryu.mail.drafts.get("inbox_1", "../x");
		expect(canonical.error?.code).toBe("invalid_id");
		expect(canonical.error?.message).toContain("mail.drafts.get: argument 2");
		const flat = await ryu.mail.getDraft("inbox_1", "../x");
		expect(flat.error?.message).toContain("mail.getDraft: argument 2");
		const iterate = async () => {
			for await (const _message of ryu.mail.messages.iterate("../x")) {
				// unreachable: the id is refused first
			}
		};
		const refused = await iterate().then(
			() => null,
			(error: unknown) => error
		);
		expect(refused).toBeInstanceOf(RyuInvalidRequestError);
		expect((refused as RyuInvalidRequestError).code).toBe("invalid_id");
		expect((refused as RyuInvalidRequestError).message).toContain(
			"mail.messages.iterate: argument 1"
		);
		expect(calls).toHaveLength(0);
	});
});
