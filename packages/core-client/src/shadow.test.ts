import { afterEach, describe, expect, it, mock } from "bun:test";
import { fetchTimeline } from "./shadow.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("shadow timeline client", () => {
	it("requests the trailing window through Core and returns entries", async () => {
		const fetchMock = mock(async (input: RequestInfo | URL) => {
			expect(String(input)).toMatch(
				/\/api\/shadow\/timeline\?start=\d+&end=\d+/
			);
			return new Response(
				JSON.stringify({
					entries: [
						{
							app_name: "Editor",
							event_type: "app_switch",
							track: 3,
							ts: 1,
							url: null,
							window_title: "Notes",
						},
					],
				}),
				{ status: 200 }
			);
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		await expect(
			fetchTimeline(
				{ token: "node-token", url: "http://node", userJwt: null },
				15
			)
		).resolves.toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
