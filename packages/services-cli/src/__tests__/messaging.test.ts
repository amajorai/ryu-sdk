import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { RyuFetch } from "@ryuhq/services";
import { type CliIo, runCli } from "../cli.ts";
import { messagingCommands } from "../commands/messaging.ts";
import { createServicesMcpServer } from "../mcp/server.ts";
import { commandLine } from "../registry.ts";

interface Recorded {
	body: string | null;
	headers: Headers;
	method: string;
	url: string;
}

function stubFetch(respond: (request: Recorded) => Response) {
	const calls: Recorded[] = [];
	const fetch: RyuFetch = async (input, init) => {
		const request = new Request(input, init);
		const recorded: Recorded = {
			body: request.body === null ? null : await request.text(),
			headers: request.headers,
			method: request.method,
			url: request.url,
		};
		calls.push(recorded);
		return respond(recorded);
	};
	return { calls, fetch };
}

const ORG = "64a0000000000000000000a1";
const ENV = {
	RYU_API_KEY: "ryu_cli_messaging_secret",
	RYU_ORGANIZATION_ID: ORG,
};
const BASE = `https://api.ryuhq.com/api/messaging/orgs/${ORG}`;
const NOW = "2026-10-21T12:00:00.000Z";

const MESSAGE = {
	id: "msg_1",
	organizationId: ORG,
	channel: "sms",
	direction: "outbound",
	status: "accepted",
	from: "+15555550100",
	to: "+6591234567",
	isoCountryCode: "SG",
	numberId: "num_1",
	whatsappSenderId: null,
	body: "Shipped",
	bodyType: "text",
	encoding: "GSM",
	segments: 1,
	template: null,
	hasMedia: false,
	providerMessageId: "aws-1",
	providerStatus: null,
	providerStatusDescription: null,
	heldMicroUsd: 9000,
	priceMicroUsd: null,
	chargedMicroUsd: 0,
	absorbedMicroUsd: 0,
	chargeState: "held",
	estimated: false,
	ttlSeconds: null,
	metadata: {},
	error: null,
	createdAt: NOW,
	updatedAt: NOW,
};

const NUMBER = {
	id: "num_1",
	organizationId: ORG,
	phoneNumber: "+15555550100",
	isoCountryCode: "US",
	numberType: "TOLL_FREE",
	capabilities: ["SMS"],
	messageType: "TRANSACTIONAL",
	status: "active",
	label: null,
	twoWayEnabled: false,
	registrationId: "reg_1",
	monthlyLeaseMicroUsd: 2_000_000,
	leasePeriod: 1,
	currentPeriodEndsAt: NOW,
	suspendedAt: null,
	graceEndsAt: null,
	releasedAt: null,
	error: null,
	createdAt: NOW,
	updatedAt: NOW,
};

const QUOTE = {
	channel: "sms",
	credit: { availableMicroUsd: 5_000_000, heldMicroUsd: 0 },
	quote: {
		ceilingMicroUsd: 9000,
		encoding: "GSM",
		isoCountryCode: "SG",
		segments: 1,
	},
};

/** A tiny Messaging server with #777's `{ ...details, error, message }` refusals. */
function messagingServer(request: Recorded): Response {
	const url = new URL(request.url);
	const path = url.pathname.replace(`/api/messaging/orgs/${ORG}`, "");
	if (url.pathname === "/api/messaging/status") {
		return Response.json({
			apiVersion: "v1",
			configured: true,
			channels: { sms: true, mms: true, voice: true, whatsapp: false },
		});
	}
	if (request.method === "GET" && path === "/quote") {
		return Response.json(QUOTE);
	}
	if (request.method === "POST" && path === "/sms") {
		const body = JSON.parse(request.body ?? "{}") as { to?: string };
		if (body.to === "+15555550199") {
			return Response.json(
				{
					error: "recipient_opted_out",
					message: "the recipient opted out of messages from this organization",
				},
				{ status: 422, headers: { "x-request-id": "req_opt" } }
			);
		}
		return Response.json({ message: MESSAGE }, { status: 202 });
	}
	if (request.method === "GET" && path === "/numbers") {
		return Response.json({ numbers: [NUMBER] });
	}
	if (request.method === "GET" && path === "/messages") {
		return url.searchParams.get("cursor") === "c2"
			? Response.json({
					messages: [{ ...MESSAGE, id: "msg_2" }],
					nextCursor: null,
				})
			: Response.json({ messages: [MESSAGE], nextCursor: "c2" });
	}
	if (request.method === "GET" && path === "/messages/msg_1") {
		return Response.json({ message: MESSAGE });
	}
	return Response.json(
		{ error: "not_found", message: "message not found" },
		{ status: 404 }
	);
}

