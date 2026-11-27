import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BoxAPI } from "@ryuhq/client";
import {
	isRyuError,
	RyuAbortError,
	RyuConfigurationError,
	RyuConflictError,
	RyuConnectionError,
	type RyuError,
	RyuNotFoundError,
	RyuPaymentRequiredError,
	RyuQuotaExceededError,
	RyuTimeoutError,
} from "../errors.ts";
import { Ryu } from "../ryu.ts";
import { BOX_ERROR_CODES, BOX_RUN_CODES } from "./codes.ts";
import {
	collectExec,
	commandParts,
	defaultRunName,
	quoteCommandWord,
} from "./helpers.ts";
import {
	BOX_CANONICAL_METHODS,
	BOX_TOP_LEVEL_METHODS,
	createBoxNamespace,
} from "./namespace.ts";
import { BOX_ROUTES } from "./routes.ts";

interface Recorded {
	body: string | null;
	headers: Headers;
	method: string;
	signal: AbortSignal | null;
	url: string;
}

type Respond = (request: Recorded) => Response | Promise<Response>;

function stubFetch(respond: Respond) {
	const calls: Recorded[] = [];
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const body = init?.body;
		const recorded: Recorded = {
			body: typeof body === "string" ? body : null,
			headers: new Headers(init?.headers),
			method: init?.method ?? "GET",
			signal: init?.signal ?? null,
			url: String(input),
		};
		calls.push(recorded);
		return await respond(recorded);
	};
	return { calls, fetch };
}

const BASE = "http://127.0.0.1:8090";
const ENV = { RYU_BOX_URL: BASE, RYU_BOX_API_KEY: "box-tenant-secret" };
const NOW = "2026-10-21T12:00:00.000Z";

function box(status: string, id = "bx_00000000000000000000000000000001") {
	return {
		allowedHosts: [],
		createdAt: NOW,
		driver: "docker",
		envNames: [],
		id,
		image: "ubuntu:24.04",
		lastError: status === "error" ? "setup failed" : null,
		name: "run-1",
		network: "none",
		repo: null,
		secrets: [],
		size: "small",
		snapshotId: null,
		status,
		stoppedAt: null,
		ttlSeconds: 86_400,
		updatedAt: NOW,
	};
}

const RESULT = { durationMs: 12, exitCode: 0, stderr: "", stdout: "v22.0.0\n" };

/** The SSE frames of a streamed command that prints RESULT.stdout and exits. */
function commandFrames(exitCode: number | null = 0): string[] {
	return [
		'event: stdout\nid: 1\ndata: {"data":"v22"}\n\n',
		'event: stdout\nid: 2\ndata: {"data":".0.0\\n"}\n\n',
		`event: exit\ndata: ${JSON.stringify({ durationMs: 12, exitCode, status: exitCode === null ? "timed_out" : "exited" })}\n\n`,
	];
}

/** A streamed command answer; `delayMs` spaces the frames out after the headers. */
function commandStream(frames = commandFrames(), delayMs = 0): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			for (const frame of frames) {
				if (delayMs > 0) {
					await new Promise((done) => setTimeout(done, delayMs));
				}
				controller.enqueue(encoder.encode(frame));
			}
			controller.close();
		},
	});
	return new Response(body, {
		headers: { "content-type": "text/event-stream" },
	});
}

function boxError(
	status: number,
	code: string,
	message: string,
	headers: Record<string, string> = {}
): Response {
	const requestId = "req_0123456789abcdef0123456789abcdef";
	return Response.json(
		{
			code,
			error: { code, message, requestId, status },
			message,
			ok: false,
			requestId,
			status,
			type: "box.error",
		},
		{ status, headers: { "x-request-id": requestId, ...headers } }
	);
}

function ryu(fetch: ReturnType<typeof stubFetch>["fetch"]) {
	return new Ryu({ env: ENV, fetch });
}

async function rejection(promise: PromiseLike<unknown>): Promise<RyuError> {
	try {
		await promise;
	} catch (error) {
		if (isRyuError(error)) {
			return error;
		}
		throw error;
	}
	throw new Error("expected the call to reject");
}

function path(request: Recorded): string {
	return `${request.method} ${new URL(request.url).pathname}`;
}

