/**
 * A2A v1 wire types (protocol version `1.0`), as spoken by Ryu Core.
 *
 * Field names and enum spellings follow the Linux Foundation A2A v1 JSON
 * mapping that Core serializes (`a2a-lf`): camelCase members, `ROLE_*` roles,
 * `TASK_STATE_*` states, and field-presence unions (`{ "task": … }` or
 * `{ "message": … }`). Responses are validated with these schemas and keep
 * unknown members, so newer peers stay readable.
 */

import { z } from "zod";
import type { PrimitiveJsonValue } from "../runnable/primitive-contracts.ts";

/** The A2A protocol version this client speaks. */
export const A2A_PROTOCOL_VERSION = "1.0";
/** JSON-RPC 2.0 transport binding name in `supportedInterfaces`. */
export const A2A_BINDING_JSONRPC = "JSONRPC";
/** HTTP+JSON (REST) transport binding name in `supportedInterfaces`. */
export const A2A_BINDING_HTTP_JSON = "HTTP+JSON";

/** JSON-RPC method names. */
export const A2A_METHODS = {
	sendMessage: "SendMessage",
	sendStreamingMessage: "SendStreamingMessage",
	getTask: "GetTask",
	listTasks: "ListTasks",
	cancelTask: "CancelTask",
	subscribeToTask: "SubscribeToTask",
	createPushConfig: "CreateTaskPushNotificationConfig",
	getPushConfig: "GetTaskPushNotificationConfig",
	listPushConfigs: "ListTaskPushNotificationConfigs",
	deletePushConfig: "DeleteTaskPushNotificationConfig",
	getExtendedAgentCard: "GetExtendedAgentCard",
} as const;

const metadataSchema = z.record(z.string(), z.unknown());

export const a2aRoleSchema = z.enum([
	"ROLE_USER",
	"ROLE_AGENT",
	"ROLE_UNSPECIFIED",
]);
export type A2ARole = z.output<typeof a2aRoleSchema>;

export const a2aTaskStateSchema = z.enum([
	"TASK_STATE_UNSPECIFIED",
	"TASK_STATE_SUBMITTED",
	"TASK_STATE_WORKING",
	"TASK_STATE_COMPLETED",
	"TASK_STATE_FAILED",
	"TASK_STATE_CANCELED",
	"TASK_STATE_INPUT_REQUIRED",
	"TASK_STATE_REJECTED",
	"TASK_STATE_AUTH_REQUIRED",
]);
export type A2ATaskState = z.output<typeof a2aTaskStateSchema>;

/** States after which a task can no longer change. */
export const A2A_TERMINAL_STATES: ReadonlySet<A2ATaskState> = new Set([
	"TASK_STATE_COMPLETED",
	"TASK_STATE_FAILED",
	"TASK_STATE_CANCELED",
	"TASK_STATE_REJECTED",
]);

/** One content part: exactly one of `text`, `raw` (base64), `url`, or `data`. */
export const a2aPartSchema = z
	.looseObject({
		text: z.string().optional(),
		raw: z.string().optional(),
		url: z.string().optional(),
		data: z.unknown().optional(),
		filename: z.string().optional(),
		mediaType: z.string().optional(),
		metadata: metadataSchema.optional(),
	})
	.refine(
		(part) =>
			part.text !== undefined ||
			part.raw !== undefined ||
			part.url !== undefined ||
			part.data !== undefined,
		"Part must have one of: text, raw, url, data"
	);
export type A2APart = z.output<typeof a2aPartSchema>;

export const a2aMessageSchema = z.looseObject({
	messageId: z.string(),
	contextId: z.string().optional(),
	taskId: z.string().optional(),
	role: a2aRoleSchema,
	parts: z.array(a2aPartSchema),
	metadata: metadataSchema.optional(),
	extensions: z.array(z.string()).optional(),
	referenceTaskIds: z.array(z.string()).optional(),
});
export type A2AMessage = z.output<typeof a2aMessageSchema>;

export const a2aTaskStatusSchema = z.looseObject({
	state: a2aTaskStateSchema,
	message: a2aMessageSchema.optional(),
	timestamp: z.string().optional(),
});
export type A2ATaskStatus = z.output<typeof a2aTaskStatusSchema>;

