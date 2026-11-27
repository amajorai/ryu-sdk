/**
 * Mocked network for loader tests: routes by URL, records requests, and
 * resolves every host to a public documentation-free address.
 */

import type { HostLookup, LoaderFetch } from "./net.ts";

/** One recorded request. */
export interface RecordedRequest {
	body: string | undefined;
	headers: Headers;
	method: string;
	url: string;
}

/** A route answer: a Response, or a function producing one. */
export type MockRoute = Response | ((request: RecordedRequest) => Response);

/** A mocked transport for {@link NetworkOptions}. */
export interface MockNetwork {
	fetch: LoaderFetch;
	lookup: HostLookup;
	requests: RecordedRequest[];
}

/** Build a mocked network from exact-URL routes. Unknown URLs answer 404. */
export function mockNetwork(routes: Record<string, MockRoute>): MockNetwork {
	const requests: RecordedRequest[] = [];
	return {
		requests,
		lookup: () => Promise.resolve(["93.184.215.14"]),
		fetch: async (url, init) => {
			const request: RecordedRequest = {
				url,
				method: init.method ?? "GET",
				headers: new Headers(init.headers),
				body: typeof init.body === "string" ? init.body : undefined,
			};
			requests.push(request);
			const route = routes[url];
			if (!route) {
				return new Response("not found", { status: 404 });
			}
			return await Promise.resolve(
				typeof route === "function" ? route(request) : route.clone()
			);
		},
	};
}

/** A JSON response. */
export function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** A text response with a content type. */
export function textResponse(
	body: string,
	contentType: string,
	status = 200
): Response {
	return new Response(body, {
		status,
		headers: { "content-type": contentType },
	});
}
