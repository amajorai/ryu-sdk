/**
 * `@ryuhq/sdk/workflow` — code-first workflows.
 *
 * Build typed workflows with `createWorkflow` and `createStep` (plus agent,
 * tool, MCP, and human-gate steps), run them in-process with suspend/resume
 * and streaming, or compile them to Core's workflow graph and run them durably
 * on a Core node with `createCoreWorkflowClient`.
 */

// intentional package entry point for @ryuhq/sdk/workflow
export { compileWorkflow, WorkflowCompileError } from "./compile.ts";
export type {
	Condition,
	ConditionContext,
	ConditionFn,
	CoreCondition,
} from "./conditions.ts";
export {
	coreText,
	evalCoreCondition,
	isCoreCondition,
	negateCoreExpr,
	when,
} from "./conditions.ts";
export type {
	CompiledWorkflow,
	CoreEdge,
	CoreJson,
	CoreNode,
	CoreNodeKind,
	CoreRawNodeKind,
	CoreRetryPolicy,
	CoreTrigger,
	CoreWorkflow,
} from "./core-types.ts";
export {
	CORE_INPUT_KEY,
	CORE_OUTPUT_KEY,
	DEFAULT_LOOP_ITERATIONS,
	MAX_CORE_LOOP_ITERATIONS,
} from "./core-types.ts";
export type {
	ResumeOptions,
	RunStatus,
	StartOptions,
	StepRecord,
	StepStatus,
	StreamChunk,
	StreamMode,
	SuspendedStep,
	WorkflowEvent,
	WorkflowResult,
	WorkflowSnapshot,
	WorkflowStream,
	WorkflowValues,
} from "./executor.ts";
export {
	WorkflowCancelledError,
	WorkflowRun,
	WorkflowSuspended,
} from "./executor.ts";
export type {
	AgentStepOptions,
	HumanStepOptions,
	LocalAgent,
	LocalToolCall,
	McpStepOptions,
	NodeStepOptions,
	ToolStepOptions,
} from "./node-steps.ts";
export {
	agentStep,
	humanStep,
	mcpStep,
	nodeStep,
	renderTemplate,
	toolStep,
} from "./node-steps.ts";
export type {
	CoreFetch,
	CoreNodeRunState,
	CoreRunRecord,
	CoreWorkflowClient,
	CoreWorkflowClientOptions,
	DeployableWorkflow,
	DeployResult,
	RemoteWorkflowRun,
} from "./remote.ts";
export {
	CoreWorkflowError,
	createCoreWorkflowClient,
	decodeCoreValue,
} from "./remote.ts";
export type {
	InferSchema,
	StandardIssue,
	StandardResult,
	StandardSchemaV1,
} from "./schema.ts";
export { WorkflowValidationError } from "./schema.ts";
export type {
	CreateStepOptions,
	Step,
	StepCoreSpec,
	StepExecuteContext,
	StepInput,
	StepOutput,
	StepRetryPolicy,
} from "./step.ts";
export { createStep } from "./step.ts";
export type {
	AnyStep,
	AnyStepLike,
	CreateRunOptions,
	CreateWorkflowOptions,
	ElementOf,
	MapContext,
	OutputOf,
	Stage,
	StepLike,
	WorkflowLike,
} from "./workflow.ts";
export { createWorkflow, Workflow } from "./workflow.ts";