describe("Box wire", () => {
	test("sends the tenant key as Bearer to RYU_BOX_URL", async () => {
		const { calls, fetch } = stubFetch(() =>
			Response.json({ boxes: [box("ready")], ok: true, type: "box.list" })
		);
		const boxes = await ryu(fetch).box.list();
		expect(boxes.map((item) => item.id)).toEqual([
			"bx_00000000000000000000000000000001",
		]);
		expect(calls[0]?.url).toBe(`${BASE}/v1/boxes`);
		expect(calls[0]?.headers.get("authorization")).toBe(
			"Bearer box-tenant-secret"
		);
		expect(calls[0]?.headers.get("x-api-key")).toBeNull();
	});

	test("a missing RYU_BOX_API_KEY is a RyuConfigurationError naming the variable, with no request", async () => {
		const { calls, fetch } = stubFetch(() => Response.json({}));
		const client = new Ryu({ env: {}, fetch, result: "object" });
		const { error } = await client.box.list();
		expect(error).toBeInstanceOf(RyuConfigurationError);
		// The URL defaults to hosted Box; only the Ryu-provisioned key is missing.
		expect(error?.details).toEqual({ missing: ["RYU_BOX_API_KEY"] });
		expect(calls).toHaveLength(0);
	});

	test("a 429 quota_exceeded is a RyuQuotaExceededError and is not retried, even with Retry-After", async () => {
		const { calls, fetch } = stubFetch(() =>
			boxError(429, "quota_exceeded", "This tenant has reached its quota.", {
				"retry-after": "0",
			})
		);
		const error = await rejection(ryu(fetch).box.create({ name: "a" }));
		expect(error).toBeInstanceOf(RyuQuotaExceededError);
		expect(error.code).toBe("quota_exceeded");
		expect(error.status).toBe(429);
		expect(error.retryable).toBe(false);
		expect(error.envelope).toBe("ryu-service");
		expect(error.type).toBe("box.error");
		expect(error.requestId).toBe("req_0123456789abcdef0123456789abcdef");
		expect(calls).toHaveLength(1);
	});

	test("a 402 insufficient_credits is a RyuPaymentRequiredError and is not retried", async () => {
		const { calls, fetch } = stubFetch(() =>
			boxError(402, "insufficient_credits", "No credits left.")
		);
		const error = await rejection(ryu(fetch).box.resume("bx_1"));
		expect(error).toBeInstanceOf(RyuPaymentRequiredError);
		expect(calls).toHaveLength(1);
	});

	test("create sends exactly one stable Idempotency-Key across a 503 retry", async () => {
		let attempt = 0;
		const { calls, fetch } = stubFetch(() => {
			attempt += 1;
			return attempt === 1
				? boxError(503, "driver_unavailable", "Docker is restarting.", {
						"retry-after": "0",
					})
				: Response.json(
						{ box: box("ready"), ok: true, type: "box.created" },
						{ status: 201 }
					);
		});
		const created = await ryu(fetch).box.create({ name: "a", size: "small" });
		expect(created.status).toBe("ready");
		expect(calls).toHaveLength(2);
		const keys = calls.map((call) => call.headers.get("idempotency-key"));
		expect(keys[0]).toBeTruthy();
		expect(keys[1]).toBe(keys[0] as string);
	});

	test("the caller's key replaces the client's on create and is reported in meta", async () => {
		const { calls, fetch } = stubFetch(() =>
			Response.json(
				{ box: box("ready"), ok: true, type: "box.existing" },
				{ status: 200 }
			)
		);
		const client = new Ryu({ env: ENV, fetch, result: "object" });
		const { data, meta } = await client.box
			.with({ idempotencyKey: "deploy-box-42" })
			.create({ name: "a" });
		expect(data?.id).toBe("bx_00000000000000000000000000000001");
		expect(calls[0]?.headers.get("idempotency-key")).toBe("deploy-box-42");
		expect(meta?.idempotencyKey).toBe("deploy-box-42");
		expect(meta?.status).toBe(200);
		// Box marks a replay only in the body (`type: "box.existing"`).
		expect(meta?.replayed).toBe(true);
	});

	test("an Idempotent-Replayed: true header marks a replay on its own", async () => {
		// Current Box servers send the header with the body marker; the
		// header alone is enough.
		const { fetch } = stubFetch(() =>
			Response.json(
				{ box: box("ready"), ok: true, type: "box.created" },
				{ status: 200, headers: { "idempotent-replayed": "true" } }
			)
		);
		const client = new Ryu({ env: ENV, fetch, result: "object" });
		const { meta } = await client.box
			.with({ idempotencyKey: "deploy-box-43" })
			.create({ name: "a" });
		expect(meta?.replayed).toBe(true);
		expect(meta?.idempotencyKey).toBe("deploy-box-43");
	});

	test("defaults to the hosted Box origin when RYU_BOX_URL is unset", async () => {
		const { calls, fetch } = stubFetch(() =>
			Response.json({ boxes: [], ok: true, type: "box.list" })
		);
		const client = new Ryu({
			env: { RYU_BOX_API_KEY: "box-tenant-secret" },
			fetch,
		});
		await client.box.list();
		expect(new URL(calls[0]?.url ?? "").origin).toBe("https://box.ryuhq.com");
		expect(calls[0]?.headers.get("authorization")).toBe(
			"Bearer box-tenant-secret"
		);
	});

	test("a fresh create is not reported as a replay", async () => {
		const { fetch } = stubFetch(() =>
			Response.json(
				{ box: box("ready"), ok: true, type: "box.created" },
				{ status: 201 }
			)
		);
		const client = new Ryu({ env: ENV, fetch, result: "object" });
		const { meta } = await client.box.create({ name: "a" });
		expect(meta?.replayed).toBe(false);
		expect(meta?.status).toBe(201);
	});

	test("fork keeps one key, and routes outside the table get none", async () => {
		const { calls, fetch } = stubFetch((request) =>
			request.url.endsWith("/fork")
				? Response.json(
						{ box: box("ready", "bx_2"), ok: true },
						{ status: 201 }
					)
				: Response.json({ ok: true, type: "box.stopped" })
		);
		const client = ryu(fetch);
		await client.box.fork("bx_1", { name: "copy" });
		await client.box.stop("bx_1");
		expect(calls[0]?.headers.get("idempotency-key")).toBeTruthy();
		expect(calls[1]?.headers.get("idempotency-key")).toBeNull();
	});

	test("a command (not an idempotent route) is not replayed on a 503", async () => {
		const { calls, fetch } = stubFetch(() =>
			boxError(503, "driver_unavailable", "Docker is restarting.", {
				"retry-after": "0",
			})
		);
		const error = await rejection(
			ryu(fetch).box.exec("bx_1", { command: "ls" })
		);
		expect(error.status).toBe(503);
		expect(calls).toHaveLength(1);
	});

	test("a 404 keeps the Box error code and message", async () => {
		const { fetch } = stubFetch(() =>
			boxError(404, "not_found", "Box not found.")
		);
		const error = await rejection(ryu(fetch).box.get("bx_missing"));
		expect(error).toBeInstanceOf(RyuNotFoundError);
		expect(error.code).toBe("not_found");
		expect(error.message).toBe("Box not found.");
	});
});