function capture(fetch: RyuFetch, env: Record<string, string> = ENV) {
	let out = "";
	let err = "";
	const io: CliIo = {
		env,
		stdin: "",
		stdout: { write: (chunk: string) => (out += chunk) },
		stderr: { write: (chunk: string) => (err += chunk) },
		fetch,
	};
	return { io, stdout: () => out, stderr: () => err };
}

describe("ryu-services messaging", () => {
	test("registers the design's commands", () => {
		expect(
			messagingCommands.map((command) => commandLine("messaging", command))
		).toEqual([
			"ryu-services messaging status",
			"ryu-services messaging quote",
			"ryu-services messaging sms send",
			"ryu-services messaging numbers list",
			"ryu-services messaging messages list",
			"ryu-services messaging messages get",
		]);
	});

	test("sms send posts with x-api-key, the organization and the caller's idempotency key", async () => {
		const { calls, fetch } = stubFetch(messagingServer);
		const run = capture(fetch);
		const code = await runCli(
			[
				"messaging",
				"sms",
				"send",
				"--from",
				"num_1",
				"--to",
				"+6591234567",
				"--body",
				"Shipped",
				"--metadata",
				"order=1842",
				"--ttl",
				"3600",
				"--idempotency-key",
				"order-1842-shipped",
				"--json",
			],
			run.io
		);
		expect(code).toBe(0);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(`${BASE}/sms`);
		expect(calls[0]?.headers.get("x-api-key")).toBe(ENV.RYU_API_KEY);
		expect(calls[0]?.headers.get("x-ryu-organization")).toBe(ORG);
		expect(calls[0]?.headers.get("idempotency-key")).toBe("order-1842-shipped");
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
			from: "num_1",
			to: "+6591234567",
			body: "Shipped",
			ttlSeconds: 3600,
			metadata: { order: "1842" },
		});
		const printed = JSON.parse(run.stdout()) as {
			data: { id: string };
			meta: { status: number; idempotencyKey: string };
		};
		expect(printed.data.id).toBe("msg_1");
		expect(printed.meta.status).toBe(202);
		expect(printed.meta.idempotencyKey).toBe("order-1842-shipped");
		expect(run.stdout()).not.toContain(ENV.RYU_API_KEY);
	});

	test("a refused send exits 1 with the server's code and request id", async () => {
		const { fetch } = stubFetch(messagingServer);
		const run = capture(fetch);
		const code = await runCli(
			[
				"messaging",
				"sms",
				"send",
				"--from",
				"num_1",
				"--to",
				"+15555550199",
				"--body",
				"Hi",
				"--json",
			],
			run.io
		);
		expect(code).toBe(1);
		const printed = JSON.parse(run.stdout() || run.stderr()) as {
			error: { code: string; requestId: string; service: string };
		};
		expect(printed.error.code).toBe("recipient_opted_out");
		expect(printed.error.requestId).toBe("req_opt");
		expect(printed.error.service).toBe("messaging");
	});

	test("status, quote, numbers list and messages get", async () => {
		const { calls, fetch } = stubFetch(messagingServer);
		for (const argv of [
			["messaging", "status"],
			["messaging", "quote", "--to", "+6591234567", "--body", "Hi"],
			["messaging", "numbers", "list", "--include-released"],
			["messaging", "messages", "get", "msg_1"],
		]) {
			const run = capture(fetch);
			expect({ argv, code: await runCli(argv, run.io) }).toEqual({
				argv,
				code: 0,
			});
		}
		expect(calls.map((call) => call.url)).toEqual([
			"https://api.ryuhq.com/api/messaging/status",
			`${BASE}/quote?channel=sms&to=%2B6591234567&body=Hi`,
			`${BASE}/numbers?status=all`,
			`${BASE}/messages/msg_1`,
		]);
	});

	test("messages list reads one page; --all follows nextCursor as JSON lines", async () => {
		const { calls, fetch } = stubFetch(messagingServer);
		const page = capture(fetch);
		expect(
			await runCli(
				[
					"messaging",
					"messages",
					"list",
					"--channel",
					"sms",
					"--limit",
					"1",
					"--json",
				],
				page.io
			)
		).toBe(0);
		expect(
			(JSON.parse(page.stdout()) as { data: { nextCursor: string } }).data
				.nextCursor
		).toBe("c2");
		expect(calls[0]?.url).toBe(`${BASE}/messages?channel=sms&limit=1`);

		// Human mode: one JSON line per message, the next cursor on stderr.
		const human = capture(fetch);
		expect(
			await runCli(["messaging", "messages", "list", "--limit", "1"], human.io)
		).toBe(0);
		expect(
			human
				.stdout()
				.trim()
				.split("\n")
				.map((line) => (JSON.parse(line) as { id: string }).id)
		).toEqual(["msg_1"]);
		expect(human.stderr()).toBe(
			"More messages: pass --cursor c2 for the next page, or --all for every message.\n"
		);

		const all = capture(fetch);
		expect(
			await runCli(["messaging", "messages", "list", "--all"], all.io)
		).toBe(0);
		const ids = all
			.stdout()
			.trim()
			.split("\n")
			.map((line) => (JSON.parse(line) as { id: string }).id);
		expect(ids).toEqual(["msg_1", "msg_2"]);
	});

	test("usage errors exit 2 and send nothing", async () => {
		const { calls, fetch } = stubFetch(messagingServer);
		for (const argv of [
			["messaging", "sms", "send", "--to", "+6591234567", "--body", "x"],
			["messaging", "messages", "list", "--channel", "fax"],
			["messaging", "messages", "list", "--all", "--cursor", "c2"],
			["messaging", "numbers", "list", "--all"],
			["messaging", "messages", "get"],
			[
				"messaging",
				"sms",
				"send",
				"--from",
				"n",
				"--to",
				"+1",
				"--body",
				"x",
				"--metadata",
				"novalue",
			],
		]) {
			const run = capture(fetch);
			expect({ argv, code: await runCli(argv, run.io) }).toEqual({
				argv,
				code: 2,
			});
		}
		expect(calls).toHaveLength(0);
	});

	test("an unconfigured CLI exits 2 naming RYU_API_KEY and RYU_ORGANIZATION_ID", async () => {
		const { calls, fetch } = stubFetch(messagingServer);
		const run = capture(fetch, { RYU_API_KEY: "ryu_k" });
		expect(await runCli(["messaging", "numbers", "list"], run.io)).toBe(2);
		expect(run.stderr()).toContain("RYU_ORGANIZATION_ID");
		expect(calls).toHaveLength(0);
	});

	test("numbers list prints one JSON line per number; its old --all names --include-released", async () => {
		const { fetch } = stubFetch(messagingServer);
		const human = capture(fetch);
		expect(await runCli(["messaging", "numbers", "list"], human.io)).toBe(0);
		const lines = human.stdout().trim().split("\n");
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(JSON.parse(line)).toHaveProperty("id");
		}
		expect(human.stderr()).toBe("");

		const json = capture(fetch);
		expect(
			await runCli(["messaging", "numbers", "list", "--json"], json.io)
		).toBe(0);
		const envelope = JSON.parse(json.stdout()) as {
			data: unknown[];
			meta: unknown;
		};
		expect(envelope.data).toHaveLength(lines.length);
		expect(envelope).toHaveProperty("meta");

		const old = capture(fetch);
		expect(
			await runCli(["messaging", "numbers", "list", "--all"], old.io)
		).toBe(2);
		expect(old.stderr()).toContain("--include-released");
	});

	test("messaging status needs no credentials and sends none", async () => {
		const { calls, fetch } = stubFetch(messagingServer);
		const run = capture(fetch, {});
		expect(await runCli(["messaging", "status"], run.io)).toBe(0);
		expect(calls).toHaveLength(1);
		expect(new URL(calls[0]?.url ?? "").pathname).toBe("/api/messaging/status");
		expect(calls[0]?.headers.has("x-api-key")).toBe(false);
		expect(calls[0]?.headers.has("x-ryu-organization")).toBe(false);
	});

	test("--api-key and --base-url apply to Messaging", async () => {
		const { calls, fetch } = stubFetch(messagingServer);
		const run = capture(fetch, { RYU_ORGANIZATION_ID: ORG });
		expect(
			await runCli(
				[
					"messaging",
					"numbers",
					"list",
					"--api-key",
					"ryu_flag_key",
					"--base-url",
					"https://cp.example.com",
				],
				run.io
			)
		).toBe(0);
		expect(calls[0]?.url).toBe(
			`https://cp.example.com/api/messaging/orgs/${ORG}/numbers`
		);
		expect(calls[0]?.headers.get("x-api-key")).toBe("ryu_flag_key");
	});

	test("--dry-run prints curl with the key placeholder and sends nothing", async () => {
		let sent = 0;
		const run = capture(() => {
			sent += 1;
			return Promise.reject(new Error("a dry run must not send requests"));
		});
		const code = await runCli(
			[
				"messaging",
				"sms",
				"send",
				"--from",
				"num_1",
				"--to",
				"+6591234567",
				"--body",
				"Hi",
				"--dry-run",
			],
			run.io
		);
		expect(code).toBe(0);
		expect(sent).toBe(0);
		const output = run.stdout() + run.stderr();
		expect(output).toContain("curl");
		expect(output).toContain(`${BASE}/sms`);
		expect(output).toContain("$RYU_API_KEY");
		expect(output).not.toContain(ENV.RYU_API_KEY);
	});
});

