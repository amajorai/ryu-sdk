/**
 * Realtime voice sessions over Core's voice-mode socket (`/api/voice/ws`).
 *
 * Core runs the whole loop server-side — voice activity detection, speech to
 * text, the agent turn, and per-sentence text to speech — so this client only
 * moves audio and control frames:
 *
 *   up:   `start` (first frame), then PCM16 mono BINARY frames at
 *         `sampleRate`; `text`, `abort`, `end`, `ping` control frames.
 *   down: JSON control frames (`ready`, `state`, `stt`, `chat_delta`, …) and
 *         BINARY WAV frames, one per synthesized sentence.
 *
 * A WebSocket upgrade cannot carry an Authorization header, so the session
 * first exchanges the node token for a one-use ticket at `/api/ws/ticket`;
 * only that opaque ticket rides the socket URL.
 */

import { z } from "zod";

/** Default PCM16 sample rate sent to Core (its VAD and STT run at 16 kHz). */
export const REALTIME_DEFAULT_SAMPLE_RATE = 16_000;
const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_END_TIMEOUT_MS = 10_000;

/** Minimal socket surface the session needs; inject one for tests or custom runtimes. */
export interface VoiceSocket {
	close(code?: number, reason?: string): void;
	onClose(listener: (code: number, reason: string) => void): void;
	onError(listener: () => void): void;
	onMessage(
		listener: (data: ArrayBuffer | Blob | Uint8Array | string) => void
	): void;
	onOpen(listener: () => void): void;
	send(data: ArrayBuffer | Uint8Array | string): void;
}

/** Create a socket for a `ws(s)://` URL. */
export type VoiceSocketFactory = (url: string) => VoiceSocket;

/** Options for a realtime voice session. */
export interface RealtimeVoiceOptions {
	/** Run turns as this Core agent (defaults to the SDK agent's `agentId`). */
	agentId?: string;
	/**
	 * Set `false` for a speaker who is not the node owner: every turn then runs
	 * under Core's untrusted-caller tool profile. It can only restrict.
	 */
	callerTrusted?: boolean;
	/** Persist turns into an existing conversation (ephemeral when omitted). */
	conversationId?: string;
	/** Called for every event, in addition to async iteration. */
	onEvent?: (event: RealtimeVoiceEvent) => void;
	/** How long to wait for Core's `ready` frame. */
	readyTimeoutMs?: number;
	/** Sample rate (Hz) of the PCM16 frames you will send (default 16000). */
	sampleRate?: number;
	signal?: AbortSignal;
	/** Core speech-to-text engine hint. */
	sttEngine?: string;
	/** Core text-to-speech engine hint. */
	ttsEngine?: string;
	/** Text-to-speech voice id. */
	ttsVoice?: string;
	/** Socket factory; defaults to the runtime's global `WebSocket`. */
	webSocket?: VoiceSocketFactory;
}

const stateSchema = z.enum(["idle", "listening", "thinking", "speaking"]);

const serverMessageSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("ready"),
		session_id: z.string(),
		tts_sample_rate: z.number().int().positive(),
	}),
	z.object({ type: z.literal("state"), value: stateSchema }),
	z.object({ type: z.literal("speech_start") }),
	z.object({ type: z.literal("stt"), text: z.string(), final: z.boolean() }),
	z.object({ type: z.literal("chat_delta"), text: z.string() }),
	z.object({ type: z.literal("chat_end"), conversation_id: z.string() }),
	z.object({
		type: z.literal("call_ended"),
		conversationId: z.string(),
		messageId: z.string(),
		durationSeconds: z.number().int().nonnegative(),
		content: z.string(),
	}),
	z.object({ type: z.literal("stop_playback") }),
	z.object({ type: z.literal("tts_start") }),
	z.object({ type: z.literal("tts_end") }),
	z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
	z.object({ type: z.literal("pong") }),
]);

/** The summary Core persists when a call ends. */
export interface RealtimeCallSummary {
	content: string;
	conversationId: string;
	durationSeconds: number;
	messageId: string;
}