describe("box.run", () => {
	test("creates, waits until ready, then execs the command", async () => {
		let polls = 0;
		const { calls, fetch } = stubFetch((request) => {
			switch (path(request)) {
				case "POST /v1/boxes":
					return Response.json(
						{ box: box("provisioning"), ok: true, type: "box.provisioning" },
						{ status: 202 }
					);
				case "GET /v1/boxes/bx_00000000000000000000000000000001":
					polls += 1;
					return Response.json({
						box: box(polls < 2 ? "provisioning" : "ready"),
						ok: true,
						type: "box.get",
					});
				case "POST /v1/boxes/bx_00000000000000000000000000000001/commands":
					return commandStream();
				default:
					return new Response("unexpected", { status: 599 });
			}
		});
		const run = await ryu(fetch).box.run(
			{
				size: "small",
				image: "node:22",
				setup: ["apt-get install -y git"],
				command: ["node", "-v"],
				cwd: "/workspace",
			},
			{ pollIntervalMs: 1 }
		);
		expect(run.box.status).toBe("ready");
		expect(run.result).toEqual(RESULT);
		expect(calls.map(path)).toEqual([
			"POST /v1/boxes",
			"GET /v1/boxes/bx_00000000000000000000000000000001",
			"GET /v1/boxes/bx_00000000000000000000000000000001",
			"POST /v1/boxes/bx_00000000000000000000000000000001/commands",
		]);
		const createBody = JSON.parse(calls[0]?.body ?? "{}") as Record<
			string,
			unknown
		>;
		expect(createBody).toMatchObject({
			image: "node:22",
			setup: ["apt-get install -y git"],
			size: "small",
		});
		expect(String(createBody.name)).toMatch(/^run-[0-9a-f-]{8}$/);
		expect(calls[0]?.headers.get("idempotency-key")).toBeTruthy();
		expect(JSON.parse(calls[3]?.body ?? "{}")).toEqual({
			args: ["-v"],
			command: "node",
			cwd: "/workspace",
			stream: true,
		});
		expect(calls[3]?.headers.get("accept")).toBe("text/event-stream");
		expect(calls[3]?.headers.get("idempotency-key")).toBeNull();
	});

	test("skips the wait when the Box is ready at once, and resolves to { data, meta } in object mode", async () => {
		const { calls, fetch } = stubFetch((request) =>
			request.url.endsWith("/commands")
				? commandStream()
				: Response.json({ box: box("ready"), ok: true }, { status: 201 })
		);
		const client = new Ryu({ env: ENV, fetch, result: "object" });
		const { data, error, meta } = await client.box.run(
			{ name: "named", command: "node", args: ["-v"] },
			{ idempotencyKey: "run-key-1" }
		);
		expect(error).toBeNull();
		expect(data?.result).toEqual(RESULT);
		expect(calls).toHaveLength(2);
		expect(calls[0]?.headers.get("idempotency-key")).toBe("run-key-1");
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ name: "named" });
		expect(meta?.status).toBe(200);
		// The create's key survives the command request that ended the call.
		expect(meta?.idempotencyKey).toBe("run-key-1");
		expect(meta?.replayed).toBe(false);
	});

	test("box.run() meta reports a generated create key and a replayed create", async () => {
		const { calls, fetch } = stubFetch((request) =>
			request.url.endsWith("/commands")
				? commandStream()
				: Response.json(
						{ box: box("ready"), ok: true, type: "box.existing" },
						{ status: 200 }
					)
		);
		const client = new Ryu({ env: ENV, fetch, result: "object" });
		const { meta } = await client.box.run({ command: "ls" });
		const sent = calls[0]?.headers.get("idempotency-key");
		expect(sent).toBeTruthy();
		expect(meta?.idempotencyKey).toBe(sent as string);
		expect(meta?.replayed).toBe(true);
	});

	test("a Box that ends in error raises box_failed with its id and does not exec", async () => {
		const { calls, fetch } = stubFetch(() =>
			Response.json({ box: box("error"), ok: true }, { status: 202 })
		);
		const error = await rejection(
			ryu(fetch).box.run({ command: "ls" }, { pollIntervalMs: 1 })
		);
		expect(error.code).toBe(BOX_RUN_CODES.failed);
		expect(error.details).toEqual({
			boxId: "bx_00000000000000000000000000000001",
			lastError: "setup failed",
			status: "error",
		});
		expect(error.retryable).toBe(false);
		expect(calls).toHaveLength(1);
	});

	test("a Box still provisioning after readyTimeoutMs raises box_ready_timeout", async () => {
		const { fetch } = stubFetch(() =>
			Response.json({ box: box("provisioning"), ok: true }, { status: 202 })
		);
		const error = await rejection(
			ryu(fetch).box.run(
				{ command: "ls" },
				{ pollIntervalMs: 1, readyTimeoutMs: 5 }
			)
		);
		expect(error).toBeInstanceOf(RyuTimeoutError);
		expect(error.code).toBe(BOX_RUN_CODES.readyTimeout);
		expect(error.code).not.toBe("box_not_ready");
		expect(error.details).toEqual({
			boxId: "bx_00000000000000000000000000000001",
		});
	});

	test("aborting the run's signal while it waits raises RyuAbortError", async () => {
		const controller = new AbortController();
		const { fetch } = stubFetch(() => {
			setTimeout(() => controller.abort(), 5);
			return Response.json(
				{ box: box("provisioning"), ok: true },
				{ status: 202 }
			);
		});
		const error = await rejection(
			ryu(fetch).box.run(
				{ command: "ls" },
				{ pollIntervalMs: 60_000, signal: controller.signal }
			)
		);
		expect(error).toBeInstanceOf(RyuAbortError);
		expect(error.details).toEqual({
			boxId: "bx_00000000000000000000000000000001",
		});
	});

	test("a signal bound with .with() reaches every request of the run", async () => {
		const controller = new AbortController();
		const { calls, fetch } = stubFetch((request) =>
			request.url.endsWith("/commands")
				? commandStream()
				: Response.json({ box: box("ready"), ok: true }, { status: 201 })
		);
		await ryu(fetch)
			.box.with({ signal: controller.signal })
			.run({ command: "ls" });
		expect(calls).toHaveLength(2);
		for (const call of calls) {
			expect(call.signal).not.toBeNull();
		}
	});

	test("a command that outlasts timeoutMs still completes, because its output streams", async () => {
		const { calls, fetch } = stubFetch((request) =>
			request.url.endsWith("/commands")
				? commandStream(commandFrames(), 100)
				: Response.json({ box: box("ready"), ok: true }, { status: 201 })
		);
		const client = new Ryu({ env: ENV, fetch, timeoutMs: 50, maxRetries: 0 });
		const run = await client.box.run({ name: "slow", command: "sleep 1" });
		expect(run.result).toEqual(RESULT);
		expect(calls).toHaveLength(2);
	});

	test("a killed or timed-out command reports exit code -1", async () => {
		const { fetch } = stubFetch((request) =>
			request.url.endsWith("/commands")
				? commandStream(commandFrames(null))
				: Response.json({ box: box("ready"), ok: true }, { status: 201 })
		);
		const run = await ryu(fetch).box.run({ name: "t", command: "sleep 9" });
		expect(run.result.exitCode).toBe(-1);
	});

	test("a command stream that ends before exit is a RyuConnectionError with the Box id", async () => {
		const { fetch } = stubFetch((request) =>
			request.url.endsWith("/commands")
				? commandStream(commandFrames().slice(0, 1))
				: Response.json({ box: box("ready"), ok: true }, { status: 201 })
		);
		const error = await rejection(
			ryu(fetch).box.run({ name: "cut", command: "ls" })
		);
		expect(error).toBeInstanceOf(RyuConnectionError);
		expect(error.details).toEqual({
			boxId: "bx_00000000000000000000000000000001",
		});
	});

	test("collectExec keeps stdout and stderr apart and in order", async () => {
		async function* events() {
			yield { data: "a", seq: 1, type: "stdout" as const };
			yield { data: "x", seq: 2, type: "stderr" as const };
			yield { data: "b", seq: 3, type: "stdout" as const };
			yield {
				durationMs: 4,
				exitCode: 2,
				status: "exited" as const,
				type: "exit" as const,
			};
		}
		expect(await collectExec(events(), "bx_1")).toEqual({
			durationMs: 4,
			exitCode: 2,
			stderr: "x",
			stdout: "ab",
		});
	});

	test("rerunning with the same key and no name replays the first Box", async () => {
		const created = new Map<string, string>();
		const { calls, fetch } = stubFetch(async (request) => {
			if (request.url.endsWith("/commands")) {
				return commandStream();
			}
			const key = request.headers.get("idempotency-key") ?? "";
			const body = request.body ?? "";
			const previous = created.get(key);
			if (previous === undefined) {
				created.set(key, body);
				return Response.json(
					{ box: box("ready"), ok: true, type: "box.created" },
					{ status: 201 }
				);
			}
			return previous === body
				? Response.json({ box: box("ready"), ok: true, type: "box.existing" })
				: boxError(
						409,
						"idempotency_conflict",
						"Idempotency-Key was reused with a different request."
					);
		});
		const client = new Ryu({ env: ENV, fetch, result: "object" });
		const input = { size: "small" as const, command: "ls" };
		const first = await client.box.run(input, { idempotencyKey: "resume-1" });
		const second = await client.box
			.with({ idempotencyKey: "resume-1" })
			.run(input);
		expect(first.error).toBeNull();
		expect(second.error).toBeNull();
		const creates = calls.filter((call) => path(call) === "POST /v1/boxes");
		expect(creates).toHaveLength(2);
		expect(creates[1]?.body).toBe(creates[0]?.body ?? "");
		expect(
			(JSON.parse(creates[0]?.body ?? "{}") as { name: string }).name
		).toBe(await defaultRunName("resume-1"));
		expect(await defaultRunName("resume-1")).toMatch(/^run-[0-9a-f]{12}$/u);
		expect(await defaultRunName("resume-2")).not.toBe(
			await defaultRunName("resume-1")
		);
	});

	test("a replay whose Box was deleted is a RyuConflictError and not retried", async () => {
		const { calls, fetch } = stubFetch(() =>
			boxError(
				409,
				"idempotency_key_resource_deleted",
				"The Box this Idempotency-Key created has been deleted."
			)
		);
		const error = await rejection(
			ryu(fetch).box.with({ idempotencyKey: "gone-1" }).create({ name: "a" })
		);
		expect(error).toBeInstanceOf(RyuConflictError);
		expect(error.code).toBe("idempotency_key_resource_deleted");
		expect(error.status).toBe(409);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.headers.get("idempotency-key")).toBe("gone-1");
	});

	test("an invalid command is refused before any request", async () => {
		const { calls, fetch } = stubFetch(() => new Response("{}"));
		const error = await rejection(
			ryu(fetch).box.run({ command: ["node", "-v"], args: ["x"] })
		);
		expect(error).toBeInstanceOf(RyuConfigurationError);
		expect(error.code).toBe("invalid_input");
		expect(calls).toHaveLength(0);
	});

	test("commandParts splits arrays and keeps strings", () => {
		expect(commandParts(["sh", "-c", "echo hi"], undefined)).toEqual({
			command: "sh",
			args: ["-c", "echo hi"],
		});
		expect(commandParts("ls", ["-la"])).toEqual({
			command: "ls",
			args: ["-la"],
		});
		expect(commandParts(["/opt/my app/run", "a b"], undefined)).toEqual({
			command: "'/opt/my app/run'",
			args: ["a b"],
		});
		expect(commandParts("'/opt/my app/run' -v", undefined)).toEqual({
			command: "'/opt/my app/run' -v",
			args: [],
		});
		expect(quoteCommandWord("node")).toBe("node");
		expect(quoteCommandWord("it's")).toBe("'it'\\''s'");
		expect(quoteCommandWord('a"b\\c')).toBe("'a\"b\\c'");
		expect(() => commandParts([], undefined)).toThrow(RyuConfigurationError);
		expect(() => commandParts("  ", undefined)).toThrow(RyuConfigurationError);
	});
});

