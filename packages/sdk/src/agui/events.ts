/**
 * AG-UI protocol wire types (https://docs.ag-ui.com).
 *
 * AG-UI is the event protocol agent frontends such as CopilotKit speak: the
 * client POSTs a `RunAgentInput` and reads a Server-Sent Events stream of typed
 * events (`RUN_STARTED`, `TEXT_MESSAGE_CONTENT`, `TOOL_CALL_START`, …). This
 * module owns the event and input shapes plus the SSE framing; the adapters in
 * `adapter.ts` produce these events from Ryu agent and harness streams.
 */

import { z } from "zod";

/** A JSON value, as carried by AG-UI state, results, and custom payloads. */
export type AgUiJson =
	| boolean
	| number
	| string
	| null
	| AgUiJson[]
	| { [key: string]: AgUiJson };

/** Every AG-UI event type this SDK emits or accepts. */
export const AG_UI_EVENT_TYPES = [
	"RUN_STARTED",
	"RUN_FINISHED",
	"RUN_ERROR",
	"STEP_STARTED",
	"STEP_FINISHED",
	"TEXT_MESSAGE_START",
	"TEXT_MESSAGE_CONTENT",
	"TEXT_MESSAGE_END",
	"TOOL_CALL_START",
	"TOOL_CALL_ARGS",
	"TOOL_CALL_END",
	"TOOL_CALL_RESULT",
	"STATE_SNAPSHOT",
	"STATE_DELTA",
	"MESSAGES_SNAPSHOT",
	"RAW",
	"CUSTOM",
] as const;

export type AgUiEventType = (typeof AG_UI_EVENT_TYPES)[number];

/** Fields every AG-UI event may carry. */
interface AgUiBaseEvent {
	timestamp?: number;
}

/** A tool call inside an assistant message (OpenAI function shape). */
export interface AgUiToolCall {
	function: { arguments: string; name: string };
	id: string;
	type: "function";
}

/** A conversation message as AG-UI carries it in input and snapshots. */
export type AgUiMessage =
	| { content: string; id: string; role: "developer" | "system" | "user" }
	| {
			content?: string;
			id: string;
			role: "assistant";
			toolCalls?: AgUiToolCall[];
	  }
	| { content: string; id: string; role: "tool"; toolCallId: string };

/** Why a run paused, carried on `RUN_FINISHED` when `outcome` is `interrupt`. */
export interface AgUiInterrupt {
	id: string;
	payload?: AgUiJson;
	reason: string;
}

/** One RFC 6902 JSON Patch operation, as carried by `STATE_DELTA`. */
export type JsonPatchOperation =
	| { op: "add" | "replace" | "test"; path: string; value: AgUiJson }
	| { op: "remove"; path: string }
	| { from: string; op: "copy" | "move"; path: string };

export interface AgUiRunStartedEvent extends AgUiBaseEvent {
	parentRunId?: string;
	runId: string;
	threadId: string;
	type: "RUN_STARTED";
}

export interface AgUiRunFinishedEvent extends AgUiBaseEvent {
	interrupt?: AgUiInterrupt;
	outcome?: "interrupt" | "success";
	result?: AgUiJson;
	runId: string;
	threadId: string;
	type: "RUN_FINISHED";
}

export interface AgUiRunErrorEvent extends AgUiBaseEvent {
	code?: string;
	message: string;
	type: "RUN_ERROR";
}

export interface AgUiStepStartedEvent extends AgUiBaseEvent {
	stepName: string;
	type: "STEP_STARTED";
}

export interface AgUiStepFinishedEvent extends AgUiBaseEvent {
	stepName: string;
	type: "STEP_FINISHED";
}

export interface AgUiTextMessageStartEvent extends AgUiBaseEvent {
	messageId: string;
	role: "assistant";
	type: "TEXT_MESSAGE_START";
}

export interface AgUiTextMessageContentEvent extends AgUiBaseEvent {
	delta: string;
	messageId: string;
	type: "TEXT_MESSAGE_CONTENT";
}

export interface AgUiTextMessageEndEvent extends AgUiBaseEvent {
	messageId: string;
	type: "TEXT_MESSAGE_END";
}

export interface AgUiToolCallStartEvent extends AgUiBaseEvent {
	parentMessageId?: string;
	toolCallId: string;
	toolCallName: string;
	type: "TOOL_CALL_START";
}

export interface AgUiToolCallArgsEvent extends AgUiBaseEvent {
	delta: string;
	toolCallId: string;
	type: "TOOL_CALL_ARGS";
}

export interface AgUiToolCallEndEvent extends AgUiBaseEvent {
	toolCallId: string;
	type: "TOOL_CALL_END";
}

export interface AgUiToolCallResultEvent extends AgUiBaseEvent {
	content: string;
	messageId: string;
	role: "tool";
	toolCallId: string;
	type: "TOOL_CALL_RESULT";
}

export interface AgUiStateSnapshotEvent extends AgUiBaseEvent {
	snapshot: AgUiJson;
	type: "STATE_SNAPSHOT";
}

export interface AgUiStateDeltaEvent extends AgUiBaseEvent {
	delta: JsonPatchOperation[];
	type: "STATE_DELTA";
}

