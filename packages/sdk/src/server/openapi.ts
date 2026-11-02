/**
 * OpenAPI 3.1 description of a Ryu developer server.
 *
 * Paths are emitted per registered agent, workflow, and tool (not as generic
 * `{id}` templates) so each operation can carry its own request schema: a
 * tool's input schema, a workflow's `inputSchema`. Schemas that cannot be
 * described as JSON Schema fall back to an open object.
 */

import type { JsonSchemaObject } from "../schema/json-schema.ts";
import { toJsonSchema } from "../schema/json-schema.ts";
import type { StandardSchemaV1 } from "../schema/standard-schema.ts";

/** A JSON-compatible OpenAPI document. */
export type OpenApiDocument = Record<string, unknown>;

/** What the generator needs to know about the registered resources. */
export interface OpenApiInput {
	agents: { description?: string; id: string; name: string }[];
	basePath: string;
	info: { description?: string; title: string; version: string };
	/** True when an auth hook guards the API. */
	secured: boolean;
	tools: {
		description?: string;
		id: string;
		name: string;
		/** The tool's JSON Schema input descriptor. */
		schema: object;
	}[];
	workflows: {
		description?: string;
		id: string;
		inputSchema?: StandardSchemaV1;
		name: string;
	}[];
}

const OPEN_OBJECT: JsonSchemaObject = {
	type: "object",
	additionalProperties: true,
};

const ERROR_RESPONSE = {
	description: "Error",
	content: {
		"application/json": { schema: { $ref: "#/components/schemas/Error" } },
	},
};

const SSE_RESPONSE = {
	description:
		"Server-Sent Events. Each frame's `event` names the payload type; the stream ends with `done`.",
	content: { "text/event-stream": { schema: { type: "string" } } },
};

function jsonBody(schema: unknown, required = true) {
	return {
		required,
		content: { "application/json": { schema } },
	};
}

function jsonResponse(description: string, schema: unknown = OPEN_OBJECT) {
	return {
		description,
		content: { "application/json": { schema } },
	};
}

/** Describe a Standard Schema as JSON Schema, or an open object when it can't. */
export function describeSchema(
	schema: StandardSchemaV1 | undefined
): JsonSchemaObject {
	if (!schema) {
		return OPEN_OBJECT;
	}
	try {
		return toJsonSchema(schema, "input");
	} catch {
		return OPEN_OBJECT;
	}
}

function operation(
	operationId: string,
	tag: string,
	summary: string,
	extra: Record<string, unknown>
) {
	return {
		operationId,
		tags: [tag],
		summary,
		...extra,
		responses: {
			...(extra.responses as Record<string, unknown> | undefined),
			"400": ERROR_RESPONSE,
			"401": ERROR_RESPONSE,
			"404": ERROR_RESPONSE,
		},
	};
}

function safeOperationId(...parts: string[]): string {
	return parts
		.join("_")
		.replace(/[^A-Za-z0-9_]/g, "_")
		.replace(/_+/g, "_");
}

const AGENT_REQUEST = {
	type: "object",
	properties: {
		prompt: { type: "string" },
		messages: {
			type: "array",
			items: {
				type: "object",
				properties: {
					role: { enum: ["system", "user", "assistant", "tool"] },
					content: { type: ["string", "null"] },
				},
				required: ["role"],
			},
		},
	},
};

function agentPaths(
	base: string,
	agent: OpenApiInput["agents"][number]
): Record<string, unknown> {
	const prefix = `${base}/agents/${encodeURIComponent(agent.id)}`;
	return {
		[`${prefix}/generate`]: {
			post: operation(
				safeOperationId("agent", agent.id, "generate"),
				"agents",
				`Run ${agent.name} to completion`,
				{
					description: agent.description,
					requestBody: jsonBody(AGENT_REQUEST),
					responses: { "200": jsonResponse("Final text, steps, and usage") },
				}
			),
		},
		[`${prefix}/stream`]: {
			post: operation(
				safeOperationId("agent", agent.id, "stream"),
				"agents",
				`Stream ${agent.name}`,
				{
					description: agent.description,
					requestBody: jsonBody(AGENT_REQUEST),
					responses: { "200": SSE_RESPONSE },
				}
			),
		},
	};
}

