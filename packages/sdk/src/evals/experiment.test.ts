import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../agent/loop.ts";
import {
	createDataset,
	DatasetError,
	loadDataset,
	parseCsvRows,
	parseDataset,
} from "./dataset.ts";
import { contains, exactMatch, toolCallAccuracy } from "./deterministic.ts";
import { type ExperimentAgent, runExperiment } from "./experiment.ts";
import type { EvalFetch } from "./gateway.ts";
import { createScorer } from "./scorer.ts";
import { experimentToPromptRun, uploadExperiment } from "./upload.ts";

const scratch = mkdtempSync(join(tmpdir(), "ryu-sdk-evals-"));
afterAll(() => {
	rmSync(scratch, { force: true, recursive: true });
});

describe("datasets", () => {
	test("createDataset assigns ids and rejects bad items", () => {
		const dataset = createDataset("qa", [
			{ expected: "4", input: "2+2?" },
			{ id: "custom", input: "3+3?" },
		]);
		expect(dataset.items.map((item) => item.id)).toEqual(["case-1", "custom"]);
		expect(() => createDataset("qa", [])).toThrow("has no items");
		expect(() => createDataset("qa", [{ input: " " }])).toThrow(
			"needs a non-empty input"
		);
		expect(() =>
			createDataset("qa", [
				{ id: "a", input: "x" },
				{ id: "a", input: "y" },
			])
		).toThrow("duplicate item id 'a'");
	});

	test("parses CSV with JSON cells and keeps extra columns as metadata", () => {
		expect(parseCsvRows('a,b\n"1,2","x ""y"""\n')).toEqual([
			["a", "b"],
			["1,2", 'x "y"'],
		]);
		const dataset = parseDataset(
			'id,question,answer,context,expectedToolCalls,topic\nq1,Weather in Paris?,sunny,"[""doc""]","[{""name"":""weather""}]",geo\n',
			{ fileName: "qa.csv" }
		);
		expect(dataset.name).toBe("qa.csv");
		expect(dataset.items[0]).toEqual({
			context: ["doc"],
			expected: "sunny",
			expectedToolCalls: [{ name: "weather" }],
			id: "q1",
			input: "Weather in Paris?",
			metadata: { topic: "geo" },
		});
	});

	test("parses JSON envelopes and JSONL, keeping structured expected values", () => {
		const fromEnvelope = parseDataset(
			JSON.stringify({
				items: [{ expected: { a: 1 }, input: "json?", metadata: { tier: 1 } }],
				name: "structured",
			})
		);
		expect(fromEnvelope.name).toBe("structured");
		expect(fromEnvelope.items[0]).toMatchObject({
			expected: { a: 1 },
			metadata: { tier: 1 },
		});
		const fromLines = parseDataset('{"prompt":"a"}\n\n{"input":"b"}\n', {
			format: "jsonl",
			name: "lines",
		});
		expect(fromLines.items.map((item) => item.input)).toEqual(["a", "b"]);
		expect(() =>
			parseDataset('{"input":"a"}\n{oops', { format: "jsonl" })
		).toThrow(DatasetError);
		expect(() =>
			parseDataset('[{"input":"a","expectedToolCalls":[{"nam":"x"}]}]')
		).toThrow("expectedToolCalls");
		// A row with no input must be rejected, not sent as the literal `""`.
		expect(() => parseDataset('[{"expected":"x"}]')).toThrow(
			"needs a non-empty input"
		);
		expect(() =>
			parseDataset("question,answer\n,x\n", { format: "csv" })
		).toThrow("needs a non-empty input");
		expect(parseDataset('[{"input":{"q":1}}]').items[0]?.input).toBe('{"q":1}');
	});

	test("loadDataset reads a file and detects its format", async () => {
		const path = join(scratch, "cases.jsonl");
		writeFileSync(path, '{"input":"hello","expected":"hi"}\n');
		const dataset = await loadDataset(path);
		expect(dataset.name).toBe("cases.jsonl");
		expect(dataset.items).toHaveLength(1);
	});
});

function fakeAgent(
	script: (prompt: string) => AgentEvent[],
	delayMs = 0
): ExperimentAgent & { maxInFlight: number } {
	let inFlight = 0;
	const agent = {
		maxInFlight: 0,
		async *stream(prompt: string): AsyncGenerator<AgentEvent> {
			inFlight += 1;
			agent.maxInFlight = Math.max(agent.maxInFlight, inFlight);
			try {
				if (delayMs > 0) {
					await new Promise((resolve) => setTimeout(resolve, delayMs));
				}
				yield* script(prompt);
			} finally {
				inFlight -= 1;
			}
		},
	};
	return agent;
}

