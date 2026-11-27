/**
 * `@ryuhq/sdk/voice` — speech for Ryu agents through the node's Gateway and
 * Core (`agent.voice.speak/listen/realtime`). No direct provider calls.
 */

export type {
	RealtimeCallSummary,
	RealtimeVoiceEvent,
	RealtimeVoiceOptions,
	VoiceSocket,
	VoiceSocketFactory,
} from "./realtime.ts";
export {
	globalVoiceSocket,
	openRealtimeVoice,
	REALTIME_DEFAULT_SAMPLE_RATE,
	RealtimeVoiceSession,
	realtimeVoiceUrl,
} from "./realtime.ts";
export type {
	AgentVoiceConfig,
	AgentVoiceTarget,
	ListenOptions,
	SpeakOptions,
	SpeechFormat,
	SpeechResult,
	TranscriptionResult,
	TranscriptSegment,
	VoiceAudioInput,
	VoiceEndpoint,
} from "./voice.ts";
export {
	AgentVoice,
	CORE_SPEECH_FORMATS,
	GATEWAY_SPEECH_FORMATS,
	speechMimeType,
} from "./voice.ts";
