/**
 * `@ryuhq/sdk/agui` — AG-UI protocol support for Ryu agents.
 *
 * - `toAgUiHandler(agent)`: Fetch `Request` → SSE `Response` endpoint that
 *   CopilotKit-style AG-UI frontends can talk to, with approval interrupts and
 *   resumption.
 * - `agentEventsToAgUi` / `harnessEventsToAgUi`: map an SDK `AgentEvent`
 *   stream or Core's durable harness stream onto AG-UI events.
 * - JSON Patch helpers for `STATE_DELTA`, and the SSE codec.
 */

export type { AgUiMapperOptions } from "./adapter.ts";
export {
	AgUiEventMapper,
	agentEventsToAgUi,
	harnessEventsToAgUi,
	toAgUiJson,
} from "./adapter.ts";
export type {
	AgUiCustomEvent,
	AgUiEvent,
	AgUiEventType,
	AgUiInterrupt,
	AgUiJson,
	AgUiMessage,
	AgUiMessagesSnapshotEvent,
	AgUiRawEvent,
	AgUiRunErrorEvent,
	AgUiRunFinishedEvent,
	AgUiRunStartedEvent,
	AgUiStateDeltaEvent,
	AgUiStateSnapshotEvent,
	AgUiStepFinishedEvent,
	AgUiStepStartedEvent,
	AgUiTextMessageContentEvent,
	AgUiTextMessageEndEvent,
	AgUiTextMessageStartEvent,
	AgUiToolCall,
	AgUiToolCallArgsEvent,
	AgUiToolCallEndEvent,
	AgUiToolCallResultEvent,
	AgUiToolCallStartEvent,
	JsonPatchOperation,
	RunAgentInput,
	RunAgentInputMessage,
} from "./events.ts";
export {
	AG_UI_EVENT_TYPES,
	AG_UI_INTERRUPT_EVENT,
	AG_UI_SSE_CONTENT_TYPE,
	encodeAgUiEvent,
	parseAgUiStream,
	runAgentInputSchema,
} from "./events.ts";
export type {
	AgUiHandler,
	AgUiHandlerOptions,
	AgUiStateReducer,
} from "./handler.ts";
export {
	agUiMessagesToTranscript,
	decodeResumeDecision,
	toAgUiHandler,
} from "./handler.ts";
export {
	applyJsonPatch,
	diffJsonState,
	escapePointerSegment,
	jsonEqual,
} from "./json-patch.ts";
