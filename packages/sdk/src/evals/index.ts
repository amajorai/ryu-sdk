/**
 * `@ryuhq/sdk/evals` — scorers, datasets, and experiments for testing agents
 * in code and gating CI.
 *
 * Deterministic scorers run locally. Model-graded scorers (LLM-as-judge,
 * answer relevancy, faithfulness, toxicity, any catalog evaluator, embedding
 * similarity) call the Ryu Gateway's eval API, so judging uses the same
 * Gateway prompts, routing, and budgets as Desktop and `ryu eval`.
 */

export type {
	Dataset,
	DatasetFormat,
	ParseDatasetOptions,
} from "./dataset.ts";
export {
	createDataset,
	DatasetError,
	loadDataset,
	parseCsvRows,
	parseDataset,
} from "./dataset.ts";
export type {
	CompletenessOptions,
	ContainsOptions,
	JsonSchemaScorerOptions,
	LevenshteinOptions,
	RegexOptions,
	TextMatchOptions,
	ToolCallAccuracyOptions,
} from "./deterministic.ts";
export {
	completeness,
	contains,
	contentTerms,
	exactMatch,
	jsonSchema,
	levenshtein,
	levenshteinDistance,
	regex,
	toolCallAccuracy,
} from "./deterministic.ts";
export type {
	ExperimentAgent,
	ExperimentFn,
	RunExperimentOptions,
	TargetOutput,
} from "./experiment.ts";
export { runExperiment } from "./experiment.ts";
export type {
	EvalFetch,
	GatewayAssertion,
	GatewayAssertionResult,
	GatewayEvalClientOptions,
	GatewayEvaluatorInfo,
	GatewayEvaluatorResult,
	OnlineScoreRequest,
	OnlineScoreResult,
} from "./gateway.ts";
export {
	defaultGatewayEvalClient,
	GatewayEvalClient,
	GatewayEvalError,
} from "./gateway.ts";
export type {
	CatalogEvaluatorOptions,
	EmbeddingSimilarityOptions,
	GatewayScorerOptions,
	LlmJudgeOptions,
} from "./model-graded.ts";
export {
	answerRelevancy,
	catalogEvaluator,
	cosineSimilarity,
	embeddingSimilarity,
	faithfulness,
	llmJudge,
	toxicity,
} from "./model-graded.ts";
export type { CreateScorerOptions } from "./scorer.ts";
export { createScorer, DEFAULT_PASS_THRESHOLD } from "./scorer.ts";
export type {
	CaseScore,
	EvalItem,
	ExpectedToolCall,
	ExperimentCaseResult,
	ExperimentResult,
	ScoreResult,
	Scorer,
	ScorerAggregate,
	ScorerInput,
	ThresholdCheck,
	ToolCallRecord,
} from "./types.ts";
export type { UploadExperimentOptions, UploadedRun } from "./upload.ts";
export { experimentToPromptRun, uploadExperiment } from "./upload.ts";
