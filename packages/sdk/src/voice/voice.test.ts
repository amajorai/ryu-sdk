/**
 * `agent.voice` over a mocked transport: Gateway and Core speech routes are
 * served by a stubbed `globalThis.fetch`, and the realtime socket by an
 * in-memory `VoiceSocket`. Live provider round-trips are not exercised here.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "../agent/agent.ts";
import type { RealtimeVoiceEvent, VoiceSocket } from "./realtime.ts";
import { AgentVoice } from "./voice.ts";

const GATEWAY = "http://127.0.0.1:7981";
const CORE = "http://127.0.0.1:7980";

interface Captured {
	body: BodyInit | null | undefined;
	headers: Headers;
	method: string;
	url: URL;
}

let captured: Captured[] = [];
let respond: (url: URL) => Response = () =>
	new Response("missing", { status: 404 });
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
	captured = [];
	originalFetch = globalThis.fetch;
	globalThis.fetch = Object.assign(
		(
			input: Parameters<typeof globalThis.fetch>[0],
			init?: Parameters<typeof globalThis.fetch>[1]
		) => {
			const url = new URL(String(input));
			captured.push({
				url,
				method: init?.method ?? "GET",
				headers: new Headers(init?.headers),
				body: init?.body,
			});
			return Promise.resolve(respond(url));
		},
		{ preconnect: originalFetch.preconnect }
	);
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function agent(voice: ConstructorParameters<typeof Agent>[0]["voice"] = {}) {
	return new Agent({
		name: "voice",
		model: "gpt-4o",
		agentId: "agent-7",
		node: { baseUrl: GATEWAY, token: "gw-token" },
		core: { baseUrl: CORE, token: "core-token" },
		voice,
	});
}

describe("agent.voice.speak", () => {
	it("routes a model id through the Gateway speech endpoint", async () => {
		respond = () =>
			new Response(new Uint8Array([1, 2, 3]), {
				headers: { "Content-Type": "audio/mpeg" },
			});
		const result = await agent({
			speechModel: "openai/gpt-4o-mini-tts",
			voice: "alloy",
		}).voice.speak("Hello", {
			format: "mp3",
			instructions: "warm",
			speed: 1.1,
		});
		expect(result.via).toBe("gateway");
		expect(result.mimeType).toBe("audio/mpeg");
		expect(new Uint8Array(await result.audio.arrayBuffer())).toEqual(
			new Uint8Array([1, 2, 3])
		);
		const call = captured[0];
		expect(call?.url.toString()).toBe(`${GATEWAY}/v1/audio/speech`);
		expect(call?.headers.get("authorization")).toBe("Bearer gw-token");
		expect(call?.headers.get("x-ryu-agent-id")).toBe("agent-7");
		expect(JSON.parse(String(call?.body))).toEqual({
			model: "openai/gpt-4o-mini-tts",
			input: "Hello",
			response_format: "mp3",
			voice: "alloy",
			instructions: "warm",
			speed: 1.1,
		});
	});

	it("uses Core's local engines when no model is configured", async () => {
		respond = () =>
			new Response(new Uint8Array([9]), {
				headers: { "Content-Type": "audio/x-wav" },
			});
		const result = await agent({
			ttsEngine: "kokoro",
			voice: "af_heart",
		}).voice.speak("Hi", { language: "en" });
		expect(result).toMatchObject({ via: "core", mimeType: "audio/wav" });
		const call = captured[0];
		expect(call?.url.toString()).toBe(`${CORE}/api/voice/speak`);
		expect(call?.headers.get("authorization")).toBe("Bearer core-token");
		expect(JSON.parse(String(call?.body))).toEqual({
			text: "Hi",
			engine: "kokoro",
			voice: "af_heart",
			language: "en",
		});
	});

	it("reports node errors and refuses unsupported formats and empty text", async () => {
		respond = () =>
			Response.json(
				{ error: { message: "no speech provider" } },
				{ status: 503 }
			);
		const voice = agent({ speechModel: "openai/tts-1" }).voice;
		await expect(voice.speak("x")).rejects.toThrow(
			"speech failed: no speech provider"
		);
		await expect(voice.speak("x", { format: "ogg" })).rejects.toThrow(
			"cannot produce ogg"
		);
		await expect(voice.speak("  ")).rejects.toThrow("non-empty text");
		await expect(agent().voice.speak("x", { format: "pcm" })).rejects.toThrow(
			"local speech engines cannot produce pcm"
		);
		respond = () =>
			new Response("x", { headers: { "Content-Type": "text/html" } });
		await expect(agent().voice.speak("x")).rejects.toThrow(
			"unsupported audio type"
		);
	});

	it("refuses a direct provider URL as the gateway", async () => {
		const voice = new AgentVoice(
			{ speechModel: "openai/tts-1" },
			{
				gateway: { baseUrl: "https://api.openai.com" },
				core: { baseUrl: CORE },
			}
		);
		await expect(voice.speak("x")).rejects.toThrow();
		expect(captured).toHaveLength(0);
	});
});

describe("agent.voice.listen", () => {
	it("uploads to the Gateway transcription endpoint with a model id", async () => {
		respond = () =>
			Response.json({
				text: " hello world ",
				language: "en",
				duration: 1.5,
				segments: [{ start: 0, end: 1.25, text: " hello world" }],
			});
		const result = await agent({
			transcriptionModel: "openai/whisper-1",
		}).voice.listen(
			new Blob([new Uint8Array([1, 2])], { type: "audio/webm" }),
			{ timestamps: true, prompt: "Ryu", language: "en" }
		);
		expect(result).toEqual({
			text: "hello world",
			language: "en",
			durationMs: 1500,
			segments: [{ startMs: 0, endMs: 1250, text: "hello world" }],
			via: "gateway",
		});
		const call = captured[0];
		expect(call?.url.toString()).toBe(`${GATEWAY}/v1/audio/transcriptions`);
		expect(call?.headers.get("x-ryu-agent-id")).toBe("agent-7");
		const form = call?.body;
		if (!(form instanceof FormData)) {
			throw new Error("expected multipart body");
		}
		expect(form.get("model")).toBe("openai/whisper-1");
		expect(form.get("response_format")).toBe("verbose_json");
		expect(form.getAll("timestamp_granularities[]")).toEqual(["segment"]);
		expect(form.get("prompt")).toBe("Ryu");
		const file = form.get("file");
		expect(file instanceof File && file.name).toBe("audio.webm");
	});

	it("uses Core's transcription engine without a model", async () => {
		respond = () =>
			Response.json({
				text: "local text",
				segments: [{ startMs: 0, endMs: 900, text: "local text " }],
				words: [{ startMs: 0, endMs: 400, text: "local" }],
			});
		const result = await agent({ sttEngine: "parakeet" }).voice.listen(
			new Uint8Array([1, 2, 3])
		);
		expect(result).toEqual({
			text: "local text",
			segments: [{ startMs: 0, endMs: 900, text: "local text" }],
			words: [{ startMs: 0, endMs: 400, text: "local" }],
			via: "core",
		});
		expect(captured[0]?.url.toString()).toBe(
			`${CORE}/api/voice/transcribe?engine=parakeet`
		);
		const form = captured[0]?.body;
		const file = form instanceof FormData ? form.get("file") : null;
		expect(file instanceof File && file.name).toBe("audio.wav");
	});

	it("rejects empty audio and invalid responses", async () => {
		await expect(agent().voice.listen(new Uint8Array())).rejects.toThrow(
			"non-empty audio"
		);
		respond = () => Response.json({ nope: true });
		await expect(agent().voice.listen(new Uint8Array([1]))).rejects.toThrow(
			"invalid response"
		);
	});
});

class FakeSocket implements VoiceSocket {
	readonly sent: Array<ArrayBuffer | Uint8Array | string> = [];
	closedWith?: number;
	private open?: () => void;
	private message?: (data: ArrayBuffer | Blob | Uint8Array | string) => void;
	private closeListener?: (code: number, reason: string) => void;
	onOpen(listener: () => void) {
		this.open = listener;
	}
	onMessage(
		listener: (data: ArrayBuffer | Blob | Uint8Array | string) => void
	) {
		this.message = listener;
	}
	onClose(listener: (code: number, reason: string) => void) {
		this.closeListener = listener;
	}
	onError() {
		// The fake never errors.
	}
	send(data: ArrayBuffer | Uint8Array | string) {
		this.sent.push(data);
		if (typeof data === "string" && JSON.parse(data).type === "end") {
			this.server({
				type: "call_ended",
				conversationId: "c1",
				messageId: "m1",
				durationSeconds: 3,
				content: "Call ended · 00:03",
			});
		}
	}
	close(code?: number) {
		this.closedWith = code;
		this.closeListener?.(code ?? 1000, "");
	}
	connect() {
		this.open?.();
	}
	server(frame: Record<string, unknown> | Uint8Array) {
		this.message?.(frame instanceof Uint8Array ? frame : JSON.stringify(frame));
	}
}

describe("agent.voice.realtime", () => {
	it("exchanges a ticket, sends start, and streams events both ways", async () => {
		respond = () => Response.json({ ticket: "tkt-1", expires_in: 30 });
		const socket = new FakeSocket();
		let socketUrl = "";
		const seen: RealtimeVoiceEvent["type"][] = [];
		const opening = agent({
			sttEngine: "whisper",
			ttsEngine: "kokoro",
			voice: "v1",
		}).voice.realtime({
			conversationId: "conv-1",
			sampleRate: 48_000,
			callerTrusted: false,
			onEvent: (event) => seen.push(event.type),
			webSocket: (url) => {
				socketUrl = url;
				queueMicrotask(() => {
					socket.connect();
					socket.server({
						type: "ready",
						session_id: "vs-1",
						tts_sample_rate: 24_000,
					});
				});
				return socket;
			},
		});
		const session = await opening;
		expect(session.sessionId).toBe("vs-1");
		expect(session.ttsSampleRate).toBe(24_000);
		expect(socketUrl).toBe("ws://127.0.0.1:7980/api/voice/ws?ticket=tkt-1");
		expect(captured[0]?.url.toString()).toBe(`${CORE}/api/ws/ticket`);
		expect(captured[0]?.headers.get("authorization")).toBe("Bearer core-token");
		expect(JSON.parse(String(captured[0]?.body))).toEqual({
			route: "voice",
			roomId: "conv-1",
		});
		expect(JSON.parse(String(socket.sent[0]))).toEqual({
			type: "start",
			sample_rate: 48_000,
			conversation_id: "conv-1",
			agent_id: "agent-7",
			stt_engine: "whisper",
			tts_engine: "kokoro",
			tts_voice: "v1",
			caller_trusted: false,
		});

		session.sendAudio(new Int16Array([1, -1]));
		session.sendText("hello");
		session.interrupt();
		expect(socket.sent[1]).toEqual(new Uint8Array([1, 0, 255, 255]));
		expect(socket.sent.slice(2)).toEqual([
			'{"type":"text","content":"hello"}',
			'{"type":"abort"}',
		]);

		socket.server({ type: "stt", text: "hello", final: true });
		socket.server({ type: "chat_delta", text: "Hi" });
		socket.server({ type: "tts_start" });
		socket.server(new Uint8Array([82, 73, 70, 70]));
		socket.server({ type: "tts_end" });
		socket.server({ type: "chat_end", conversation_id: "conv-1" });
		const summary = await session.end();
		expect(summary).toEqual({
			content: "Call ended · 00:03",
			conversationId: "c1",
			durationSeconds: 3,
			messageId: "m1",
		});
		expect(session.isClosed).toBe(true);

		const events: RealtimeVoiceEvent[] = [];
		for await (const event of session) {
			events.push(event);
		}
		expect(events.map((event) => event.type)).toEqual([
			"ready",
			"transcript",
			"reply_delta",
			"audio_start",
			"audio",
			"audio_end",
			"reply_end",
			"call_ended",
			"closed",
		]);
		expect(events[4]).toEqual({
			type: "audio",
			audio: new Uint8Array([82, 73, 70, 70]),
		});
		expect(seen).toEqual(events.map((event) => event.type));
		expect(() => session.sendText("late")).toThrow("closed");
	});

	it("rejects when Core answers start with an error frame", async () => {
		respond = () => Response.json({ ticket: "tkt-2" });
		const socket = new FakeSocket();
		await expect(
			agent().voice.realtime({
				webSocket: () => {
					queueMicrotask(() => {
						socket.connect();
						socket.server({
							type: "error",
							code: "stt_unavailable",
							message: "no engine",
						});
					});
					return socket;
				},
			})
		).rejects.toThrow("stt_unavailable: no engine");
		expect(socket.closedWith).toBe(1000);
	});

	it("fails before connecting when the ticket exchange is refused", async () => {
		respond = () => new Response("nope", { status: 401 });
		await expect(
			agent().voice.realtime({
				webSocket: () => {
					throw new Error("must not connect");
				},
			})
		).rejects.toThrow("voice ticket request failed: 401");
	});
});