/** Everything a realtime session reports. */
export type RealtimeVoiceEvent =
	| { sessionId: string; ttsSampleRate: number; type: "ready" }
	| { type: "state"; value: z.output<typeof stateSchema> }
	| { type: "speech_start" }
	| { final: boolean; text: string; type: "transcript" }
	| { text: string; type: "reply_delta" }
	| { conversationId: string; type: "reply_end" }
	| ({ type: "call_ended" } & RealtimeCallSummary)
	| { type: "stop_playback" }
	| { type: "audio_start" }
	| { audio: Uint8Array; type: "audio" }
	| { type: "audio_end" }
	| { code: string; message: string; type: "error" }
	| { type: "pong" }
	| { code: number; reason: string; type: "closed" };

/** Map one parsed RVP control frame to a session event. */
function toEvent(
	message: z.output<typeof serverMessageSchema>
): RealtimeVoiceEvent {
	switch (message.type) {
		case "ready":
			return {
				type: "ready",
				sessionId: message.session_id,
				ttsSampleRate: message.tts_sample_rate,
			};
		case "stt":
			return { type: "transcript", text: message.text, final: message.final };
		case "chat_delta":
			return { type: "reply_delta", text: message.text };
		case "chat_end":
			return { type: "reply_end", conversationId: message.conversation_id };
		case "tts_start":
			return { type: "audio_start" };
		case "tts_end":
			return { type: "audio_end" };
		default:
			return message;
	}
}

function trimBase(url: string): string {
	return url.replace(/\/+$/, "");
}

const ticketSchema = z.object({ ticket: z.string().trim().min(1) });

/** Exchange the node token for a one-use voice WebSocket ticket. */
async function requestVoiceTicket(
	core: { baseUrl: string; token?: string },
	conversationId: string | undefined,
	signal?: AbortSignal
): Promise<string> {
	const body: Record<string, string> = { route: "voice" };
	if (conversationId) {
		body.roomId = conversationId;
	}
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (core.token) {
		headers.Authorization = `Bearer ${core.token}`;
	}
	const response = await fetch(`${trimBase(core.baseUrl)}/api/ws/ticket`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal,
	});
	if (!response.ok) {
		throw new Error(`voice ticket request failed: ${response.status}`);
	}
	const parsed = ticketSchema.safeParse(await response.json());
	if (!parsed.success) {
		throw new Error("Core returned an invalid WebSocket ticket");
	}
	return parsed.data.ticket;
}

/** Build the credential-free socket URL carrying only the ticket. */
export function realtimeVoiceUrl(coreBaseUrl: string, ticket: string): string {
	const url = new URL(`${trimBase(coreBaseUrl)}/api/voice/ws`);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.searchParams.set("ticket", ticket);
	return url.toString();
}

/** Wrap the runtime's global `WebSocket` in the {@link VoiceSocket} surface. */
export function globalVoiceSocket(url: string): VoiceSocket {
	const Socket = globalThis.WebSocket;
	if (!Socket) {
		throw new Error(
			"this runtime has no global WebSocket; pass `webSocket` to realtime()"
		);
	}
	const socket = new Socket(url);
	socket.binaryType = "arraybuffer";
	return {
		send: (data) => socket.send(data),
		close: (code, reason) => socket.close(code, reason),
		onOpen: (listener) => socket.addEventListener("open", () => listener()),
		onMessage: (listener) =>
			socket.addEventListener("message", (event) => listener(event.data)),
		onClose: (listener) =>
			socket.addEventListener("close", (event) =>
				listener(event.code, event.reason)
			),
		onError: (listener) => socket.addEventListener("error", () => listener()),
	};
}