describe("runExperiment", () => {
	test("runs an agent, captures tool calls, scores, and aggregates", async () => {
		const agent = fakeAgent((prompt) => {
			const answer = prompt.includes("France") ? "Paris" : "Rome";
			return [
				{ id: "t1", input: { q: prompt }, name: "search", type: "tool_call" },
				{ id: "t1", name: "search", output: answer, type: "tool_result" },
				{ content: answer, type: "text" },
				{ steps: 2, text: answer, type: "result" },
			];
		}, 5);
		const completed: string[] = [];
		const result = await runExperiment({
			agent,
			concurrency: 2,
			dataset: createDataset("capitals", [
				{
					expected: "Paris",
					expectedToolCalls: [{ name: "search" }],
					input: "Capital of France?",
				},
				{ expected: "Berlin", input: "Capital of Germany?" },
				{ expected: "Rome", input: "Capital of Italy?" },
			]),
			onCaseComplete: (entry) => completed.push(entry.id),
			scorers: [exactMatch(), toolCallAccuracy()],
			thresholds: { exact_match: 0.6 },
		});
		expect(agent.maxInFlight).toBe(2);
		expect(completed.sort()).toEqual(["case-1", "case-2", "case-3"]);
		expect(result.cases.map((entry) => entry.output)).toEqual([
			"Paris",
			"Rome",
			"Rome",
		]);
		expect(result.cases[0]?.toolCalls).toEqual([
			{ input: { q: "Capital of France?" }, name: "search", output: "Paris" },
		]);
		expect(result.cases.map((entry) => entry.pass)).toEqual([
			true,
			false,
			true,
		]);
		expect(result.scores.exact_match).toEqual({
			executed: 3,
			mean: 2 / 3,
			passRate: 2 / 3,
			skipped: 0,
		});
		expect(result.scores.tool_call_accuracy).toEqual({
			executed: 1,
			mean: 1,
			passRate: 1,
			skipped: 2,
		});
		expect(result.thresholds).toEqual([
			{ mean: 2 / 3, pass: true, scorer: "exact_match", threshold: 0.6 },
		]);
		expect(result.pass).toBe(true);
		expect(result.name).toBe("capitals");
	});

	test("a function target that throws or times out errors only that case", async () => {
		const result = await runExperiment({
			dataset: [{ input: "ok" }, { input: "boom" }, { input: "slow" }],
			fn: async (item) => {
				if (item.input === "boom") {
					throw new Error("target failed");
				}
				if (item.input === "slow") {
					await new Promise((resolve) => setTimeout(resolve, 200));
				}
				return { output: item.input, toolCalls: [] };
			},
			scorers: [contains({ value: "ok" })],
			thresholds: 0.1,
			timeoutMs: 50,
		});
		expect(result.cases.map((entry) => entry.error)).toEqual([
			undefined,
			"target failed",
			"case timed out after 50ms",
		]);
		expect(result.errored).toBe(2);
		expect(result.scores.contains).toMatchObject({ executed: 1, mean: 1 });
		expect(result.pass).toBe(false);
	});

	test("agent errors and approval pauses fail the case", async () => {
		const result = await runExperiment({
			agent: fakeAgent((prompt) =>
				prompt === "a"
					? [{ message: "gateway down", type: "error" }]
					: [
							{
								approvalId: "ap1",
								summary: "delete files",
								type: "approval_requested",
							},
						]
			),
			dataset: [{ input: "a" }, { input: "b" }],
			scorers: [exactMatch()],
		});
		expect(result.cases[0]?.error).toBe("gateway down");
		expect(result.cases[1]?.error).toContain("paused for approval");
	});

	test("unmeasured thresholds fail and bad options are rejected", async () => {
		const result = await runExperiment({
			dataset: [{ input: "x" }],
			fn: () => "x",
			scorers: [exactMatch()],
			thresholds: { exact_match: 0.5 },
		});
		expect(result.thresholds[0]).toEqual({
			mean: null,
			pass: false,
			scorer: "exact_match",
			threshold: 0.5,
		});
		expect(result.pass).toBe(false);

		const base = { dataset: [{ input: "x" }], fn: () => "x" };
		await expect(runExperiment({ ...base, scorers: [] })).rejects.toThrow(
			"at least one scorer"
		);
		await expect(
			runExperiment({ ...base, scorers: [exactMatch(), exactMatch()] })
		).rejects.toThrow("duplicate scorer id");
		await expect(
			runExperiment({ ...base, concurrency: 0, scorers: [exactMatch()] })
		).rejects.toThrow("concurrency");
		await expect(
			runExperiment({
				...base,
				scorers: [exactMatch()],
				thresholds: { nope: 0.5 },
			})
		).rejects.toThrow("unknown scorer 'nope'");
		await expect(
			runExperiment({ dataset: [{ input: "x" }], scorers: [exactMatch()] })
		).rejects.toThrow("exactly one of agent or fn");
	});

	test("bad thresholds are rejected before any case runs", async () => {
		let calls = 0;
		const fn = () => {
			calls += 1;
			return "x";
		};
		await expect(
			runExperiment({
				dataset: [{ input: "x" }],
				fn,
				scorers: [exactMatch()],
				thresholds: { typo: 0.5 },
			})
		).rejects.toThrow("unknown scorer 'typo'");
		await expect(
			runExperiment({
				dataset: [{ input: "x" }],
				fn,
				scorers: [exactMatch()],
				thresholds: 2,
			})
		).rejects.toThrow("between 0 and 1");
		expect(calls).toBe(0);
	});
});