describe("Box codes and routes", () => {
	test("codes.ts equals the BoxErrorCode union in apps/box/src/errors.ts", () => {
		const source = readFileSync(
			resolve(import.meta.dir, "../../../../apps/box/src/errors.ts"),
			"utf8"
		);
		const union = /export type BoxErrorCode =([^;]+);/u.exec(source)?.[1];
		expect(union).toBeDefined();
		const codes = [...(union ?? "").matchAll(/"([a-z_]+)"/gu)].map(
			(match) => match[1]
		);
		expect(codes).toEqual([...BOX_ERROR_CODES]);
	});

	test("the route table marks create and fork as required-key routes", () => {
		expect(BOX_ROUTES.mount).toBe("");
		expect(BOX_ROUTES.idempotent).toEqual([
			{ method: "POST", path: "/v1/boxes", required: true },
			{ method: "POST", path: "/v1/boxes/{id}/fork", required: true },
		]);
	});
});

const BOX_ID = "bx_00000000000000000000000000000001";

/** Arguments for each BoxAPI method that has a canonical resource path. */
const ALIAS_ARGS: Record<
	(typeof BOX_CANONICAL_METHODS)[keyof typeof BOX_CANONICAL_METHODS],
	unknown[]
> = {
	cancelPrompt: [BOX_ID, "run_1"],
	createPreview: [BOX_ID, 3000, "public"],
	deletePreview: [BOX_ID, "tok_1"],
	deleteSecret: ["NPM_TOKEN"],
	deleteSnapshot: ["snap_1"],
	downloadArchive: [BOX_ID, "src"],
	events: [BOX_ID, 5],
	followEvents: [BOX_ID, { after: 2 }],
	followLogs: [BOX_ID, "proc_1", { after: 3 }],
	getSnapshot: ["snap_1"],
	interrupt: [BOX_ID],
	kill: [BOX_ID, "proc_1"],
	listFiles: [BOX_ID, "src"],
	listPreviews: [BOX_ID],
	listSecrets: [],
	listSnapshots: [],
	logs: [BOX_ID, "proc_1", 4],
	makeDirectory: [BOX_ID, "out"],
	process: [BOX_ID, "proc_1"],
	processes: [BOX_ID],
	prompt: [BOX_ID, { mode: "worker", prompt: "fix the build" }],
	promptRun: [BOX_ID, "run_1"],
	prompts: [BOX_ID, 7],
	putSecret: ["NPM_TOKEN", "secret-value"],
	readFile: [BOX_ID, "a.txt"],
	readTextFile: [BOX_ID, "a.txt"],
	removePath: [BOX_ID, "out"],
	snapshot: [BOX_ID, "after-setup"],
	spawn: [BOX_ID, { command: "sleep", args: ["5"] }],
	uploadArchive: [BOX_ID, "src", new Uint8Array([1, 2, 3])],
	writeFile: [BOX_ID, "a.txt", "hello"],
	writeStdin: [BOX_ID, "proc_1", "y\n", { close: true }],
};

