// packages/core-client/src/realtime.test.ts
//
// Codec + URL tests for the realtime transport. These are the pure, deterministic
// parts (the WS lifecycle needs a live Core to verify end-to-end). The DocSync
// framing must byte-match `apps/core/src/collab` — these vectors mirror the Rust
// `docsync_framing_round_trips` test.

import { expect, test } from "bun:test";
import {
	createRealtimeClientId,
	DOC_SYNC_AWARENESS,
	DOC_SYNC_STEP1,
	DOC_SYNC_STEP2,
	DOC_SYNC_UPDATE,
	decodeDocSync,
	decodeRealtimeEvent,
	encodeDocSync,
	encodeRealtimeEvent,
	realtimeWsUrl,
} from "./realtime.ts";

test("client correlation ids are UUIDs on every supported runtime", () => {
	expect(createRealtimeClientId()).toMatch(
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
	);
});

test("application event codec round-trips and ignores other frames", () => {
	const wire = encodeRealtimeEvent({
		name: "table.snapshot",
		data: { version: 3, players: [] },
	});
	expect(decodeRealtimeEvent(wire)).toEqual({
		name: "table.snapshot",
		data: { version: 3, players: [] },
	});
	expect(decodeRealtimeEvent(JSON.stringify({ type: "presence" }))).toBeNull();
	expect(decodeRealtimeEvent("not-json")).toBeNull();
});

test("docsync framing round-trips for every tag", () => {
	for (const tag of [
		DOC_SYNC_STEP1,
		DOC_SYNC_STEP2,
		DOC_SYNC_UPDATE,
		DOC_SYNC_AWARENESS,
	] as const) {
		const payload = new Uint8Array([1, 2, 3, 4]);
		const wire = encodeDocSync({ tag, payload });
		expect(wire[0]).toBe(tag);
		expect(wire.length).toBe(payload.length + 1);

		const decoded = decodeDocSync(wire);
		expect(decoded).not.toBeNull();
		expect(decoded?.tag).toBe(tag);
		expect(Array.from(decoded?.payload ?? [])).toEqual([1, 2, 3, 4]);
	}
});

test("docsync framing carries an empty payload", () => {
	const wire = encodeDocSync({
		tag: DOC_SYNC_UPDATE,
		payload: new Uint8Array(),
	});
	expect(wire.length).toBe(1);
	const decoded = decodeDocSync(wire);
	expect(decoded?.tag).toBe(DOC_SYNC_UPDATE);
	expect(decoded?.payload.length).toBe(0);
});

test("docsync awareness frame uses tag 0x03 and round-trips", () => {
	expect(DOC_SYNC_AWARENESS).toBe(0x03);
	const payload = new Uint8Array([7, 7, 7]);
	const wire = encodeDocSync({ tag: DOC_SYNC_AWARENESS, payload });
	expect(wire[0]).toBe(0x03);
	const decoded = decodeDocSync(wire);
	expect(decoded?.tag).toBe(DOC_SYNC_AWARENESS);
	expect(Array.from(decoded?.payload ?? [])).toEqual([7, 7, 7]);
});

test("docsync decode fails closed on empty buffer and unknown tag", () => {
	expect(decodeDocSync(new Uint8Array())).toBeNull();
	expect(decodeDocSync(new Uint8Array([0xff, 1, 2]))).toBeNull();
});

test("realtimeWsUrl upgrades scheme and attaches token + jwt", () => {
	const url = realtimeWsUrl(
		{ url: "http://127.0.0.1:7980", token: "node-secret", userJwt: null },
		{ roomId: "conv_1", kind: "conversation", jwt: "user.jwt.token" }
	);
	const parsed = new URL(url);
	expect(parsed.protocol).toBe("ws:");
	expect(parsed.pathname).toBe("/api/realtime/ws");
	expect(parsed.searchParams.get("token")).toBe("node-secret");
	expect(parsed.searchParams.get("jwt")).toBe("user.jwt.token");
});

test("realtimeWsUrl uses wss for an https node and omits an absent jwt", () => {
	const url = realtimeWsUrl(
		{ url: "https://node.example.com", token: null, userJwt: null },
		{ roomId: "doc_1", kind: "document" }
	);
	const parsed = new URL(url);
	expect(parsed.protocol).toBe("wss:");
	expect(parsed.searchParams.get("token")).toBeNull();
	expect(parsed.searchParams.get("jwt")).toBeNull();
});

test("application room options carry app_id only in the join frame contract", () => {
	const wire = encodeRealtimeEvent({ name: "table.snapshot", data: null });
	expect(JSON.parse(wire)).toEqual({
		type: "event",
		event: "table.snapshot",
		data: null,
	});
	const url = realtimeWsUrl(
		{ url: "http://127.0.0.1:7980", token: "node-secret", userJwt: null },
		{
			appId: "com.example.app",
			kind: "application",
			roomId: "room_1",
		}
	);
	expect(url).not.toContain("com.example.app");
	expect(url).toContain("token=node-secret");
});
