/**
 * `@ryuhq/sdk/a2a` — an A2A v1 client.
 *
 * Discover a remote agent's (optionally signed) Agent Card, send messages,
 * stream task updates, manage tasks, and wrap the remote agent as a tool for
 * an SDK `Agent`. The wire protocol and signature checks match Ryu Core.
 */

export type {
	CardSignatureHeader,
	CardSignatureStatus,
	CardVerificationKey,
	KeyResolution,
} from "./card-signing.ts";
export {
	agentCardSigningPayload,
	CARD_SIGNATURE_ALG,
	canonicalizeJson,
	ed25519JwkThumbprint,
	ed25519KeysFromJwks,
	verifyAgentCardSignatures,
} from "./card-signing.ts";
export type {
	A2AClientOptions,
	A2AConnectOptions,
	A2ACredential,
	A2AEndpoint,
	A2ALimits,
	A2ATransportBinding,
	A2ATransportOptions,
	DiscoverAgentCardOptions,
	DiscoveredAgentCard,
} from "./client.ts";
export {
	A2AClient,
	buildA2AMessage,
	discoverAgentCard,
	selectEndpoint,
	validateAgentCard,
} from "./client.ts";
export type { EndpointErrorCode, EndpointPolicy } from "./endpoint.ts";
export { A2AEndpointError, validateEndpoint } from "./endpoint.ts";
export type { A2AErrorCode, A2AErrorDetails } from "./errors.ts";
export { A2AError } from "./errors.ts";
export type {
	A2ATaskOutcome,
	A2AToolOptions,
	RunA2ATaskOptions,
} from "./tool.ts";
export { a2aAgentTool, runA2ATask, taskOutcome } from "./tool.ts";
export type {
	A2AAgentCard,
	A2AAgentCardSignature,
	A2AAgentInterface,
	A2AAgentSkill,
	A2AArtifact,
	A2AListPushConfigsResponse,
	A2AListTasksParams,
	A2AListTasksResponse,
	A2AMessage,
	A2AMessageInput,
	A2APart,
	A2ARole,
	A2ASendMessageConfiguration,
	A2ASendMessageParams,
	A2ASendMessageResponse,
	A2AStreamResponse,
	A2ATask,
	A2ATaskArtifactUpdateEvent,
	A2ATaskPushNotificationConfig,
	A2ATaskState,
	A2ATaskStatus,
	A2ATaskStatusUpdateEvent,
} from "./types.ts";
export {
	A2A_BINDING_HTTP_JSON,
	A2A_BINDING_JSONRPC,
	A2A_METHODS,
	A2A_PROTOCOL_VERSION,
	A2A_TERMINAL_STATES,
} from "./types.ts";