/**
 * The request each canonical path must send with its {@link ALIAS_ARGS},
 * written out by hand from the Box API routes (`{box}` is
 * `/v1/boxes/${BOX_ID}`). It pins each path to the right client method
 * independently of {@link BOX_CANONICAL_METHODS}. (`files.read` and
 * `files.readText` share a route; their return types are pinned in
 * box-types.test.ts.)
 */
const CANONICAL_WIRE: Record<keyof typeof BOX_CANONICAL_METHODS, string> = {
	"events.follow": "GET {box}/events?after=2&follow=true",
	"events.list": "GET {box}/events?limit=5",
	"files.delete": "DELETE {box}/files?path=out",
	"files.downloadArchive": "GET {box}/files/archive?path=src",
	"files.list": "GET {box}/files?path=src",
	"files.mkdir": "POST {box}/files/directories",
	"files.read": "GET {box}/files/content?path=a.txt",
	"files.readText": "GET {box}/files/content?path=a.txt",
	"files.uploadArchive": "PUT {box}/files/archive?path=src",
	"files.write": "PUT {box}/files/content?path=a.txt",
	"previews.create": "POST {box}/previews",
	"previews.delete": "DELETE {box}/previews/tok_1",
	"previews.list": "GET {box}/previews",
	"processes.followLogs": "GET {box}/processes/proc_1/logs?after=3&follow=true",
	"processes.get": "GET {box}/processes/proc_1",
	"processes.interrupt": "POST {box}/interrupt",
	"processes.kill": "POST {box}/processes/proc_1/kill",
	"processes.list": "GET {box}/processes",
	"processes.logs": "GET {box}/processes/proc_1/logs?after=4",
	"processes.spawn": "POST {box}/commands",
	"processes.writeStdin": "POST {box}/processes/proc_1/stdin",
	"prompts.cancel": "POST {box}/prompts/run_1/cancel",
	"prompts.create": "POST {box}/prompt",
	"prompts.get": "GET {box}/prompts/run_1",
	"prompts.list": "GET {box}/prompts?limit=7",
	"secrets.delete": "DELETE /v1/secrets/NPM_TOKEN",
	"secrets.list": "GET /v1/secrets",
	"secrets.set": "PUT /v1/secrets/NPM_TOKEN",
	"snapshots.create": "POST {box}/snapshots",
	"snapshots.delete": "DELETE /v1/snapshots/snap_1",
	"snapshots.get": "GET /v1/snapshots/snap_1",
	"snapshots.list": "GET /v1/snapshots",
};

