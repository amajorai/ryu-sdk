import { describe, expect, test } from "bun:test";
import {
	createNotifyClient,
	NotifyAPI,
	type NotifyStreamItem,
} from "./notify.ts";

describe("NotifyAPI", () => {
	test("keeps the standalone API key and idempotency key separate", async () => {
		let seenUrl = "";
		let seenInit: RequestInit | undefined;
		const client = createNotifyClient({
			apiKey: "notify-secret",
			baseUrl: "https://notify.example/",
			fetch: async (input, init) => {
				seenUrl = String(input);
				seenInit = init;
				return Response.json({
					event: {
						id: "evt_1",
						title: "Deploy ready",
					},
				});
			},
		});

		const event = await client.publish(
			{ source: "deploy", title: "Deploy ready" },
			"deploy-1"
		);
		expect(seenUrl).toBe("https://notify.example/v1/events");
		const headers = new Headers(seenInit?.headers);
		expect(headers.get("authorization")).toBe("Bearer notify-secret");
		expect(headers.get("idempotency-key")).toBe("deploy-1");
		expect(event.id).toBe("evt_1");
	});

	test("publishes an ntfy-compatible text topic with metadata headers", async () => {
		let seenUrl = "";
		let seenInit: RequestInit | undefined;
		const client = new NotifyAPI({
			apiKey: "secret",
			baseUrl: "https://notify.example",
			fetch: async (input, init) => {
				seenUrl = String(input);
				seenInit = init;
				return Response.json({ event: { id: "evt_topic" } });
			},
		});
		await client.publishTopic(
			"builds/nightly",
			"Nightly is green",
			{ priority: 5, tags: ["white_check_mark", "nightly"], title: "Build" },
			"nightly-1"
		);
		expect(seenUrl).toBe("https://notify.example/v1/topics/builds%2Fnightly");
		expect(seenInit?.body).toBe("Nightly is green");
		const headers = new Headers(seenInit?.headers);
		expect(headers.get("content-type")).toContain("text/plain");
		expect(headers.get("priority")).toBe("5");
		expect(headers.get("tags")).toBe("white_check_mark,nightly");
		expect(headers.get("idempotency-key")).toBe("nightly-1");
	});

	test("parses notification and activity SSE frames", async () => {
		const encoded = new TextEncoder().encode(
			": ryu-notify\n\n" +
				'event: notification\nid: evt_1\ndata: {"id":"evt_1","title":"Ready"}\n\n' +
				'event: activity\nid: act_1\ndata: {"id":"act_1","title":"Deploy"}\n\n'
		);
		const client = new NotifyAPI({
			apiKey: "secret",
			baseUrl: "https://notify.example",
			fetch: async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(encoded);
							controller.close();
						},
					}),
					{ headers: { "content-type": "text/event-stream" } }
				),
		});
		const items: NotifyStreamItem[] = [];
		for await (const item of client.stream({ topic: "deploy" })) {
			items.push(item);
		}
		expect(items as unknown).toEqual([
			{
				event: { id: "evt_1", title: "Ready" },
				id: "evt_1",
				type: "notification",
			},
			{
				activity: { id: "act_1", title: "Deploy" },
				id: "act_1",
				type: "activity",
			},
		]);
	});
});
