import { afterEach, describe, expect, test } from "bun:test";
import { MailAPI } from "./mail.ts";
import { installFetch } from "./test-fetch.ts";

const options = { baseUrl: "http://node.example", token: "node-token" };
const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("MailAPI", () => {
	test("normalizes sidecar inbox and message fields", async () => {
		installFetch(() =>
			Promise.resolve(
				Response.json({
					inboxes: [
						{
							address: "agent@example.com",
							created_at: "now",
							id: "in-1",
							name: "Agent",
							provider: "webhook",
						},
					],
				})
			)
		);
		const inboxes = await new MailAPI(options).listInboxes();
		expect(inboxes[0]).toMatchObject({
			id: "in-1",
			address: "agent@example.com",
			clientId: null,
		});
	});

	test("sends attachments in the sidecar-compatible wire shape", async () => {
		let body = "";
		installFetch((_url, init) => {
			body = String(init?.body);
			return Promise.resolve(
				Response.json({
					message: {
						id: "msg-1",
						inbox_id: "in-1",
						to_addrs: [],
						attachments: [],
					},
				})
			);
		});
		await new MailAPI(options).send("in-1", {
			attachments: [
				{
					contentBase64: "AQI=",
					contentId: "cid-1",
					contentType: "application/octet-stream",
					filename: "a.bin",
				},
			],
			references: ["<root@example.com>"],
			subject: "Report",
			text: "body",
			to: ["person@example.com"],
		});
		const sent = JSON.parse(body) as Record<string, unknown>;
		expect(sent.references).toBe("<root@example.com>");
		expect(sent.attachments).toEqual([
			{
				content: "AQI=",
				content_id: "cid-1",
				content_type: "application/octet-stream",
				filename: "a.bin",
			},
		]);
	});
});