describe("uploadExperiment", () => {
	test("saves the run to a Core prompt suite in the Gateway result shape", async () => {
		const result = await runExperiment({
			dataset: [
				{ expected: "4", id: "math", input: "2+2?" },
				{ expected: "x", input: "skip?" },
			],
			fn: (item) => (item.id === "math" ? "4" : "y"),
			name: "smoke",
			scorers: [
				exactMatch(),
				createScorer({
					id: "always_skip",
					score: () => ({ score: 0, skipped: true }),
				}),
			],
		});
		let sentUrl = "";
		let sentAuth: string | null | undefined;
		let sentBody: unknown;
		const fetchImpl: EvalFetch = async (url, init) => {
			sentUrl = url;
			sentAuth = new Headers(init?.headers).get("authorization");
			sentBody = JSON.parse(String(init?.body));
			return Response.json(
				{
					run: {
						created_at: 1,
						id: "run_1",
						name: "smoke",
						request: {},
						result: {},
						suite_id: "suite/1",
					},
				},
				{ status: 201 }
			);
		};
		const saved = await uploadExperiment(result, {
			baseUrl: "http://core.test/",
			fetch: fetchImpl,
			name: "smoke",
			suiteId: "suite/1",
			token: "core-token",
		});
		expect(saved).toMatchObject({ id: "run_1", suite_id: "suite/1" });
		expect(sentUrl).toBe("http://core.test/api/prompt-suites/suite%2F1/runs");
		expect(sentAuth).toBe("Bearer core-token");
		expect(sentBody).toMatchObject({
			name: "smoke",
			request: { scorers: ["exact_match", "always_skip"], source: "sdk" },
		});
		const promptRun = experimentToPromptRun(result);
		expect(promptRun.aggregate).toEqual({
			assertion_pass_rate: 0.5,
			mean_overall: 0.5,
			total_cases: 2,
		});
		expect(promptRun.cases[0]).toMatchObject({
			assertions: [
				{ executed: true, kind: "exact_match", pass: true, score: 1 },
				{ executed: false, kind: "always_skip", pass: false, score: 0 },
			],
			assertions_pass: true,
			overall: 1,
			prompt: "2+2?",
			response_text: "4",
		});
	});

	test("resolves the Core bearer like the other local Ryu clients", async () => {
		const result = await runExperiment({
			dataset: [{ input: "x" }],
			fn: () => "x",
			scorers: [exactMatch()],
		});
		const dataDir = join(scratch, "ryu-data");
		mkdirSync(join(dataDir, "secrets"), { recursive: true });
		writeFileSync(
			join(dataDir, "secrets", "node-auth.token"),
			"local-node-token\n"
		);
		const seen: { auth: string | null; url: string }[] = [];
		const fetchImpl: EvalFetch = async (url, init) => {
			seen.push({ auth: new Headers(init?.headers).get("authorization"), url });
			return Response.json(
				{ run: { created_at: 1, id: "r", name: "n", suite_id: "s" } },
				{ status: 201 }
			);
		};
		const env =
			(values: Record<string, string>) =>
			(key: string): string | undefined =>
				values[key];
		// RYU_TOKEN is honored when RYU_CORE_TOKEN is unset.
		await uploadExperiment(result, {
			env: env({ RYU_DIR: dataDir, RYU_TOKEN: "env-token" }),
			fetch: fetchImpl,
			suiteId: "s",
		});
		// A loopback node falls back to its own token file.
		await uploadExperiment(result, {
			env: env({ RYU_DIR: dataDir }),
			fetch: fetchImpl,
			suiteId: "s",
		});
		// A remote node never receives the local node token.
		await uploadExperiment(result, {
			baseUrl: "https://core.example",
			env: env({ RYU_DIR: dataDir }),
			fetch: fetchImpl,
			suiteId: "s",
		});
		expect(seen).toEqual([
			{
				auth: "Bearer env-token",
				url: "http://127.0.0.1:7980/api/prompt-suites/s/runs",
			},
			{
				auth: "Bearer local-node-token",
				url: "http://127.0.0.1:7980/api/prompt-suites/s/runs",
			},
			{ auth: null, url: "https://core.example/api/prompt-suites/s/runs" },
		]);
	});

	test("reports Core errors", async () => {
		const result = await runExperiment({
			dataset: [{ input: "x" }],
			fn: () => "x",
			scorers: [exactMatch()],
		});
		await expect(
			uploadExperiment(result, {
				baseUrl: "http://core.test",
				fetch: async () =>
					Response.json({ error: "prompt suite not found" }, { status: 404 }),
				suiteId: "missing",
			})
		).rejects.toThrow("Core 404");
	});
});
