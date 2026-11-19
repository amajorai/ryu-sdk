/**
 * `AgentVoice` — speech for SDK agents (`agent.voice.speak/listen/realtime`).
 *
 * Every call goes to the agent's own Ryu node, never to a speech provider:
 *
 * - With a `speechModel` / `transcriptionModel`, `speak` and `listen` use the
 *   Gateway's OpenAI-compatible `/v1/audio/speech` and
 *   `/v1/audio/transcriptions`. The Gateway routes the model id to whichever
 *   provider key the node holds and applies its budgets and guardrails.
 * - Without a model, they use Core's local speech engines
 *   (`/api/voice/speak`, `/api/voice/transcribe`), optionally pinned with
 *   `ttsEngine` / `sttEngine`.
 * - `realtime()` opens Core's realtime voice-mode socket (`/api/voice/ws`).
 *
 * Both base URLs pass the SDK's direct-provider egress check before any
 * request, so a provider URL cannot be configured here by mistake.
 */

import { z } from "zod";
import { assertAllowedEgressUrl } from "../model/gateway.ts";
import {
	openRealtimeVoice,
	type RealtimeVoiceOptions,
	type RealtimeVoiceSession,
} from "./realtime.ts";

/** Audio formats the Gateway speech route accepts. */
export const GATEWAY_SPEECH_FORMATS = [
	"mp3",
	"wav",
	"aac",
	"flac",
	"opus",
	"pcm",
] as const;
/** Audio formats Core's local speech route can encode. */
export const CORE_SPEECH_FORMATS = ["wav", "mp3", "ogg", "flac"] as const;

export type SpeechFormat =
	| (typeof CORE_SPEECH_FORMATS)[number]
	| (typeof GATEWAY_SPEECH_FORMATS)[number];

/** Voice defaults for an agent (`AgentConfig.voice`). */
export interface AgentVoiceConfig {
	/** Default output format (`wav` unless set). */
	format?: SpeechFormat;
	/** Language hint for transcription and multilingual speech engines. */
	language?: string;
	/** Gateway model id for `speak` (for example `openai/gpt-4o-mini-tts`). */
	speechModel?: string;
	/** Core speech-to-text engine when no `transcriptionModel` is set. */
	sttEngine?: string;
	/** Gateway model id for `listen` (for example `openai/whisper-1`). */
	transcriptionModel?: string;
	/** Core text-to-speech engine when no `speechModel` is set. */
	ttsEngine?: string;
	/** Default voice id (provider- or engine-specific). */
	voice?: string;
}

/** A node endpoint (base URL + optional bearer token). */
export interface VoiceEndpoint {
	baseUrl: string;
	token?: string;
}

/** Where an `AgentVoice` sends its requests. */
export interface AgentVoiceTarget {
	/** Core agent id; sent to the Gateway for per-agent speech routing. */
	agentId?: string;
	core: VoiceEndpoint;
	gateway: VoiceEndpoint;
}

/** Per-call options for {@link AgentVoice.speak}. */
export interface SpeakOptions {
	/** Core engine override (local route only). */
	engine?: string;
	format?: SpeechFormat;
	/** Delivery instructions ("calm, slow") for models/engines that take them. */
	instructions?: string;
	language?: string;
	/** Gateway model override; set it to force the Gateway route. */
	model?: string;
	signal?: AbortSignal;
	speed?: number;
	voice?: string;
}

/** Synthesized audio. */
export interface SpeechResult {
	audio: Blob;
	/** MIME type of `audio`. */
	mimeType: string;
	/** Which node service produced it. */
	via: "core" | "gateway";
}

/** Audio accepted by {@link AgentVoice.listen}. */
export type VoiceAudioInput = ArrayBuffer | Blob | Uint8Array;

/** Per-call options for {@link AgentVoice.listen}. */
export interface ListenOptions {
	/** Core engine override (local route only). */
	engine?: string;
	/** Upload filename; its extension tells the node the container (default by MIME, else `audio.wav`). */
	filename?: string;
	language?: string;
	/** Gateway model override; set it to force the Gateway route. */
	model?: string;
	/** Prompt / vocabulary hint (Gateway route). */
	prompt?: string;
	signal?: AbortSignal;
	/** Request segment timestamps (Gateway `verbose_json`; Core always returns them). */
	timestamps?: boolean;
}

