/**
 * `ryu build` tests: the generated files of every target are snapshotted, the
 * argument parser is checked, the edge shim is held in lockstep with the Rust
 * egress blocklist, and real bundles are produced with `Bun.build` and then
 * executed (Cloudflare, Netlify, and Vercel entries are self-contained, so
 * they run straight from the output directory).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
	BUILD_TARGETS,
	buildProject,
	deploymentName,
	NATIVE_VERSION_RANGE,
	parseBuildArgs,
	planTarget,
	projectName,
} from "./build.ts";
import {
	EDGE_BLOCKED_PROVIDER_PATTERNS,
	edgeNativeShimSource,
} from "./edge-native.ts";

const SRC = resolve(import.meta.dir, "..");
const REPO = resolve(SRC, "../../..");

/** A callable export (zod 4's `callable` is a factory, not a schema). */
const callable = z.custom<(...args: unknown[]) => unknown>(
	(value) => typeof value === "function"
);

const PLAN_INPUT = {
	entryImport: "../../../src/ryu.ts",
	name: "@acme/Support Bot",
	nativeVersion: "^0.4.0",
	serverModule: "@ryuhq/sdk/server",
	nodeModule: "@ryuhq/sdk/server/node",
};

describe("planTarget", () => {
	for (const target of BUILD_TARGETS) {
		it(`generates the ${target} files`, () => {
			const plan = planTarget(target, PLAN_INPUT);
			expect({
				bundleFile: plan.bundleFile,
				platform: plan.platform,
				native: plan.native,
				hint: plan.hint,
				entrySource: plan.entrySource,
				files: plan.files,
			}).toMatchSnapshot();
		});
	}
});

