/**
 * @ryuhq/sdk — Ryu developer SDK.
 *
 * Re-exports the manifest types, builder utilities, gateway-mandatory model
 * client, and Runnable authoring API as a single entry point for consumers
 * who import from "@ryuhq/sdk".
 *
 * CLI users run `bunx ryu pack <dir>` via the bin entry in package.json.
 */

export type {
	AgentApprovalDecision,
	AgentApprovalHandler,
	AgentApprovalOption,
	AgentApprovalRequest,
	AgentAsToolOptions,
	AgentConfig,
	AgentEvent,
	AgentEventApprovalRequested,
	AgentEventHandoff,
	AgentMiddleware,
	AgentNetworkConfig,
	AgentTool,
	Endpoint,
	GenerateResult,
	HandoffOptions,
	HandoffTool,
	ModelCallRequest,
	NetworkEvent,
	NetworkResult,
	QueryInput,
	QueryOptions,
	RemoteToolRef,
	SupervisorConfig,
	ToolCallRequest,
	ToolCallResult,
	TurnSummary,
} from "./agent/index.ts";
export {
	Agent,
	AgentNetwork,
	createAgent,
	createSupervisor,
	handoff,
	query,
	runAgentLoop,
	ryuTool,
	streamModelWithTools,
} from "./agent/index.ts";
export type { ModelStreamEvent } from "./agent/model-call.ts";
export type { BackupOperation, BackupRecord } from "./backups.types.ts";
export {
	AgentBuilder,
	AppBuilder,
	agent,
	app,
	PluginBuilder,
	SkillBuilder,
	skill,
	ToolBuilder,
	tool,
	WorkflowBuilder,
	workflow,
} from "./builder.ts";
export type {
	AppDependency,
	CapabilityReq,
	CompanionSurface,
	Contributes,
	HookMode,
	McpServerAuth,
	McpServerDecl,
	PluginManifest,
	Requires,
	RunnableKind,
	RunnableMeta,
	SlashCommandArgument,
	SlashCommandContribution,
	SlashCommandCustomOption,
	SlashCommandOption,
	Surface,
	ToolAppConfig,
	TurnHookContribution,
	WidgetContribution,
} from "./manifest.ts";
export {
	AppDependencySchema,
	CapabilityReqSchema,
	CompanionSurfaceSchema,
	coreManifestJsonSchema,
	HookModeSchema,
	McpServerAuthSchema,
	McpServerDeclSchema,
	PluginManifestSchema,
	RequiresSchema,
	RunnableKindSchema,
	RunnableMetaSchema,
	SlashCommandArgumentSchema,
	SlashCommandContributionSchema,
	SlashCommandCustomOptionSchema,
	SlashCommandOptionSchema,
	SurfaceSchema,
	ToolAppConfigSchema,
	validateManifestStrict,
	validatePluginId,
	WidgetContributionSchema,
} from "./manifest.ts";
export type {
	JsonSchema,
	McpStdioCommand,
	McpTool,
	PassthroughRegistration,
	SdkRunnable,
} from "./mcp/index.ts";
export {
	callTool,
	listTools,
	MCP_PROTOCOL_VERSION,
	McpServer,
	unwrapContent,
} from "./mcp/index.ts";
export type {
	ChatDelta,
	ChatMessage,
	ChatResult,
	ModelClientOptions,
} from "./model/client.ts";
export { defineModel, ModelClient } from "./model/client.ts";
export {
	assertAllowedEgressUrl,
	DEFAULT_GATEWAY_URL,
	resolveGatewayToken,
	resolveGatewayUrl,
} from "./model/gateway.ts";
export type {
	CommandContribution,
	Disposable,
	PanelContribution,
	PanelRegion,
	PluginContext,
	RouteContribution,
	RyuHostServices,
	RyuI18nServices,
	RyuI18nSnapshot,
	RyuI18nTranslateInput,
	RyuPlugin,
	RyuPluginModule,
	SettingsSectionContribution,
	StoreSectionContribution,
	ThemeContribution,
} from "./plugin/ryu-plugin.ts";
export { toDisposable } from "./plugin/ryu-plugin.ts";
export type {
	Prompt,
	PromptInstructions,
	PromptReference,
} from "./prompts/index.ts";
export {
	ChatPrompt,
	compileTemplate,
	createPromptClient,
	PromptClient,
	prompts,
	TextPrompt,
} from "./prompts/index.ts";
export type {
	ActionAnnotations,
	ActionEffect,
	ActionManifestOptions,
	ActionOptions,
	ActionRunnable,
} from "./runnable/action.ts";
export { defineAction } from "./runnable/action.ts";
export type {
	AgentCard,
	AgentIdentityMode,
	AgentManifestOptions,
	AgentOptions,
	AgentRunnable,
	AgentSlots,
	CapabilitySlot,
	ChatSlot,
} from "./runnable/agent.ts";
export { defineAgent } from "./runnable/agent.ts";
export type {
	AppToolSpec,
	DefineAppOptions,
	DefineAppRequires,
} from "./runnable/app.ts";
export { appToolId, defineApp } from "./runnable/app.ts";
export type {
	BackgroundClient,
	BackgroundProcess,
	BackupsClient,
	DurableClient,
	EnginesClient,
	HttpPrimitiveTransportOptions,
	ImageClient,
	MemoryClient,
	MemoryItem,
	PrimitiveBinding,
	PrimitiveTransport,
	RagChunk,
	RagClient,
	RagRerankResult,
	RealtimeClient,
	RealtimeSubscription,
	RyuPrimitives,
	StorageClient,
	SttClient,
	TtsClient,
} from "./runnable/primitives.ts";
export {
	createPrimitives,
	httpPrimitiveTransport,
	PRIMITIVE_BINDINGS,
} from "./runnable/primitives.ts";
export type {
	GatewayClient,
	Runnable,
	RunnableContext,
} from "./runnable/runnable-types.ts";
export type { SkillOptions } from "./runnable/skill.ts";
export { defineSkill } from "./runnable/skill.ts";
export type {
	InlineToolManifestOptions,
	JsonSchemaProperty,
	ToolOptions,
	ToolRunnable,
	ToolSchema,
	TypedToolInputSchema,
	TypedToolOptions,
} from "./runnable/tool.ts";
export { defineTool, inlineToolRunnable } from "./runnable/tool.ts";
export type {
	DefineFunctionHookOptions,
	DefinePluginOptions,
	DefineTurnHookOptions,
	FunctionHookRun,
	HookContext,
	HookDirective,
	HookMatch,
	HookNext,
	HookRun,
	HostApi,
	SideModelArgs,
} from "./runnable/turn-hook.ts";
export {
	defineFunctionHook,
	definePlugin,
	defineTurnHook,
} from "./runnable/turn-hook.ts";
export type {
	WorkflowOptions,
	WorkflowRunnable,
	WorkflowStep,
} from "./runnable/workflow.ts";
export { defineWorkflow } from "./runnable/workflow.ts";
export type {
	InferSchemaInput,
	InferSchemaOutput,
	JsonSchemaObject,
	SchemaIssue,
	SchemaLike,
	StandardSchemaV1,
} from "./schema/index.ts";
export {
	fromJsonSchema,
	SchemaConversionError,
	StructuredOutputError,
	toJsonSchema,
	withJsonSchema,
} from "./schema/index.ts";