/** One timed piece of a transcript, in milliseconds. */
export interface TranscriptSegment {
	endMs: number;
	startMs: number;
	text: string;
}

/** A transcript. */
export interface TranscriptionResult {
	durationMs?: number;
	language?: string;
	segments: TranscriptSegment[];
	text: string;
	via: "core" | "gateway";
	words?: TranscriptSegment[];
}

const MIME_BY_FORMAT: Record<SpeechFormat, string> = {
	aac: "audio/aac",
	flac: "audio/flac",
	mp3: "audio/mpeg",
	ogg: "audio/ogg",
	opus: "audio/ogg",
	pcm: "audio/pcm",
	wav: "audio/wav",
};

const AUDIO_MIME: Readonly<Record<string, string>> = {
	"audio/wav": "audio/wav",
	"audio/x-wav": "audio/wav",
	"audio/wave": "audio/wav",
	"audio/mpeg": "audio/mpeg",
	"audio/mp3": "audio/mpeg",
	"audio/ogg": "audio/ogg",
	"audio/opus": "audio/ogg",
	"audio/flac": "audio/flac",
	"audio/x-flac": "audio/flac",
	"audio/aac": "audio/aac",
	"audio/pcm": "audio/pcm",
	"audio/l16": "audio/pcm",
};

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
	"audio/wav": "wav",
	"audio/x-wav": "wav",
	"audio/wave": "wav",
	"audio/mpeg": "mp3",
	"audio/mp3": "mp3",
	"audio/mp4": "m4a",
	"audio/m4a": "m4a",
	"audio/x-m4a": "m4a",
	"audio/ogg": "ogg",
	"audio/webm": "webm",
	"audio/flac": "flac",
	"audio/x-flac": "flac",
};

const errorBodySchema = z.union([
	z.object({ error: z.string() }),
	z.object({ error: z.object({ message: z.string() }) }),
	z.object({ message: z.string() }),
]);

async function failure(response: Response, what: string): Promise<Error> {
	const fallback = `${what} failed: ${response.status}`;
	try {
		const parsed = errorBodySchema.safeParse(await response.json());
		if (!parsed.success) {
			return new Error(fallback);
		}
		const body = parsed.data;
		if ("message" in body) {
			return new Error(`${what} failed: ${body.message}`);
		}
		return new Error(
			`${what} failed: ${typeof body.error === "string" ? body.error : body.error.message}`
		);
	} catch {
		return new Error(fallback);
	}
}

function trimBase(url: string): string {
	return url.replace(/\/+$/, "");
}

function bearer(token?: string): Record<string, string> {
	return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Map a response Content-Type to a playable audio MIME, or null when unknown. */
export function speechMimeType(contentType: string | null): string | null {
	const base = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
	return AUDIO_MIME[base] ?? null;
}

function toBlob(audio: VoiceAudioInput): Blob {
	if (audio instanceof Blob) {
		return audio;
	}
	const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio);
	// Copy into a fresh ArrayBuffer so a SharedArrayBuffer view is never wrapped.
	return new Blob([new Uint8Array(bytes)]);
}

function uploadFilename(audio: VoiceAudioInput, filename?: string): string {
	if (filename) {
		return filename;
	}
	const mime =
		audio instanceof Blob ? audio.type.split(";")[0]?.trim().toLowerCase() : "";
	return `audio.${EXTENSION_BY_MIME[mime ?? ""] ?? "wav"}`;
}

const gatewayTranscriptSchema = z.object({
	text: z.string(),
	language: z.string().optional(),
	duration: z.number().nonnegative().optional(),
	segments: z
		.array(z.object({ start: z.number(), end: z.number(), text: z.string() }))
		.optional(),
	words: z
		.array(z.object({ start: z.number(), end: z.number(), word: z.string() }))
		.optional(),
});

const coreSpanSchema = z.object({
	startMs: z.number().int().nonnegative(),
	endMs: z.number().int().nonnegative(),
	text: z.string(),
});
const coreTranscriptSchema = z.object({
	text: z.string(),
	segments: z.array(coreSpanSchema).default(() => []),
	words: z.array(coreSpanSchema).optional(),
});