/** A live realtime voice session. Iterate it for events. */
export class RealtimeVoiceSession implements AsyncIterable<RealtimeVoiceEvent> {
	/** Core's voice session id. */
	sessionId = "";
	/** Sample rate of the WAV audio Core sends back. */
	ttsSampleRate = 0;
	private readonly socket: VoiceSocket;
	private readonly onEvent?: (event: RealtimeVoiceEvent) => void;
	private readonly queue: RealtimeVoiceEvent[] = [];
	private readonly waiters: Array<
		(result: IteratorResult<RealtimeVoiceEvent>) => void
	> = [];
	private readonly listeners = new Set<(event: RealtimeVoiceEvent) => void>();
	private closed = false;

	/** @internal Use `agent.voice.realtime()` or {@link openRealtimeVoice}. */
	constructor(
		socket: VoiceSocket,
		onEvent?: (event: RealtimeVoiceEvent) => void
	) {
		this.socket = socket;
		this.onEvent = onEvent;
	}

	/** Whether the socket has closed. */
	get isClosed(): boolean {
		return this.closed;
	}

	/** @internal Deliver an event to iterators, listeners, and `onEvent`. */
	dispatch(event: RealtimeVoiceEvent) {
		if (this.closed) {
			return;
		}
		if (event.type === "ready") {
			this.sessionId = event.sessionId;
			this.ttsSampleRate = event.ttsSampleRate;
		}
		// Queue first so a listener that closes the session (see `end`) cannot
		// reorder this event behind the resulting `closed` event.
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter({ value: event, done: false });
		} else {
			this.queue.push(event);
		}
		if (event.type === "closed") {
			this.closed = true;
			for (const pending of this.waiters.splice(0)) {
				pending({ value: undefined, done: true });
			}
		}
		this.onEvent?.(event);
		for (const listener of [...this.listeners]) {
			listener(event);
		}
	}

	/** Subscribe to events; returns an unsubscribe function. */
	subscribe(listener: (event: RealtimeVoiceEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	[Symbol.asyncIterator](): AsyncIterator<RealtimeVoiceEvent> {
		return {
			next: () => {
				const event = this.queue.shift();
				if (event) {
					return Promise.resolve({ value: event, done: false });
				}
				if (this.closed) {
					return Promise.resolve({ value: undefined, done: true });
				}
				return new Promise((resolve) => {
					this.waiters.push(resolve);
				});
			},
		};
	}

	private sendControl(message: Record<string, string>) {
		if (this.closed) {
			throw new Error("realtime voice session is closed");
		}
		this.socket.send(JSON.stringify(message));
	}

	/** Stream one frame of little-endian PCM16 mono audio at the session's sample rate. */
	sendAudio(pcm16: ArrayBuffer | Int16Array | Uint8Array) {
		if (this.closed) {
			throw new Error("realtime voice session is closed");
		}
		if (pcm16 instanceof ArrayBuffer) {
			this.socket.send(pcm16);
			return;
		}
		this.socket.send(
			new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength)
		);
	}

	/** Run a turn from typed text instead of speech. */
	sendText(content: string) {
		this.sendControl({ type: "text", content });
	}

	/** Stop the in-flight reply and its audio now (manual barge-in). */
	interrupt() {
		this.sendControl({ type: "abort" });
	}

	/** Liveness probe; Core answers with a `pong` event. */
	ping() {
		this.sendControl({ type: "ping" });
	}

	/**
	 * End the call. Resolves with the summary Core persisted, or `undefined`
	 * when the socket closed (or `timeoutMs` passed) without one.
	 */
	end(
		timeoutMs = DEFAULT_END_TIMEOUT_MS
	): Promise<RealtimeCallSummary | undefined> {
		if (this.closed) {
			return Promise.resolve(undefined);
		}
		return new Promise((resolve) => {
			let settled = false;
			const finish = (summary?: RealtimeCallSummary) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				unsubscribe();
				this.close();
				resolve(summary);
			};
			const unsubscribe = this.subscribe((event) => {
				if (event.type === "call_ended") {
					finish({
						content: event.content,
						conversationId: event.conversationId,
						durationSeconds: event.durationSeconds,
						messageId: event.messageId,
					});
				} else if (event.type === "closed") {
					finish();
				}
			});
			const timer = setTimeout(() => finish(), timeoutMs);
			this.sendControl({ type: "end" });
		});
	}

	/** Close the socket. */
	close() {
		if (this.closed) {
			return;
		}
		this.socket.close(1000, "client closed");
		this.dispatch({ type: "closed", code: 1000, reason: "client closed" });
	}
}