interface WireRequest {
	accept: string | null;
	body: string | null;
	contentType: string | null;
	method: string;
	url: string;
}

/** Records every request in a comparable form; answers `{}` (most parses then fail, after the request). */
function wireRecorder() {
	const requests: WireRequest[] = [];
	const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		const body = init?.body;
		requests.push({
			accept: headers.get("accept"),
			body:
				typeof body === "string"
					? body
					: body instanceof Uint8Array
						? `bytes:${Array.from(body as Uint8Array).join(",")}`
						: null,
			contentType: headers.get("content-type"),
			method: init?.method ?? "GET",
			url: String(input),
		});
		return Promise.resolve(Response.json({}));
	};
	return { fetch, requests };
}

/** Calls `ryu.box.<path>` through the facade and settles it, whatever it returns. */
async function callPath(
	namespace: unknown,
	path: string,
	args: readonly unknown[]
): Promise<void> {
	let target: unknown = namespace;
	for (const key of path.split(".")) {
		target = (target as Record<string, unknown>)[key];
	}
	const value = (target as (...rest: unknown[]) => unknown)(...args);
	try {
		if (
			typeof value === "object" &&
			value !== null &&
			Symbol.asyncIterator in value
		) {
			for await (const _ of value as AsyncIterable<unknown>) {
				break;
			}
		} else {
			await value;
		}
	} catch {
		// The stub answers `{}`, which most methods cannot parse; only the request matters here.
	}
}