function seconds(value: number): number {
	return Math.round(value * 1000);
}

/** Speech for one agent. Construct through `agent.voice`. */
export class AgentVoice {
	readonly config: AgentVoiceConfig;
	private readonly resolveTarget: () => AgentVoiceTarget;

	constructor(
		config: AgentVoiceConfig,
		target: AgentVoiceTarget | (() => AgentVoiceTarget)
	) {
		this.config = config;
		this.resolveTarget = typeof target === "function" ? target : () => target;
	}

	private target(): AgentVoiceTarget {
		const target = this.resolveTarget();
		assertAllowedEgressUrl(target.gateway.baseUrl);
		assertAllowedEgressUrl(target.core.baseUrl);
		return target;
	}

	/** Synthesize `text` to audio. */
	async speak(text: string, options: SpeakOptions = {}): Promise<SpeechResult> {
		if (text.trim() === "") {
			throw new Error("speak needs non-empty text");
		}
		const model = options.model ?? this.config.speechModel;
		const target = this.target();
		return model
			? await this.speakViaGateway(target, model, text, options)
			: await this.speakViaCore(target, text, options);
	}

	private async speakViaGateway(
		target: AgentVoiceTarget,
		model: string,
		text: string,
		options: SpeakOptions
	): Promise<SpeechResult> {
		const format = options.format ?? this.config.format ?? "wav";
		if (!(GATEWAY_SPEECH_FORMATS as readonly string[]).includes(format)) {
			throw new Error(`the Gateway speech route cannot produce ${format}`);
		}
		const body: Record<string, number | string> = {
			model,
			input: text,
			response_format: format,
		};
		const voice = options.voice ?? this.config.voice;
		if (voice) {
			body.voice = voice;
		}
		if (options.instructions) {
			body.instructions = options.instructions;
		}
		if (options.speed !== undefined) {
			body.speed = options.speed;
		}
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			...bearer(target.gateway.token),
		};
		if (target.agentId) {
			headers["x-ryu-agent-id"] = target.agentId;
		}
		const response = await fetch(
			`${trimBase(target.gateway.baseUrl)}/v1/audio/speech`,
			{
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: options.signal,
			}
		);
		if (!response.ok) {
			throw await failure(response, "speech");
		}
		const mimeType =
			speechMimeType(response.headers.get("content-type")) ??
			MIME_BY_FORMAT[format];
		const blob = await response.blob();
		return {
			audio:
				blob.type === mimeType ? blob : new Blob([blob], { type: mimeType }),
			mimeType,
			via: "gateway",
		};
	}

	private async speakViaCore(
		target: AgentVoiceTarget,
		text: string,
		options: SpeakOptions
	): Promise<SpeechResult> {
		const format = options.format ?? this.config.format;
		if (
			format &&
			!(CORE_SPEECH_FORMATS as readonly string[]).includes(format)
		) {
			throw new Error(`local speech engines cannot produce ${format}`);
		}
		const body: Record<string, number | string> = { text };
		const engine = options.engine ?? this.config.ttsEngine;
		const voice = options.voice ?? this.config.voice;
		const language = options.language ?? this.config.language;
		if (engine) {
			body.engine = engine;
		}
		if (voice) {
			body.voice = voice;
		}
		if (language) {
			body.language = language;
		}
		if (options.speed !== undefined) {
			body.speed = options.speed;
		}
		if (options.instructions) {
			body.instruct = options.instructions;
		}
		if (format) {
			body.format = format;
		}
		const response = await fetch(
			`${trimBase(target.core.baseUrl)}/api/voice/speak`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...bearer(target.core.token),
				},
				body: JSON.stringify(body),
				signal: options.signal,
			}
		);
		if (!response.ok) {
			throw await failure(response, "speech");
		}
		const header = response.headers.get("content-type");
		// A node that predates format selection serves WAV without a type.
		const mimeType = header ? speechMimeType(header) : "audio/wav";
		if (!mimeType) {
			throw new Error("speech returned an unsupported audio type");
		}
		const blob = await response.blob();
		return {
			audio:
				blob.type === mimeType ? blob : new Blob([blob], { type: mimeType }),
			mimeType,
			via: "core",
		};
	}

	/** Transcribe recorded audio. */
	async listen(
		audio: VoiceAudioInput,
		options: ListenOptions = {}
	): Promise<TranscriptionResult> {
		const model = options.model ?? this.config.transcriptionModel;
		const target = this.target();
		const blob = toBlob(audio);
		if (blob.size === 0) {
			throw new Error("listen needs non-empty audio");
		}
		const filename = uploadFilename(audio, options.filename);
		return model
			? await this.listenViaGateway(target, model, blob, filename, options)
			: await this.listenViaCore(target, blob, filename, options);
	}

	private async listenViaGateway(
		target: AgentVoiceTarget,
		model: string,
		audio: Blob,
		filename: string,
		options: ListenOptions
	): Promise<TranscriptionResult> {
		const form = new FormData();
		form.append("file", audio, filename);
		form.append("model", model);
		form.append(
			"response_format",
			options.timestamps ? "verbose_json" : "json"
		);
		if (options.timestamps) {
			form.append("timestamp_granularities[]", "segment");
		}
		const language = options.language ?? this.config.language;
		if (language) {
			form.append("language", language);
		}
		if (options.prompt) {
			form.append("prompt", options.prompt);
		}
		const headers: Record<string, string> = { ...bearer(target.gateway.token) };
		if (target.agentId) {
			headers["x-ryu-agent-id"] = target.agentId;
		}
		const response = await fetch(
			`${trimBase(target.gateway.baseUrl)}/v1/audio/transcriptions`,
			{ method: "POST", headers, body: form, signal: options.signal }
		);
		if (!response.ok) {
			throw await failure(response, "transcription");
		}
		const parsed = gatewayTranscriptSchema.safeParse(await response.json());
		if (!parsed.success) {
			throw new Error("transcription returned an invalid response");
		}
		const data = parsed.data;
		const result: TranscriptionResult = {
			text: data.text.trim(),
			segments: (data.segments ?? []).map((segment) => ({
				startMs: seconds(segment.start),
				endMs: seconds(segment.end),
				text: segment.text.trim(),
			})),
			via: "gateway",
		};
		if (data.words?.length) {
			result.words = data.words.map((word) => ({
				startMs: seconds(word.start),
				endMs: seconds(word.end),
				text: word.word.trim(),
			}));
		}
		if (data.language) {
			result.language = data.language;
		}
		if (data.duration !== undefined) {
			result.durationMs = seconds(data.duration);
		}
		return result;
	}

	private async listenViaCore(
		target: AgentVoiceTarget,
		audio: Blob,
		filename: string,
		options: ListenOptions
	): Promise<TranscriptionResult> {
		const form = new FormData();
		form.append("file", audio, filename);
		const engine = (options.engine ?? this.config.sttEngine)?.trim();
		const path = engine
			? `/api/voice/transcribe?engine=${encodeURIComponent(engine)}`
			: "/api/voice/transcribe";
		const response = await fetch(`${trimBase(target.core.baseUrl)}${path}`, {
			method: "POST",
			headers: bearer(target.core.token),
			body: form,
			signal: options.signal,
		});
		if (!response.ok) {
			throw await failure(response, "transcription");
		}
		const parsed = coreTranscriptSchema.safeParse(await response.json());
		if (!parsed.success) {
			throw new Error("transcription returned an invalid response");
		}
		const result: TranscriptionResult = {
			text: parsed.data.text.trim(),
			segments: parsed.data.segments.map((segment) => ({
				...segment,
				text: segment.text.trim(),
			})),
			via: "core",
		};
		if (parsed.data.words?.length) {
			result.words = parsed.data.words;
		}
		return result;
	}

	/**
	 * Open a realtime voice session on Core: stream PCM16 audio up, receive
	 * transcripts, reply text, and synthesized WAV audio back. Turns run as this
	 * agent when it has an `agentId`.
	 */
	realtime(options: RealtimeVoiceOptions = {}): Promise<RealtimeVoiceSession> {
		const target = this.target();
		return openRealtimeVoice(target.core, {
			...options,
			agentId: options.agentId ?? target.agentId,
			sttEngine: options.sttEngine ?? this.config.sttEngine,
			ttsEngine: options.ttsEngine ?? this.config.ttsEngine,
			ttsVoice: options.ttsVoice ?? this.config.voice,
		});
	}
}