export const a2aArtifactSchema = z.looseObject({
	artifactId: z.string(),
	name: z.string().optional(),
	description: z.string().optional(),
	parts: z.array(a2aPartSchema),
	metadata: metadataSchema.optional(),
	extensions: z.array(z.string()).optional(),
});
export type A2AArtifact = z.output<typeof a2aArtifactSchema>;

export const a2aTaskSchema = z.looseObject({
	id: z.string(),
	contextId: z.string(),
	status: a2aTaskStatusSchema,
	artifacts: z.array(a2aArtifactSchema).optional(),
	history: z.array(a2aMessageSchema).optional(),
	metadata: metadataSchema.optional(),
});
export type A2ATask = z.output<typeof a2aTaskSchema>;

export const a2aStatusUpdateSchema = z.looseObject({
	taskId: z.string(),
	contextId: z.string(),
	status: a2aTaskStatusSchema,
	metadata: metadataSchema.optional(),
});
export type A2ATaskStatusUpdateEvent = z.output<typeof a2aStatusUpdateSchema>;

export const a2aArtifactUpdateSchema = z.looseObject({
	taskId: z.string(),
	contextId: z.string(),
	artifact: a2aArtifactSchema,
	append: z.boolean().optional(),
	lastChunk: z.boolean().optional(),
	metadata: metadataSchema.optional(),
});
export type A2ATaskArtifactUpdateEvent = z.output<
	typeof a2aArtifactUpdateSchema
>;

const taskVariant = z
	.looseObject({ task: a2aTaskSchema })
	.transform(({ task }) => ({ kind: "task" as const, task }));
const messageVariant = z
	.looseObject({ message: a2aMessageSchema })
	.transform(({ message }) => ({ kind: "message" as const, message }));
const statusUpdateVariant = z
	.looseObject({ statusUpdate: a2aStatusUpdateSchema })
	.transform(({ statusUpdate }) => ({
		kind: "status_update" as const,
		statusUpdate,
	}));
const artifactUpdateVariant = z
	.looseObject({ artifactUpdate: a2aArtifactUpdateSchema })
	.transform(({ artifactUpdate }) => ({
		kind: "artifact_update" as const,
		artifactUpdate,
	}));

/**
 * `SendMessage` result: a task or a direct message. The wire form is a
 * field-presence union (`{ "task": … }`); it is exposed with a `kind` tag.
 */
export const a2aSendMessageResponseSchema = z.union([
	taskVariant,
	messageVariant,
]);
export type A2ASendMessageResponse = z.output<
	typeof a2aSendMessageResponseSchema
>;

/** One streamed event, tagged by `kind` (wire order matches Core). */
export const a2aStreamResponseSchema = z.union([
	messageVariant,
	taskVariant,
	statusUpdateVariant,
	artifactUpdateVariant,
]);
export type A2AStreamResponse = z.output<typeof a2aStreamResponseSchema>;

export const a2aListTasksResponseSchema = z.looseObject({
	tasks: z.array(a2aTaskSchema),
	nextPageToken: z.string(),
	pageSize: z.number(),
	totalSize: z.number(),
});
export type A2AListTasksResponse = z.output<typeof a2aListTasksResponseSchema>;

export const a2aAuthenticationInfoSchema = z.looseObject({
	scheme: z.string(),
	credentials: z.string().optional(),
});

export const a2aPushConfigSchema = z.looseObject({
	url: z.string(),
	id: z.string().optional(),
	taskId: z.string(),
	token: z.string().optional(),
	authentication: a2aAuthenticationInfoSchema.optional(),
	tenant: z.string().optional(),
});
export type A2ATaskPushNotificationConfig = z.output<
	typeof a2aPushConfigSchema
>;

export const a2aListPushConfigsResponseSchema = z.looseObject({
	configs: z.array(a2aPushConfigSchema).optional(),
	nextPageToken: z.string().optional(),
});
export type A2AListPushConfigsResponse = z.output<
	typeof a2aListPushConfigsResponseSchema
>;

export const a2aAgentInterfaceSchema = z.looseObject({
	url: z.string(),
	protocolBinding: z.string(),
	protocolVersion: z.string(),
	tenant: z.string().nullish(),
});
export type A2AAgentInterface = z.output<typeof a2aAgentInterfaceSchema>;

