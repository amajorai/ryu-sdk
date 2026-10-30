/**
 * `@ryu/sdk/agent` — the declarative agent runtime.
 *
 * Public entry for building apps on top of the SDK: a loop-owning `Agent`
 * (Mastra-style) and a `query()` streaming call (Claude-Agent-SDK-style), plus
 * `ryuTool` to reference existing Ryu tools and the event/type surface.
 */

export type {
	JsonSchemaObject,
	SchemaIssue,
	SchemaLike,
	StandardSchemaV1,
} from "../schema/index.ts";
export {
	fromJsonSchema,
	SchemaConversionError,
	StructuredOutputError,
	toJsonSchema,
	withJsonSchema,
} from "../schema/index.ts";
export type {
	AgentConfig,
	AgentRunOptions,
	Endpoint,
	GenerateResult,
} from "./agent.ts";
export { Agent, createAgent } from "./agent.ts";
export type { CompactionGateway, CompactionOptions } from "./compaction.ts";
export {
	compactionMiddleware,
	estimateMessagesTokens,
	planCompaction,
} from "./compaction.ts";
export type {
	AgentEvent,
	AgentEventApprovalRequested,
	AgentEventAuthRequired,
	AgentEventError,
	AgentEventOutputRepair,
	AgentEventResult,
	AgentEventText,
	AgentEventToolCall,
	AgentEventToolResult,
	LoopConfig,
} from "./loop.ts";
export { runAgentLoop } from "./loop.ts";
export type {
	AfterTurnContinue,
	AfterTurnDirective,
	AgentMiddleware,
	ModelCallNext,
	ModelCallRequest,
	ToolCallNext,
	ToolCallRequest,
	ToolCallResult,
	TurnSummary,
} from "./middleware.ts";
export type {
	AssistantMessage,
	LoopMessage,
	ModelCallOptions,
	ModelCallResult,
	ModelStreamEvent,
	ModelUsage,
	ToolCall,
	ToolFunctionDef,
} from "./model-call.ts";
export { callModelWithTools, streamModelWithTools } from "./model-call.ts";
export type {
	AgentAsToolOptions,
	AgentChainOptions,
	AgentEventHandoff,
	AgentNetworkConfig,
	AgentToolRunnable,
	HandoffOptions,
	HandoffTool,
	NetworkEvent,
	NetworkEventResult,
	NetworkResult,
	SupervisorConfig,
} from "./network.ts";
export {
	AgentNetwork,
	createSupervisor,
	handoff,
	handoffToolName,
	runAgentChain,
	SupervisorNetwork,
} from "./network.ts";
export type { QueryInput, QueryOptions } from "./query.ts";
export { query } from "./query.ts";
export type {
	AgentApprovalDecision,
	AgentApprovalHandler,
	AgentApprovalOption,
	AgentApprovalRequest,
	AgentTool,
	Elicitation,
	RemoteToolRef,
	RyuToolOptions,
	ToolExecContext,
	ToolExecResult,
} from "./tools.ts";
export {
	detectElicitation,
	executeTool,
	resolveToolDefs,
	ryuTool,
} from "./tools.ts";
export type {
	ResolvedWorkingMemory,
	WorkingMemoryDocument,
	WorkingMemoryHandle,
	WorkingMemoryJson,
	WorkingMemoryMode,
	WorkingMemoryOptions,
	WorkingMemoryRef,
	WorkingMemoryScope,
	WorkingMemoryTransportOptions,
	WorkingMemoryUpdate,
} from "./working-memory.ts";
export {
	createWorkingMemoryHandle,
	DEFAULT_WORKING_MEMORY_TEMPLATE,
	renderWorkingMemoryBlock,
	resolveWorkingMemory,
	WORKING_MEMORY_TOOL_NAME,
	workingMemoryMiddleware,
	workingMemoryTool,
} from "./working-memory.ts";