function workflowPaths(
	base: string,
	workflow: OpenApiInput["workflows"][number]
): Record<string, unknown> {
	const prefix = `${base}/workflows/${encodeURIComponent(workflow.id)}`;
	const startBody = {
		type: "object",
		properties: {
			inputData: describeSchema(workflow.inputSchema),
			initialState: OPEN_OBJECT,
			runId: { type: "string" },
		},
	};
	const runId = {
		name: "runId",
		in: "path",
		required: true,
		schema: { type: "string" },
	};
	const resumeBody = {
		type: "object",
		properties: {
			resumeData: {},
			step: { type: "string", description: "Suspended step path or id" },
		},
	};
	const id = workflow.id;
	return {
		[`${prefix}/start`]: {
			post: operation(
				safeOperationId("workflow", id, "start"),
				"workflows",
				`Start ${workflow.name}`,
				{
					description: workflow.description,
					requestBody: jsonBody(startBody, false),
					responses: { "200": jsonResponse("Run outcome") },
				}
			),
		},
		[`${prefix}/stream`]: {
			post: operation(
				safeOperationId("workflow", id, "stream"),
				"workflows",
				`Start ${workflow.name} and stream its events`,
				{
					requestBody: jsonBody(
						{
							...startBody,
							properties: {
								...startBody.properties,
								streamMode: {
									oneOf: [
										{ enum: ["events", "updates", "values"] },
										{
											type: "array",
											items: { enum: ["events", "updates", "values"] },
										},
									],
								},
							},
						},
						false
					),
					responses: { "200": SSE_RESPONSE },
				}
			),
		},
		[`${prefix}/runs`]: {
			get: operation(
				safeOperationId("workflow", id, "runs"),
				"workflows",
				`List ${workflow.name} runs`,
				{ responses: { "200": jsonResponse("Run history") } }
			),
		},
		[`${prefix}/runs/{runId}`]: {
			get: operation(
				safeOperationId("workflow", id, "run"),
				"workflows",
				`Get one ${workflow.name} run`,
				{
					parameters: [runId],
					responses: { "200": jsonResponse("Run record and trace") },
				}
			),
		},
		[`${prefix}/runs/{runId}/resume`]: {
			post: operation(
				safeOperationId("workflow", id, "resume"),
				"workflows",
				`Resume a suspended ${workflow.name} run`,
				{
					parameters: [runId],
					requestBody: jsonBody(resumeBody, false),
					responses: { "200": jsonResponse("Run outcome") },
				}
			),
		},
		[`${prefix}/runs/{runId}/resume/stream`]: {
			post: operation(
				safeOperationId("workflow", id, "resume_stream"),
				"workflows",
				`Resume a suspended ${workflow.name} run and stream its events`,
				{
					parameters: [runId],
					requestBody: jsonBody(resumeBody, false),
					responses: { "200": SSE_RESPONSE },
				}
			),
		},
		[`${prefix}/runs/{runId}/cancel`]: {
			post: operation(
				safeOperationId("workflow", id, "cancel"),
				"workflows",
				`Cancel an active ${workflow.name} run`,
				{
					parameters: [runId],
					responses: { "200": jsonResponse("Cancellation accepted") },
				}
			),
		},
	};
}

function toolPaths(
	base: string,
	tool: OpenApiInput["tools"][number]
): Record<string, unknown> {
	return {
		[`${base}/tools/${encodeURIComponent(tool.id)}/execute`]: {
			post: operation(
				safeOperationId("tool", tool.id, "execute"),
				"tools",
				`Execute ${tool.name}`,
				{
					description: tool.description,
					requestBody: jsonBody({
						type: "object",
						properties: { input: tool.schema },
						required: ["input"],
					}),
					responses: { "200": jsonResponse("Tool output") },
				}
			),
		},
	};
}

/** Build the OpenAPI 3.1 document for a server. */
export function buildOpenApiDocument(input: OpenApiInput): OpenApiDocument {
	const base = input.basePath;
	const list = (tag: string, summary: string) => ({
		get: operation(safeOperationId("list", tag), tag, summary, {
			responses: { "200": jsonResponse(summary) },
		}),
	});
	const paths: Record<string, unknown> = {
		[`${base}/agents`]: list("agents", "List agents"),
		[`${base}/workflows`]: list("workflows", "List workflows"),
		[`${base}/tools`]: list("tools", "List tools"),
		[`${base}/traces`]: list("traces", "List recent runs"),
		[`${base}/approvals/{approvalId}`]: {
			post: operation("decide_approval", "agents", "Approve or deny a tool", {
				parameters: [
					{
						name: "approvalId",
						in: "path",
						required: true,
						schema: { type: "string" },
					},
				],
				requestBody: jsonBody({
					type: "object",
					properties: {
						approved: { type: "boolean" },
						optionId: { type: "string" },
					},
				}),
				responses: { "200": jsonResponse("Decision recorded") },
			}),
		},
	};
	for (const agent of input.agents) {
		Object.assign(paths, agentPaths(base, agent));
	}
	for (const workflow of input.workflows) {
		Object.assign(paths, workflowPaths(base, workflow));
	}
	for (const tool of input.tools) {
		Object.assign(paths, toolPaths(base, tool));
	}

	const doc: OpenApiDocument = {
		openapi: "3.1.0",
		info: input.info,
		paths,
		components: {
			schemas: {
				Error: {
					type: "object",
					properties: {
						error: {
							type: "object",
							properties: {
								code: { type: "string" },
								message: { type: "string" },
							},
							required: ["code", "message"],
						},
					},
					required: ["error"],
				},
			},
			...(input.secured
				? {
						securitySchemes: {
							bearer: { type: "http", scheme: "bearer" },
						},
					}
				: {}),
		},
	};
	if (input.secured) {
		doc.security = [{ bearer: [] }];
	}
	return doc;
}
