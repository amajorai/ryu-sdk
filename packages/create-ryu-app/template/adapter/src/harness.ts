/**
 * __APP_DISPLAY_NAME__ — a local runner for the capability adapter body.
 *
 * Core runs `adapters/search.js` inside its plugin sandbox as the body of an async
 * function with exactly four injected bindings: `input` (the canonical verb
 * arguments), `defaults` (the provider's resolved `arg_defaults`), `callTool(args)`
 * (the provider tool the manifest binds, `provider.tool`) and `callNamed(id, args)`
 * (one of the extra tools `adapter.tools` allowlists). This module splices the
 * same fragment into the same signature, with the provider stubbed from each case.
 *
 * The body runs in a fresh `node:vm` context holding only what Core's sandbox
 * provides: the JavaScript built-ins plus `console`, timers, `URL`,
 * `URLSearchParams`, `TextEncoder` and `TextDecoder`. `fetch`, `process`, `Buffer`,
 * `require`, `crypto` and the filesystem do not exist there, so a body that reaches
 * for them fails here as it would in Core. Tool arguments, provider answers and
 * the result cross the boundary as JSON, as they do in Core. This is a fidelity
 * aid, not a security boundary: run only code you trust.
 *
 * `cases.json` uses the `tools/toolsmith` case format, so the same file also
 * drives `node tools/toolsmith/index.mjs verify` inside the Ryu repository.
 *
 *   bun run src/harness.ts   # run every case and print the results
 *   bun test                 # the same cases, as assertions
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

/** The package root: one level above this file. */
export const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Provider responses a case feeds to `callTool` / `callNamed`, in call order. */
export interface ProviderFixture {
	call?: unknown[];
	named?: Record<string, unknown[]>;
}

/** One golden case from `cases.json`. */
export interface AdapterCase {
	defaults?: Record<string, unknown>;
	expect?: unknown;
	expectCalls?: RecordedCall[];
	expectError?: string;
	input?: Record<string, unknown>;
	name: string;
	provider?: ProviderFixture;
}

/** The `cases.json` file shape. */
export interface CaseFile {
	adapter_tools?: string[];
	cases: AdapterCase[];
	code_file: string;
	kind: "adapter";
	tool: string;
}

/** One provider call the body made, as `expectCalls` spells it. */
export interface RecordedCall {
	args: unknown;
	path: string;
}

/** The host side of `callTool` / `callNamed`: JSON in, JSON out. */
interface ProviderBridge {
	callNamed: (id: string, argsJson: string) => Promise<string>;
	callTool: (argsJson: string) => Promise<string>;
}

type AdapterProgram = (bridge: ProviderBridge) => Promise<unknown>;

/**
 * Engine built-ins a Bun or Node context carries that Core's QuickJS sandbox does
 * not, removed so a body cannot pass here by depending on them.
 */
const ENGINE_ONLY_GLOBALS = ["WebAssembly", "Intl", "ShadowRealm", "Temporal"];

/** Format console arguments the way Core's sandbox does before logging them. */
function formatLogLine(args: unknown[]): string {
	return args
		.map((arg) => (typeof arg === "string" ? arg : String(JSON.stringify(arg))))
		.join(" ");
}

/**
 * The globals Core's sandbox bootstrap defines on top of the JavaScript built-ins.
 * Console output is collected into `logs` instead of printed.
 */
function sandboxGlobals(logs: string[]): Record<string, unknown> {
	const write = (...args: unknown[]) => {
		logs.push(formatLogLine(args));
	};
	return {
		console: {
			debug: write,
			error: write,
			info: write,
			log: write,
			warn: write,
		},
		clearInterval,
		clearTimeout,
		queueMicrotask,
		setInterval,
		setTimeout,
		TextDecoder,
		TextEncoder,
		URL,
		URLSearchParams,
	};
}

/**
 * Compile the body into an adapter program inside a fresh sandbox-shaped context,
 * the way Core's `build_capability_adapter_program` does: `input` and `defaults`
 * are JSON literals, and `callTool` / `callNamed` exchange JSON with the host.
 */