export const a2aAgentSkillSchema = z.looseObject({
	id: z.string(),
	name: z.string(),
	description: z.string(),
	tags: z.array(z.string()),
	examples: z.array(z.string()).nullish(),
	inputModes: z.array(z.string()).nullish(),
	outputModes: z.array(z.string()).nullish(),
});
export type A2AAgentSkill = z.output<typeof a2aAgentSkillSchema>;

export const a2aCardSignatureSchema = z.looseObject({
	protected: z.string(),
	signature: z.string(),
	header: metadataSchema.nullish(),
});
export type A2AAgentCardSignature = z.output<typeof a2aCardSignatureSchema>;

/** A v1 Agent Card. Unknown members are kept (they are part of the signed payload). */
export const a2aAgentCardSchema = z.looseObject({
	name: z.string(),
	description: z.string(),
	version: z.string(),
	supportedInterfaces: z.array(a2aAgentInterfaceSchema),
	capabilities: z.looseObject({
		streaming: z.boolean().nullish(),
		pushNotifications: z.boolean().nullish(),
		extendedAgentCard: z.boolean().nullish(),
		extensions: z.array(z.unknown()).nullish(),
	}),
	defaultInputModes: z.array(z.string()),
	defaultOutputModes: z.array(z.string()),
	skills: z
		.array(a2aAgentSkillSchema)
		.nullish()
		.transform((skills) => skills ?? []),
	provider: z
		.looseObject({ organization: z.string(), url: z.string() })
		.nullish(),
	documentationUrl: z.string().nullish(),
	iconUrl: z.string().nullish(),
	securitySchemes: z.record(z.string(), z.unknown()).nullish(),
	securityRequirements: z.array(z.unknown()).nullish(),
	signatures: z.array(a2aCardSignatureSchema).nullish(),
});
export type A2AAgentCard = z.output<typeof a2aAgentCardSchema>;

/** A message to send; `messageId` and `role` are filled in when omitted. */
export interface A2AMessageInput {
	contextId?: string;
	extensions?: string[];
	messageId?: string;
	metadata?: Record<string, PrimitiveJsonValue>;
	parts: A2APart[];
	referenceTaskIds?: string[];
	role?: A2ARole;
	taskId?: string;
}

const messageInputContract = z.looseObject({
	parts: z.array(a2aPartSchema),
	contextId: z.string().optional(),
	messageId: z.string().optional(),
	role: a2aRoleSchema.optional(),
	taskId: z.string().optional(),
	extensions: z.array(z.string()).optional(),
	referenceTaskIds: z.array(z.string()).optional(),
});

/** A message to send: plain text becomes one text part. */
export const a2aMessageInputSchema = z.union([
	z.string().transform((text): A2AMessageInput => ({ parts: [{ text }] })),
	z.custom<A2AMessageInput>(
		(value) => messageInputContract.safeParse(value).success
	),
]);

/** `SendMessageConfiguration`. */
export interface A2ASendMessageConfiguration {
	acceptedOutputModes?: string[];
	historyLength?: number;
	returnImmediately?: boolean;
	taskPushNotificationConfig?: A2ATaskPushNotificationConfig;
}

/** `SendMessageRequest` as the caller supplies it. */
export interface A2ASendMessageParams {
	configuration?: A2ASendMessageConfiguration;
	message: A2AMessageInput | string;
	metadata?: Record<string, PrimitiveJsonValue>;
}

/** `ListTasksRequest` filters. */
export interface A2AListTasksParams {
	contextId?: string;
	historyLength?: number;
	includeArtifacts?: boolean;
	pageSize?: number;
	pageToken?: string;
	status?: A2ATaskState;
	/** RFC 3339 timestamp. */
	statusTimestampAfter?: string;
}

export const jsonRpcResponseSchema = z.looseObject({
	jsonrpc: z.string(),
	id: z.union([z.string(), z.number(), z.null()]),
	result: z.unknown().optional(),
	error: z
		.looseObject({
			code: z.number(),
			message: z.string(),
			data: z.unknown().optional(),
		})
		.optional(),
});