export interface AgUiMessagesSnapshotEvent extends AgUiBaseEvent {
	messages: AgUiMessage[];
	type: "MESSAGES_SNAPSHOT";
}

export interface AgUiRawEvent extends AgUiBaseEvent {
	event: AgUiJson;
	source?: string;
	type: "RAW";
}

export interface AgUiCustomEvent extends AgUiBaseEvent {
	name: string;
	type: "CUSTOM";
	value: AgUiJson;
}

/** Union of every AG-UI event. */
export type AgUiEvent =
	| AgUiCustomEvent
	| AgUiMessagesSnapshotEvent
	| AgUiRawEvent
	| AgUiRunErrorEvent
	| AgUiRunFinishedEvent
	| AgUiRunStartedEvent
	| AgUiStateDeltaEvent
	| AgUiStateSnapshotEvent
	| AgUiStepFinishedEvent
	| AgUiStepStartedEvent
	| AgUiTextMessageContentEvent
	| AgUiTextMessageEndEvent
	| AgUiTextMessageStartEvent
	| AgUiToolCallArgsEvent
	| AgUiToolCallEndEvent
	| AgUiToolCallResultEvent
	| AgUiToolCallStartEvent;

/** Name of the `CUSTOM` event that announces a human-in-the-loop interrupt. */
export const AG_UI_INTERRUPT_EVENT = "on_interrupt";

// ── RunAgentInput ─────────────────────────────────────────────────────────────

const jsonSchema: z.ZodType<AgUiJson> = z.json();

/** User content may be a string or AG-UI input-content parts. */
const userContentSchema = z.union([
	z.string(),
	z.array(
		z.union([
			z.object({ type: z.literal("text"), text: z.string() }),
			z.looseObject({ type: z.string() }),
		])
	),
]);

const toolCallSchema = z.object({
	id: z.string().min(1),
	type: z.literal("function").default("function"),
	function: z.object({ name: z.string().min(1), arguments: z.string() }),
});

const messageSchema = z.discriminatedUnion("role", [
	z.object({
		id: z.string().default(""),
		role: z.literal("user"),
		content: userContentSchema,
	}),
	z.object({
		id: z.string().default(""),
		role: z.enum(["system", "developer"]),
		content: z.string(),
	}),
	z.object({
		id: z.string().default(""),
		role: z.literal("assistant"),
		content: z.string().nullish(),
		toolCalls: z.array(toolCallSchema).optional(),
	}),
	z.object({
		id: z.string().default(""),
		role: z.literal("tool"),
		content: z.string(),
		toolCallId: z.string().min(1),
	}),
	// Activity / reasoning messages are display-only for this runtime.
	z.object({
		id: z.string().default(""),
		role: z.enum(["activity", "reasoning"]),
	}),
]);

const resumeSchema = z.object({
	interruptId: z.string().min(1).optional(),
	payload: jsonSchema.optional(),
});

/**
 * The body an AG-UI client POSTs to start (or resume) a run. Unknown fields are
 * tolerated; ids default to fresh values when a client omits them.
 */
export const runAgentInputSchema = z.object({
	threadId: z.string().min(1).optional(),
	runId: z.string().min(1).optional(),
	parentRunId: z.string().min(1).optional(),
	state: jsonSchema.optional(),
	messages: z.array(messageSchema).default(() => []),
	tools: z
		.array(
			z.object({
				name: z.string(),
				description: z.string().optional(),
				parameters: jsonSchema.optional(),
			})
		)
		.default(() => []),
	context: z
		.array(z.object({ description: z.string(), value: z.string() }))
		.default(() => []),
	forwardedProps: jsonSchema.optional(),
	/** Interrupt resumption (AG-UI interrupt-aware run lifecycle). */
	resume: z.union([resumeSchema, z.array(resumeSchema)]).optional(),
});

export type RunAgentInput = z.output<typeof runAgentInputSchema>;
export type RunAgentInputMessage = RunAgentInput["messages"][number];

// ── SSE framing ───────────────────────────────────────────────────────────────

/** Content type of an AG-UI event stream. */
export const AG_UI_SSE_CONTENT_TYPE = "text/event-stream";

/** Frame one AG-UI event as a Server-Sent Events `data:` record. */
export function encodeAgUiEvent(event: AgUiEvent): string {
	return `data: ${JSON.stringify(event)}\n\n`;
}

const sseRecordSeparator = /\r?\n\r?\n/;
const sseDataPrefix = /^data: ?/;
const eventTypeSchema = z.looseObject({ type: z.enum(AG_UI_EVENT_TYPES) });
/** Accepts any object tagged with a known AG-UI event type. */
const agUiEventSchema = z.custom<AgUiEvent>(
	(value) => eventTypeSchema.safeParse(value).success,
	{ message: "not an AG-UI event" }
);

/**
 * Parse an AG-UI SSE body back into events. Used by tests and by SDK callers
 * that consume another AG-UI agent; it rejects records with an unknown `type`.
 */
export function parseAgUiStream(body: string): AgUiEvent[] {
	const events: AgUiEvent[] = [];
	for (const record of body.split(sseRecordSeparator)) {
		const data = record
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.replace(sseDataPrefix, ""))
			.join("\n");
		if (data.trim() === "") {
			continue;
		}
		events.push(agUiEventSchema.parse(JSON.parse(data)));
	}
	return events;
}