function compileAdapter(
	body: string,
	input: unknown,
	defaults: unknown,
	logs: string[]
): AdapterProgram {
	const context = createContext(sandboxGlobals(logs));
	runInContext(
		ENGINE_ONLY_GLOBALS.map((name) => `delete globalThis.${name};`).join("\n"),
		context
	);
	const program = `"use strict";
(async (__ryuHarnessBridge) => {
const input = ${JSON.stringify(input ?? {})};
const defaults = ${JSON.stringify(defaults ?? {})};
const callTool = async (a) => JSON.parse(await __ryuHarnessBridge.callTool(JSON.stringify(a ?? {})));
const callNamed = async (id, a) => JSON.parse(await __ryuHarnessBridge.callNamed(String(id), JSON.stringify(a ?? {})));
${body}
})`;
	return runInContext(program, context) as AdapterProgram;
}

/** Core reports a thrown value by its message, or its string form. */
function errorMessage(error: unknown): string {
	if (error && typeof error === "object" && "message" in error) {
		const { message } = error as { message: unknown };
		if (message) {
			return String(message);
		}
	}
	return String(error);
}

/** Read `cases.json` from the package root. */
export function loadCases(): CaseFile {
	return JSON.parse(readFileSync(join(PACKAGE_DIR, "cases.json"), "utf8"));
}

/** Read the adapter fragment `cases.json` names. */
export function loadBody(codeFile: string): string {
	return readFileSync(join(PACKAGE_DIR, codeFile), "utf8");
}

/**
 * Run the adapter body once against a case's fixtures.
 *
 * `callNamed` enforces the manifest's `adapter.tools` allowlist, as Core does
 * host-side, so a case cannot pass against a call the runtime would refuse. The
 * result is JSON-serialized as Core serializes it, so `undefined` comes back as
 * `null` and a non-serializable value is an error.
 */
export async function runAdapter(
	body: string,
	testCase: AdapterCase,
	adapterTools: string[] = []
): Promise<{ calls: RecordedCall[]; logs: string[]; value: unknown }> {
	const calls: RecordedCall[] = [];
	const logs: string[] = [];
	const primary = [...(testCase.provider?.call ?? [])];
	const named = new Map(
		Object.entries(testCase.provider?.named ?? {}).map(([id, responses]) => [
			id,
			[...responses],
		])
	);
	const bridge: ProviderBridge = {
		callTool: async (argsJson) => {
			calls.push({ path: "callTool", args: JSON.parse(argsJson) });
			if (primary.length === 0) {
				throw new Error(
					`callTool was called but case "${testCase.name}" has no response left in provider.call`
				);
			}
			return JSON.stringify(primary.shift() ?? null);
		},
		callNamed: async (id, argsJson) => {
			calls.push({ path: `callNamed:${id}`, args: JSON.parse(argsJson) });
			if (!adapterTools.includes(id)) {
				throw new Error(
					`callNamed("${id}") is not in the manifest's adapter.tools allowlist`
				);
			}
			const queue = named.get(id);
			if (!queue || queue.length === 0) {
				throw new Error(
					`callNamed("${id}") has no response left in provider.named.${id}`
				);
			}
			return JSON.stringify(queue.shift() ?? null);
		},
	};

	let result: unknown;
	try {
		const run = compileAdapter(body, testCase.input, testCase.defaults, logs);
		result = await run(bridge);
	} catch (error) {
		throw new Error(errorMessage(error));
	}
	let wire: string;
	try {
		wire = JSON.stringify(result ?? null) ?? "null";
	} catch (error) {
		throw new Error(
			`program returned a non-serializable value: ${errorMessage(error)}`
		);
	}
	return { calls, logs, value: JSON.parse(wire) };
}

if (import.meta.main) {
	const spec = loadCases();
	const body = loadBody(spec.code_file);
	for (const testCase of spec.cases) {
		try {
			const { value } = await runAdapter(body, testCase, spec.adapter_tools);
			process.stdout.write(
				`ok   ${testCase.name}\n     ${JSON.stringify(value)}\n`
			);
		} catch (error) {
			process.stdout.write(`err  ${testCase.name}\n     ${String(error)}\n`);
		}
	}
}
