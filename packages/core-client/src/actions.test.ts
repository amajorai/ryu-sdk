import { afterEach, expect, test } from "bun:test";
import { actionPath, callAction } from "./actions.ts";
import type { ApiTarget } from "./client.ts";

const realFetch = globalThis.fetch;
const target: ApiTarget = {
	url: "http://127.0.0.1:7980/",
	token: "node-token",
	userJwt: null,
};

afterEach(() => {
	globalThis.fetch = realFetch;
});

test("actionPath encodes action ids as one path segment", () => {
	expect(actionPath("app.support/save")).toBe(
		"/api/actions/app.support%2Fsave"
	);
});

test("callAction posts the governed action envelope", async () => {
	let capturedUrl = "";
	let capturedInit: RequestInit | undefined;
	globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
		capturedUrl = String(url);
		capturedInit = init;
		return Promise.resolve(
			Response.json({ ok: true, output: { ticketId: "t-1" } })
		);
	}) as unknown as typeof fetch;

	await expect(
		callAction(target, "app.support/save", {
			agentId: "support-agent",
			arguments: { customer: "acme" },
			userId: "alice",
		})
	).resolves.toEqual({ ok: true, output: { ticketId: "t-1" } });

	expect(capturedUrl).toBe(
		"http://127.0.0.1:7980/api/actions/app.support%2Fsave"
	);
	expect(capturedInit?.method).toBe("POST");
	expect(capturedInit?.headers).toMatchObject({
		Authorization: "Bearer node-token",
		"Content-Type": "application/json",
	});
	expect(JSON.parse(String(capturedInit?.body))).toEqual({
		agent_id: "support-agent",
		arguments: { customer: "acme" },
		user_id: "alice",
	});
});

test("callAction preserves Core denial results", async () => {
	globalThis.fetch = (() =>
		Promise.resolve(
			Response.json({ ok: false, error: "approval required" }, { status: 400 })
		)) as unknown as typeof fetch;

	await expect(
		callAction(target, "app.support/save", {
			agentId: "support-agent",
			arguments: {},
		})
	).resolves.toEqual({ ok: false, error: "approval required" });
});