/** Decode one inbound frame into an event (binary frames are WAV audio). */
async function decodeFrame(
	data: ArrayBuffer | Blob | Uint8Array | string
): Promise<RealtimeVoiceEvent> {
	if (typeof data === "string") {
		let raw: unknown;
		try {
			raw = JSON.parse(data);
		} catch {
			return {
				type: "error",
				code: "invalid_frame",
				message: "non-JSON control frame",
			};
		}
		const parsed = serverMessageSchema.safeParse(raw);
		return parsed.success
			? toEvent(parsed.data)
			: {
					type: "error",
					code: "invalid_frame",
					message: "unknown control frame",
				};
	}
	if (data instanceof Uint8Array) {
		return { type: "audio", audio: data };
	}
	if (data instanceof ArrayBuffer) {
		return { type: "audio", audio: new Uint8Array(data) };
	}
	return { type: "audio", audio: new Uint8Array(await data.arrayBuffer()) };
}

/**
 * Open a realtime voice session against a Core node. Resolves once Core
 * acknowledges the `start` frame with `ready`.
 */
export async function openRealtimeVoice(
	core: { baseUrl: string; token?: string },
	options: RealtimeVoiceOptions = {}
): Promise<RealtimeVoiceSession> {
	const ticket = await requestVoiceTicket(
		core,
		options.conversationId,
		options.signal
	);
	const socket = (options.webSocket ?? globalVoiceSocket)(
		realtimeVoiceUrl(core.baseUrl, ticket)
	);
	const session = new RealtimeVoiceSession(socket, options.onEvent);
	const start: Record<string, boolean | number | string> = {
		type: "start",
		sample_rate: options.sampleRate ?? REALTIME_DEFAULT_SAMPLE_RATE,
	};
	if (options.conversationId) {
		start.conversation_id = options.conversationId;
	}
	if (options.agentId) {
		start.agent_id = options.agentId;
	}
	if (options.sttEngine) {
		start.stt_engine = options.sttEngine;
	}
	if (options.ttsEngine) {
		start.tts_engine = options.ttsEngine;
	}
	if (options.ttsVoice) {
		start.tts_voice = options.ttsVoice;
	}
	if (options.callerTrusted === false) {
		start.caller_trusted = false;
	}

	return await new Promise<RealtimeVoiceSession>((resolve, reject) => {
		let ready = false;
		// Frames decode in arrival order even when a Blob needs async reading.
		let chain = Promise.resolve();
		const fail = (error: Error) => {
			if (ready) {
				return;
			}
			ready = true;
			clearTimeout(timer);
			socket.close(1000, "setup failed");
			reject(error);
		};
		const timer = setTimeout(
			() =>
				fail(new Error("timed out waiting for Core's realtime voice session")),
			options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
		);
		options.signal?.addEventListener("abort", () => {
			if (ready) {
				session.close();
			} else {
				fail(new Error("realtime voice session aborted"));
			}
		});
		socket.onOpen(() => socket.send(JSON.stringify(start)));
		socket.onMessage((data) => {
			chain = chain.then(async () => {
				const event = await decodeFrame(data);
				if (!ready && event.type === "error") {
					fail(new Error(`${event.code}: ${event.message}`));
					return;
				}
				session.dispatch(event);
				if (!ready && event.type === "ready") {
					ready = true;
					clearTimeout(timer);
					resolve(session);
				}
			});
		});
		socket.onError(() => fail(new Error("realtime voice socket error")));
		socket.onClose((code, reason) => {
			chain = chain.then(() => {
				fail(new Error(`realtime voice socket closed (${code})`));
				session.dispatch({ type: "closed", code, reason });
			});
		});
	});
}