describe("deploymentName / projectName", () => {
	it("sanitizes names for every vendor", () => {
		expect(deploymentName("@acme/Support Bot!")).toBe("support-bot");
		expect(deploymentName("---")).toBe("ryu-app");
		expect(deploymentName("x".repeat(80))).toHaveLength(63);
	});

	it("prefers --name, then package.json, then the directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "ryu-name-"));
		try {
			expect(projectName(dir, "Explicit")).toBe("explicit");
			expect(projectName(dir)).toBe(
				deploymentName(dir.split("/").at(-1) ?? "")
			);
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({ name: "my-app" })
			);
			expect(projectName(dir)).toBe("my-app");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("parseBuildArgs", () => {
	it("parses targets, entry, out, and name", () => {
		expect(
			parseBuildArgs([
				"app.ts",
				"--target",
				"node,docker,node",
				"--out=dist",
				"--name",
				"x",
			])
		).toEqual({
			entry: "app.ts",
			outDir: "dist",
			name: "x",
			targets: ["node", "docker"],
		});
		expect(parseBuildArgs(["--target=vercel"])).toEqual({
			entry: "src/ryu.ts",
			outDir: ".ryu/build",
			name: undefined,
			targets: ["vercel"],
		});
	});

	it("rejects missing or unknown targets and stray options", () => {
		expect(() => parseBuildArgs([])).toThrow(/--target is required/);
		expect(() => parseBuildArgs(["--target", "heroku"])).toThrow(
			/unknown target/
		);
		expect(() => parseBuildArgs(["--target"])).toThrow(/requires a value/);
		expect(() => parseBuildArgs(["--target", "node", "--prod"])).toThrow(
			/unknown option --prod/
		);
		expect(() => parseBuildArgs(["a.ts", "b.ts", "--target", "node"])).toThrow(
			/at most one entry/
		);
	});
});

describe("edge native shim", () => {
	it("mirrors the Rust egress blocklist", () => {
		const rust = readFileSync(
			join(REPO, "crates/sdk/core/src/gateway.rs"),
			"utf8"
		);
		const block =
			/BLOCKED_PROVIDER_PATTERNS: &\[&str\] = &\[([\s\S]*?)\];/.exec(rust)?.[1];
		const patterns = [...(block ?? "").matchAll(/r"([^"]+)"/g)].map(
			(match) => match[1] ?? ""
		);
		expect(patterns.length).toBeGreaterThan(0);
		expect<string[]>([...EDGE_BLOCKED_PROVIDER_PATTERNS]).toEqual(patterns);
	});

	it("resolves the gateway from env and blocks direct providers", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ryu-shim-"));
		const previous = process.env.RYU_GATEWAY_URL;
		try {
			const file = join(dir, "shim.mjs");
			writeFileSync(file, edgeNativeShimSource());
			const shim = z
				.object({
					resolveGatewayUrl: callable,
					resolveGatewayToken: callable,
					assertAllowedEgress: callable,
					ModelClient: z.unknown(),
				})
				.parse(await import(file));
			process.env.RYU_GATEWAY_URL = " https://gw.example ";
			expect(shim.resolveGatewayUrl()).toBe("https://gw.example");
			process.env.RYU_GATEWAY_URL = "";
			expect(shim.resolveGatewayUrl()).toBe("http://127.0.0.1:7981");
			expect(() =>
				shim.assertAllowedEgress("https://API.OpenAI.com/v1")
			).toThrow(/direct provider egress is not allowed/);
			expect(() =>
				shim.assertAllowedEgress("http://127.0.0.1:7981")
			).not.toThrow();
			const ModelClient = shim.ModelClient as new (
				model: string,
				baseUrl: string | null,
				token: string | null
			) => unknown;
			expect(
				() => new ModelClient("m", "https://api.openai.com", null)
			).toThrow(/direct provider egress is not allowed/);
		} finally {
			if (previous === undefined) {
				delete process.env.RYU_GATEWAY_URL;
			} else {
				process.env.RYU_GATEWAY_URL = previous;
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("edge native shim gateway clients", () => {
	interface Seen {
		authorization?: string;
		body: unknown;
		path?: string;
	}
	const seen: Seen[] = [];
	let base = "";
	const gateway = createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => {
			raw += String(chunk);
		});
		req.on("end", () => {
			const body = z
				.object({ stream: z.boolean().optional() })
				.passthrough()
				.parse(JSON.parse(raw));
			seen.push({
				path: req.url,
				authorization: req.headers.authorization,
				body,
			});
			if (req.url === "/v1/embeddings") {
				res.setHeader("content-type", "application/json");
				res.end(
					JSON.stringify({
						data: [
							{ index: 1, embedding: [3, 4] },
							{ index: 0, embedding: [1, 2] },
						],
						usage: { prompt_tokens: 4, total_tokens: 4 },
					})
				);
				return;
			}
			if (req.url !== "/v1/chat/completions") {
				res.statusCode = 404;
				res.end("nope");
				return;
			}
			if (body.stream) {
				res.setHeader("content-type", "text/event-stream");
				// Split a frame across writes to exercise the line buffer.
				res.write(
					'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choi'
				);
				res.write(
					'ces":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n'
				);
				res.write(": keep-alive\n\ndata: [DONE]\n\n");
				res.end();
				return;
			}
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify({
					choices: [{ message: { content: "pong" }, finish_reason: "stop" }],
					usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
				})
			);
		});
	});
	let shim: Record<string, unknown> = {};
	let dir = "";

	beforeAll(async () => {
		await new Promise<void>((done) => gateway.listen(0, "127.0.0.1", done));
		base = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/`;
		dir = mkdtempSync(join(tmpdir(), "ryu-shim-gw-"));
		const file = join(dir, "shim.mjs");
		writeFileSync(file, edgeNativeShimSource());
		shim = await import(file);
	});

	afterAll(() => {
		gateway.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const modelClient = () =>
		shim.ModelClient as new (
			model: string,
			baseUrl: string | null,
			token: string | null
		) => {
			chat(messages: unknown[]): Promise<unknown>;
			stream(
				messages: unknown[],
				callback: (error: Error | null, delta: unknown) => void
			): void;
		};

	it("sends non-streaming chat to /v1/chat/completions with the token", async () => {
		seen.length = 0;
		const ModelClient = modelClient();
		const client = new ModelClient("gpt-x", base, "secret");
		const messages = [{ role: "user", content: "ping" }];
		expect(await client.chat(messages)).toEqual({
			content: "pong",
			finishReason: "stop",
			promptTokens: 3,
			completionTokens: 1,
			totalTokens: 4,
		});
		expect(seen).toEqual([
			{
				path: "/v1/chat/completions",
				authorization: "Bearer secret",
				body: { model: "gpt-x", messages, stream: false },
			},
		]);
	});

	it("streams deltas across split frames and ends with a null delta", async () => {
		const ModelClient = modelClient();
		const client = new ModelClient("gpt-x", base, null);
		const deltas = await new Promise<unknown[]>((done, fail) => {
			const collected: unknown[] = [];
			client.stream([{ role: "user", content: "hi" }], (error, delta) => {
				if (error) {
					fail(error);
				} else if (delta === null || delta === undefined) {
					done(collected);
				} else {
					collected.push(delta);
				}
			});
		});
		expect(deltas).toEqual([
			{ content: "Hel", finishReason: undefined },
			{ content: "lo", finishReason: "stop" },
		]);
		expect(seen.at(-1)?.authorization).toBeUndefined();
	});

	it("reports gateway HTTP errors through the stream callback", async () => {
		const ModelClient = modelClient();
		const client = new ModelClient("gpt-x", `${base}missing`, null);
		const error = await new Promise<unknown>((done) => {
			client.stream([], (failure) => {
				if (failure) {
					done(failure);
				}
			});
		});
		expect(String(error)).toContain("HTTP 404");
		await expect(client.chat([])).rejects.toThrow(/HTTP 404/);
	});

	it("embeds through /v1/embeddings in input order", async () => {
		const EmbeddingClient = shim.EmbeddingClient as new (
			model: string,
			baseUrl: string | null,
			token: string | null
		) => { embed(inputs: string[]): Promise<unknown> };
		const client = new EmbeddingClient("embed-x", base, null);
		expect(await client.embed(["a", "b"])).toEqual({
			embeddings: [
				{ index: 0, vector: [1, 2] },
				{ index: 1, vector: [3, 4] },
			],
			promptTokens: 4,
			totalTokens: 4,
		});
		expect(seen.at(-1)?.body).toEqual({ model: "embed-x", input: ["a", "b"] });
	});
});

describe("native version range", () => {
	it("tracks the SDK and native addon versions", () => {
		const version = (path: string) =>
			z
				.object({ version: z.string() })
				.parse(JSON.parse(readFileSync(join(REPO, path), "utf8"))).version;
		const sdk = version("packages/sdk/package.json");
		expect(NATIVE_VERSION_RANGE).toBe(`^${sdk}`);
		expect(version("crates/sdk/napi/package.json")).toBe(sdk);
	});
});

describe("buildProject (real bundles)", () => {
	let root: string;
	const outDir = () => join(root, ".ryu/build");
	const build = (target: (typeof BUILD_TARGETS)[number]) =>
		buildProject({
			entry: join(root, "src/ryu.ts"),
			outDir: outDir(),
			name: "demo",
			target,
			serverModule: join(SRC, "server/index.ts"),
			nodeModule: join(SRC, "server/node.ts"),
		});

	beforeAll(() => {
		// The fixture project has no `auth` hook; deployed servers refuse to start
		// that way unless the deployment says the API is meant to be public.
		process.env.RYU_SERVER_PUBLIC = "1";
		root = mkdtempSync(join(tmpdir(), "ryu-build-"));
		const src = join(root, "src");
		require("node:fs").mkdirSync(src, { recursive: true });
		writeFileSync(
			join(src, "ryu.ts"),
			`import { z } from ${JSON.stringify(require.resolve("zod", { paths: [SRC] }))};
import { defineTool } from ${JSON.stringify(join(SRC, "runnable/tool.ts"))};
import { createStep } from ${JSON.stringify(join(SRC, "workflow/step.ts"))};
import { createWorkflow } from ${JSON.stringify(join(SRC, "workflow/workflow.ts"))};

export const tools = {
	echo: defineTool({
		id: "echo",
		name: "Echo",
		schema: z.object({ text: z.string() }),
		run: async ({ text }) => ({ echoed: text }),
	}),
};

const shout = createStep({
	id: "shout",
	execute: ({ inputData }: { inputData: { text: string } }) => inputData.text.toUpperCase(),
});

export const workflows = { shout: createWorkflow({ id: "shout" }).then(shout).commit() };
`
		);
	});

	afterAll(() => {
		Reflect.deleteProperty(process.env, "RYU_SERVER_PUBLIC");
		rmSync(root, { recursive: true, force: true });
	});

	it("builds a self-contained Cloudflare worker that serves the project", async () => {
		const result = await build("cloudflare");
		expect(result.files).toEqual(["worker.mjs", "wrangler.toml"]);
		const bundle = readFileSync(join(result.dir, "worker.mjs"), "utf8");
		expect(bundle).not.toContain('.node"');
		const worker = z
			.object({ default: z.object({ fetch: callable }) })
			.parse(await import(join(result.dir, "worker.mjs")));
		const res = z.instanceof(Response).parse(
			await worker.default.fetch(
				new Request("https://w.example/api/tools/echo/execute", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ input: { text: "hi" } }),
				})
			)
		);
		expect(await res.json()).toMatchObject({ output: { echoed: "hi" } });
	});

	it("builds a Netlify function and a Vercel Build Output that serve the project", async () => {
		const netlify = await build("netlify");
		expect(netlify.files).toEqual([
			"netlify.toml",
			"netlify/functions/ryu.mjs",
			"public/.keep",
		]);
		const fn = z
			.object({ default: callable, config: z.object({ path: z.string() }) })
			.parse(await import(join(netlify.dir, "netlify/functions/ryu.mjs")));
		expect(fn.config).toEqual({ path: "/*" });
		const started = z.instanceof(Response).parse(
			await fn.default(
				new Request("https://n.example/api/workflows/shout/start", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ inputData: { text: "ok" } }),
				})
			)
		);
		expect(await started.json()).toMatchObject({
			status: "success",
			result: "OK",
		});

		const vercel = await build("vercel");
		expect(vercel.files).toEqual([
			".vercel/output/config.json",
			".vercel/output/functions/index.func/.vc-config.json",
			".vercel/output/functions/index.func/index.mjs",
		]);
		const handler = z
			.object({ default: callable })
			.parse(
				await import(
					join(vercel.dir, ".vercel/output/functions/index.func/index.mjs")
				)
			);
		const listener = handler.default as Parameters<typeof createServer>[0];
		const server = createServer(listener);
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		try {
			const { port } = server.address() as AddressInfo;
			const res = await fetch(`http://127.0.0.1:${port}/api/tools`);
			expect(await res.json()).toMatchObject({ tools: [{ id: "echo" }] });
		} finally {
			server.close();
			server.closeAllConnections();
		}
	});

	it("builds node and docker outputs that keep the native addon external", async () => {
		const node = await build("node");
		expect(node.files).toEqual(["package.json", "server.mjs"]);
		const bundle = readFileSync(join(node.dir, "server.mjs"), "utf8");
		expect(bundle).toContain('from "@ryuhq/sdk-native"');
		expect(
			JSON.parse(readFileSync(join(node.dir, "package.json"), "utf8"))
		).toMatchObject({
			name: "demo",
			dependencies: { "@ryuhq/sdk-native": NATIVE_VERSION_RANGE },
		});
		const docker = await build("docker");
		expect(docker.files).toEqual([
			".dockerignore",
			"Dockerfile",
			"package.json",
			"server.mjs",
		]);
		// The scratch directory never survives a build.
		expect(require("node:fs").existsSync(join(outDir(), ".ryu-build"))).toBe(
			false
		);
	});

	it("fails clearly when the entry is missing", async () => {
		await expect(
			buildProject({
				entry: join(root, "missing.ts"),
				outDir: outDir(),
				name: "demo",
				target: "node",
			})
		).rejects.toThrow(/project entry not found/);
	});
});
