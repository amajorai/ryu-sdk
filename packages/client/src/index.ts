// packages/client/src/index.ts
//
// Public surface of @ryuhq/client. Import createRyuClient and any types you need
// from this single entry point.

export { type AgentRunOptions, AgentsAPI } from "./agents.ts";
export { createRyuClient, RyuClient } from "./client.ts";
export type {
	ApprovalMode,
	ExecutionProfile,
	ExecutionProfileKind,
	HarnessApprovalOption,
	HarnessRun,
	HarnessRunEvent,
	HarnessRunEventEnvelope,
	HarnessRunStatus,
	HarnessSession,
	NetworkMode,
	SandboxMode,
	StartRunInput,
	StartRunResponse,
} from "./harness.ts";
export { HarnessAPI } from "./harness.ts";
export type {
	CreateMailInboxInput,
	MailAttachment,
	MailAttachmentInput,
	MailDomain,
	MailDraft,
	MailEvent,
	MailInbox,
	MailListEntry,
	MailMessage,
	MailPod,
	MailSendInput,
	MailStatus,
	MailThread,
	MailWebhook,
	MailWebhookCreateInput,
	MailWebhookDelivery,
} from "./mail.ts";
export { MailAPI } from "./mail.ts";
export {
	createNotifyClient,
	type NotificationAction,
	type NotificationAttachment,
	type NotificationEvent,
	type NotificationLevel,
	type NotificationPriority,
	type NotificationResponse,
	type NotificationResponseStatus,
	type NotificationResponseType,
	type NotifyActivity,
	type NotifyActivityInput,
	type NotifyAnalytics,
	NotifyAPI,
	type NotifyClientOptions,
	type NotifyDelivery,
	type NotifyDestination,
	type NotifyDestinationInput,
	type NotifyDestinationPatch,
	type NotifyEventInput,
	type NotifyEventList,
	type NotifyEventListOptions,
	type NotifyGroup,
	type NotifyPreferences,
	type NotifySilence,
	type NotifySilenceInput,
	type NotifyStreamItem,
	type NotifyStreamOptions,
} from "./notify.ts";
export { SessionsAPI } from "./sessions.ts";
export {
	type RetrievalModeCancellation,
	type RetrievalModeChange,
	type RetrievalModeJob,
	type RetrievalModeStatus,
	SpacesAPI,
} from "./spaces.ts";
export type {
	Agent,
	AgentSummary,
	Conversation,
	Message,
	RetrievalMode,
	RyuClientOptions,
	RyuFetch,
	RyuResponseMode,
	Space,
	SpaceMatch,
	StreamChunk,
} from "./types.ts";