describe("Box resource namespaces", () => {
	test("every BoxAPI method is a top-level method or has a canonical resource path", () => {
		const methods = Object.getOwnPropertyNames(BoxAPI.prototype).filter(
			(name) =>
				name !== "constructor" &&
				typeof Reflect.get(BoxAPI.prototype, name) === "function"
		);
		const homed = new Set<string>([
			...BOX_TOP_LEVEL_METHODS,
			...Object.values(BOX_CANONICAL_METHODS),
		]);
		// Private transport helpers are not part of the public surface.
		const clientSource = readFileSync(
			resolve(import.meta.dir, "../../../client/src/box.ts"),
			"utf8"
		);
		const privateMethods = new Set(
			[...clientSource.matchAll(/^\tprivate (?:async )?\*?(\w+)\(/gmu)].map(
				(match) => match[1]
			)
		);
		const unhomed = methods.filter(
			(name) => !(homed.has(name) || privateMethods.has(name))
		);
		expect(unhomed).toEqual([]);
		for (const name of BOX_TOP_LEVEL_METHODS) {
			expect(Object.values(BOX_CANONICAL_METHODS)).not.toContain(name);
		}
	});

	test("the canonical path and its deprecated flat alias send the same request", async () => {
		for (const [path, method] of Object.entries(BOX_CANONICAL_METHODS)) {
			const canonical = wireRecorder();
			const flat = wireRecorder();
			const args = ALIAS_ARGS[method];
			await callPath(ryu(canonical.fetch).box, path, args);
			await callPath(ryu(flat.fetch).box, method, args);
			expect({ path, requests: canonical.requests }).toEqual({
				path,
				requests: flat.requests,
			});
			expect(canonical.requests.length).toBeGreaterThan(0);
		}
	});

	test("each canonical path sends the request written out for it", async () => {
		for (const [canonicalPath, expected] of Object.entries(CANONICAL_WIRE)) {
			const { fetch, requests } = wireRecorder();
			const method =
				BOX_CANONICAL_METHODS[
					canonicalPath as keyof typeof BOX_CANONICAL_METHODS
				];
			await callPath(ryu(fetch).box, canonicalPath, ALIAS_ARGS[method]);
			expect({
				canonicalPath,
				requests: requests.map(
					(request) =>
						`${request.method} ${request.url.replace(`${BASE}/v1/boxes/${BOX_ID}`, "{box}").replace(BASE, "")}`
				),
			}).toEqual({ canonicalPath, requests: [expected] });
		}
	});

	test("the callable namespaces keep the flat processes, prompts and events calls", async () => {
		const { fetch, requests } = wireRecorder();
		const client = ryu(fetch);
		await callPath(client.box, "processes", [BOX_ID]);
		await callPath(client.box, "prompts", [BOX_ID, 3]);
		await callPath(client.box, "events", [BOX_ID, 2]);
		expect(requests.map((request) => request.url)).toEqual([
			`${BASE}/v1/boxes/${BOX_ID}/processes`,
			`${BASE}/v1/boxes/${BOX_ID}/prompts?limit=3`,
			`${BASE}/v1/boxes/${BOX_ID}/events?limit=2`,
		]);
	});

	test("the namespace built directly has the same shape, with no I/O", () => {
		const { fetch, requests } = wireRecorder();
		const namespace = createBoxNamespace(
			{ apiKey: "k", baseUrl: BASE } as Parameters<
				typeof createBoxNamespace
			>[0],
			fetch
		);
		expect(typeof namespace.files.readText).toBe("function");
		expect(typeof namespace.processes).toBe("function");
		expect(typeof namespace.processes.spawn).toBe("function");
		expect(typeof namespace.readTextFile).toBe("function");
		expect(requests).toHaveLength(0);
	});

	test("object mode resolves a canonical call to { data, error, meta }", async () => {
		const requestId = "req_00000000000000000000000000000abc";
		const { calls, fetch } = stubFetch(
			() =>
				new Response("hello\n", {
					headers: { "x-request-id": requestId },
				})
		);
		const client = new Ryu({ env: ENV, fetch, result: "object" });
		const { data, error, meta } = await client.box.files.readText(
			BOX_ID,
			"a.txt"
		);
		expect(error).toBeNull();
		expect(data).toBe("hello\n");
		expect(meta?.status).toBe(200);
		expect(meta?.requestId).toBe(requestId);
		expect(meta?.attempts).toBe(1);
		expect(path(calls[0] as Recorded)).toBe(
			`GET /v1/boxes/${BOX_ID}/files/content`
		);
	});

	test("object-mode errors, ryu.safe and .with() work on canonical and callable paths", async () => {
		const { calls, fetch } = stubFetch((request) =>
			request.url.includes("/snapshots/")
				? boxError(404, "not_found", "snapshot not found")
				: Response.json({ ok: true, processes: [] })
		);
		const client = new Ryu({ env: ENV, fetch });
		const missing = await client.safe.box.snapshots.get("snap_x");
		expect(missing.error).toBeInstanceOf(RyuNotFoundError);
		expect(missing.meta?.status).toBe(404);
		const viaCall = await client.safe.box.processes(BOX_ID);
		expect(viaCall.data).toEqual([]);
		const viaList = await client.box
			.with({ headers: { "x-trace": "t1" } })
			.processes.list(BOX_ID);
		expect(viaList).toEqual([]);
		expect(calls.at(-1)?.headers.get("x-trace")).toBe("t1");
	});
});