async function connect(fetch: RyuFetch, readOnly = false) {
	const { server, registration } = createServicesMcpServer({
		config: { env: ENV, fetch },
		log: () => undefined,
		services: ["messaging"],
		readOnly,
	});
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "ryu-services-test", version: "1.0.0" });
	await client.connect(clientTransport);
	return { client, registration, close: () => client.close() };
}

describe("messaging_* MCP tools", () => {
	test("registers the design tools with annotations, and only reads in read-only mode", async () => {
		const { fetch } = stubFetch(messagingServer);
		const all = await connect(fetch);
		const { tools } = await all.client.listTools();
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"messaging_get_message",
			"messaging_list_messages",
			"messaging_list_numbers",
			"messaging_quote",
			"messaging_send_sms",
			"messaging_status",
		]);
		expect(
			tools.find((tool) => tool.name === "messaging_send_sms")?.annotations
		).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});
		await all.close();

		const readOnly = await connect(fetch, true);
		expect(
			(await readOnly.client.listTools()).tools.map((tool) => tool.name).sort()
		).toEqual([
			"messaging_get_message",
			"messaging_list_messages",
			"messaging_list_numbers",
			"messaging_quote",
			"messaging_status",
		]);
		await readOnly.close();
	});

	test("tools call the API end to end and send the tool's idempotency key", async () => {
		const { calls, fetch } = stubFetch(messagingServer);
		const { client, close } = await connect(fetch);

		const quote = await client.callTool({
			name: "messaging_quote",
			arguments: { to: "+6591234567", body: "Hi" },
		});
		expect(quote.isError).toBeFalsy();
		expect(
			(quote.structuredContent as { data: { quote: { segments: number } } })
				.data.quote.segments
		).toBe(1);

		const sent = await client.callTool({
			name: "messaging_send_sms",
			arguments: {
				from: "num_1",
				to: "+6591234567",
				body: "Shipped",
				idempotencyKey: "tool-send-0001",
			},
		});
		expect(sent.isError).toBeFalsy();
		const post = calls.find((call) => call.method === "POST");
		expect(post?.headers.get("idempotency-key")).toBe("tool-send-0001");
		expect(JSON.parse(post?.body ?? "{}")).toEqual({
			from: "num_1",
			to: "+6591234567",
			body: "Shipped",
		});

		const listed = await client.callTool({
			name: "messaging_list_messages",
			arguments: { direction: "outbound", limit: 1 },
		});
		expect(
			(listed.structuredContent as { data: { nextCursor: string } }).data
				.nextCursor
		).toBe("c2");
		expect(calls.at(-1)?.url).toBe(
			`${BASE}/messages?direction=outbound&limit=1`
		);

		const numbers = await client.callTool({
			name: "messaging_list_numbers",
			arguments: {},
		});
		expect(
			(numbers.structuredContent as { data: { id: string }[] }).data[0]?.id
		).toBe("num_1");
		await close();
	});

	test("send_sms requires an idempotencyKey and an E.164 recipient; refusals come back as { error }", async () => {
		const { calls, fetch } = stubFetch(messagingServer);
		const { client, close } = await connect(fetch);
		const noKey = await client.callTool({
			name: "messaging_send_sms",
			arguments: { from: "num_1", to: "+6591234567", body: "x" },
		});
		expect(noKey.isError).toBe(true);
		const badTo = await client.callTool({
			name: "messaging_send_sms",
			arguments: {
				from: "num_1",
				to: "6591234567",
				body: "x",
				idempotencyKey: "k-1",
			},
		});
		expect(badTo.isError).toBe(true);
		const tooMuchMetadata = await client.callTool({
			name: "messaging_send_sms",
			arguments: {
				from: "num_1",
				to: "+6591234567",
				body: "x",
				idempotencyKey: "k-3",
				metadata: Object.fromEntries(
					Array.from({ length: 17 }, (_, index) => [`k${index}`, "v"])
				),
			},
		});
		expect(tooMuchMetadata.isError).toBe(true);
		expect(JSON.stringify(tooMuchMetadata.content)).toContain(
			"at most 16 entries"
		);
		expect(calls).toHaveLength(0);

		const refused = await client.callTool({
			name: "messaging_send_sms",
			arguments: {
				from: "num_1",
				to: "+15555550199",
				body: "x",
				idempotencyKey: "k-2",
			},
		});
		expect(refused.isError).toBe(true);
		expect(
			(refused.structuredContent as { error: { code: string } }).error.code
		).toBe("recipient_opted_out");
		await close();
	});
});

describe("messaging_send_sms limits track the server", () => {
	test("the metadata entry cap equals MESSAGING_METADATA_MAX_ENTRIES", () => {
		const model = readFileSync(
			resolve(import.meta.dir, "../../../db/src/models/messaging.model.ts"),
			"utf8"
		);
		expect(model).toContain(
			"export const MESSAGING_METADATA_MAX_ENTRIES = 16;"
		);
		const tool = readFileSync(
			resolve(import.meta.dir, "../../../services/src/tools/messaging.ts"),
			"utf8"
		);
		expect(tool).toContain("const MESSAGING_METADATA_MAX_ENTRIES = 16;");
	});
});
