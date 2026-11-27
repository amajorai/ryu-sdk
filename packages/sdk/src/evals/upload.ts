/**
 * Upload an experiment to a Core prompt suite (`POST
 * /api/prompt-suites/:id/runs`), so SDK runs sit beside Desktop Prompt Studio
 * runs and can be reviewed there. The stored result keeps the Gateway eval
 * run's field names (`cases[].response_text`, `overall`, `assertions`, and
 * `aggregate.mean_overall`) with one assertion row per scorer, plus the full
 * SDK result under `experiment`.
 */

import { z } from "zod";
import { resolveCoreTarget } from "../cli/install.ts";
import type { EvalFetch } from "./gateway.ts";
import type { ExperimentResult } from "./types.ts";

/** Options for {@link uploadExperiment}. */
export interface UploadExperimentOptions {
	/** Core base URL. Defaults to `RYU_CORE_URL`, then the local node. */
	baseUrl?: string;
	/**
	 * Environment reader (defaults to `process.env`). Injectable for tests and
	 * for runtimes without `process`.
	 */
	env?: (key: string) => string | undefined;
	/** Injectable transport (defaults to the global `fetch`). */
	fetch?: EvalFetch;
	/** Run name (defaults to the experiment name and start time). */
	name?: string;
	/** Prompt suite id (Desktop → Prompt Studio, or `GET /api/prompt-suites`). */
	suiteId: string;
	/**
	 * Core bearer token. Defaults to `RYU_CORE_TOKEN`, then `RYU_TOKEN`, then
	 * (only for a loopback Core URL) the local node's own token.
	 */
	token?: string;
}

/** The saved Core prompt run. */
export interface UploadedRun {
	created_at: number;
	id: string;
	name: string;
	suite_id: string;
}

const savedRunSchema = z.object({
	run: z.looseObject({
		created_at: z.number(),
		id: z.string(),
		name: z.string(),
		suite_id: z.string(),
	}),
});

function processEnv(key: string): string | undefined {
	const value = globalThis.process?.env?.[key]?.trim();
	return value ? value : undefined;
}

/**
 * The Core URL and bearer for an upload. Explicit options win; otherwise the
 * same resolution `ryu install` uses applies, so the node's own token is only
 * ever read for a loopback URL and never sent to a remote node.
 */
function uploadTarget(options: UploadExperimentOptions): {
	baseUrl: string;
	token: string | null;
} {
	const readEnv = options.env ?? processEnv;
	const explicitUrl = options.baseUrl?.trim();
	const target = resolveCoreTarget((key) =>
		key === "RYU_CORE_URL" && explicitUrl ? explicitUrl : readEnv(key)
	);
	return { baseUrl: target.baseUrl, token: options.token ?? target.token };
}

function mean(values: number[]): number {
	return values.length === 0
		? 0
		: values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Map an experiment onto the Gateway eval-run shape Prompt Studio renders. */
export function experimentToPromptRun(result: ExperimentResult) {
	const cases = result.cases.map((entry) => {
		const rows = Object.entries(entry.scores).map(([kind, score]) => ({
			detail: score.reason ?? "",
			executed: !score.skipped,
			kind,
			pass: score.pass,
			score: score.score,
		}));
		const executed = rows.filter((row) => row.executed);
		const overall = mean(executed.map((row) => row.score));
		return {
			assertion_score: executed.length === 0 ? null : overall,
			assertions: rows,
			assertions_pass: entry.pass,
			error: entry.error ?? null,
			id: entry.id,
			latency_ms: Math.round(entry.durationMs),
			metadata: entry.metadata ?? {},
			overall,
			prompt: entry.input,
			response_text: entry.output,
		};
	});
	return {
		aggregate: {
			assertion_pass_rate: mean(
				cases.map((entry) => (entry.assertions_pass ? 1 : 0))
			),
			mean_overall: mean(cases.map((entry) => entry.overall)),
			total_cases: cases.length,
		},
		cases,
		experiment: result,
		finished_at: result.finishedAt,
		started_at: result.startedAt,
		tags: { source: "sdk" },
	};
}

/** Save an experiment as a run in a Core prompt suite. */
export async function uploadExperiment(
	result: ExperimentResult,
	options: UploadExperimentOptions
): Promise<UploadedRun> {
	if (options.suiteId.trim() === "") {
		throw new TypeError("uploadExperiment needs a suiteId");
	}
	const { baseUrl, token } = uploadTarget(options);
	const url = `${baseUrl}/api/prompt-suites/${encodeURIComponent(options.suiteId)}/runs`;
	const headers: Record<string, string> = {
		Accept: "application/json",
		"Content-Type": "application/json",
	};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
	const response = await doFetch(url, {
		body: JSON.stringify({
			name: options.name ?? `${result.name} · ${result.startedAt}`,
			request: {
				dataset: result.name,
				scorers: Object.keys(result.scores),
				source: "sdk",
				thresholds: result.thresholds,
			},
			result: experimentToPromptRun(result),
		}),
		headers,
		method: "POST",
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(
			`[ryu-sdk] Core ${response.status} saving prompt run: ${text.slice(0, 500)}`
		);
	}
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		body = null;
	}
	const parsed = savedRunSchema.safeParse(body);
	if (!parsed.success) {
		throw new Error("[ryu-sdk] Core returned an unexpected prompt run body");
	}
	return parsed.data.run;
}
