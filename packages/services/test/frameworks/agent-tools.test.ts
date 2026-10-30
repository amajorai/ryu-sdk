// Executable snippets for apps/fumadocs/content/docs/standalone/sdk/agent-tools.mdx.
//
// Each `// docs:start <id>` … `// docs:end <id>` region is one of the page's
// code blocks, in order; apps/fumadocs/src/lib/standalone-sdk-docs.test.ts
// compares them. `// docs:show <text>` lines render as `<text>` (the
// published import specifiers do not resolve inside this package, so the real
// imports load the same modules by relative path), and leading tabs render as
// two spaces. Lines that are only `docs:show` are not executed: the AI SDK
// call (this package does not depend on `ai`) and the MCP host entry.
//
// The @ryuhq/sdk Agent runs for real: its native model client is replaced
// with a stub module (the Agent loop talks to the Gateway over `fetch`), and
// `globalThis.fetch` answers the Gateway's chat completions and Notify.

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Ryu } from "../../src/index.ts";
import { toAiSdkTools, toRyuAgentTools } from "../../src/tools/index.ts";

const GATEWAY = "http://127.0.0.1:7981";
const ENV = {
	RYU_NOTIFY_URL: "https://notify.example.com",
	RYU_NOTIFY_API_KEY: "test-notify-tenant-key",
	RYU_MAIL_URL: "https://mail.example.com",
	RYU_MAIL_API_KEY: "test-mail-key",
};
const EVENTS = JSON.parse(
	readFileSync(
		resolve(import.meta.dir, "../fixtures/notify/events-page-1.json"),
		"utf8"
	)
) as { body: unknown; headers: Record<string, string>; status: number };

// The Agent's native addon is not needed for a fetch-backed run.
mock.module("@ryuhq/sdk-native", () => ({
	assertAllowedEgress: () => undefined,
	resolveGatewayToken: () => null,
	resolveGatewayUrl: () => GATEWAY,
	ModelClient: class {},
}));

interface ChatBody {
	messages: { content?: string | null; role: string }[];
	tools?: { function: { name: string } }[];
}

const notifyRequests: Request[] = [];
const modelBodies: ChatBody[] = [];
let modelReplies: unknown[] = [];
const realFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};

function modelReply(message: Record<string, unknown>, finish: string) {
	return { choices: [{ finish_reason: finish, message }] };
}

beforeAll(() => {
	for (const [name, value] of Object.entries(ENV)) {
		savedEnv[name] = process.env[name];
		process.env[name] = value;
	}
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			if (request.url.startsWith(`${GATEWAY}/v1/chat/completions`)) {
				modelBodies.push((await request.json()) as ChatBody);
				const next = modelReplies.shift();
				return new Response(JSON.stringify(next), { status: 200 });
			}
			if (request.url.startsWith(ENV.RYU_NOTIFY_URL)) {
				notifyRequests.push(request);
				return new Response(JSON.stringify(EVENTS.body), {
					status: EVENTS.status,
					headers: EVENTS.headers,
				});
			}
			return new Response("not found", { status: 404 });
		},
		{ preconnect: realFetch.preconnect }
	);
});

afterAll(() => {
	globalThis.fetch = realFetch;
	for (const [name, value] of Object.entries(savedEnv)) {
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	}
});

beforeEach(() => {
	notifyRequests.length = 0;
	modelBodies.length = 0;
	modelReplies = [];
});

/** The page's first block: an @ryuhq/sdk Agent with the services' read-only tools. */
async function askAgent(): Promise<string> {
	const { Agent } = await import("../../../sdk/src/agent/agent.ts");
	// docs:start ryu-agent
	// docs:show import { Agent } from "@ryuhq/sdk/agent";
	// docs:show import { Ryu } from "@ryuhq/services";
	// docs:show import { toRyuAgentTools } from "@ryuhq/services/tools";
	// docs:show
	// Reads each service's variables, such as RYU_NOTIFY_API_KEY, from the environment.
	const ryu = new Ryu();

	const agent = new Agent({
		name: "ops",
		model: "openai/gpt-4o-mini",
		instructions: "Answer questions about recent Notify events.",
		// The read-only tools of every service `ryu` is configured for.
		tools: toRyuAgentTools(ryu),
	});

	const { text } = await agent.generate("What was the last event about?");
	// docs:end ryu-agent
	return text;
}

function chooseTools() {
	const ryu = new Ryu();
	// docs:start options
	const tools = toRyuAgentTools(ryu, {
		services: ["mail", "notify"],
		readOnly: false, // also expose tools that send, charge, run or delete
		exclude: ["mail_send"],
		// Ask the Agent's approvalHandler before anything that leaves Ryu.
		needsApproval: (tool) => tool.annotations.openWorldHint,
	});
	// docs:end options
	return tools;
}

function aiSdkTools() {
	// docs:start ai-sdk
	// docs:show import { openai } from "@ai-sdk/openai";
	// docs:show import { generateText, stepCountIs } from "ai";
	// docs:show import { Ryu } from "@ryuhq/services";
	// docs:show import { toAiSdkTools } from "@ryuhq/services/tools";
	// docs:show
	const ryu = new Ryu();
	const tools = toAiSdkTools(ryu, { services: ["notify"] });
	// docs:show
	// docs:show const { text } = await generateText({
	// docs:show   model: openai("gpt-4o-mini"),
	// docs:show   tools,
	// docs:show   stopWhen: stepCountIs(5),
	// docs:show   prompt: "Summarize the unacknowledged Notify events.",
	// docs:show });
	// docs:end ai-sdk
	return tools;
}

// docs:start mcp-config
// docs:show {
// docs:show   "mcpServers": {
// docs:show     "ryu-services": {
// docs:show       "command": "ryu-cli",
// docs:show       "args": ["services", "mcp", "--services", "notify"],
// docs:show       "env": { "RYU_NOTIFY_API_KEY": "<your tenant key>" }
// docs:show     }
// docs:show   }
// docs:show }
// docs:end mcp-config

const PAGE = resolve(
	import.meta.dir,
	"../../../../apps/fumadocs/content/docs/standalone/sdk/agent-tools.mdx"
);

/**
 * Every region of this file rendered as the docs guard renders it:
 * `docs:show` lines unwrapped, common indent removed, tabs as two spaces.
 */
function renderedRegions(): string[] {
	const blocks: string[] = [];
	let open: string[] | null = null;
	for (const line of readFileSync(import.meta.path, "utf8").split("\n")) {
		if (/^\s*\/\/ docs:start \S+\s*$/u.test(line)) {
			open = [];
		} else if (/^\s*\/\/ docs:end \S+\s*$/u.test(line) && open !== null) {
			const shown = open.map((entry) => {
				const show = /^(\s*)\/\/ docs:show(?: (.*))?$/u.exec(entry);
				return show ? `${show[1] ?? ""}${show[2] ?? ""}` : entry;
			});
			const indents = shown
				.filter((entry) => entry.trim() !== "")
				.map((entry) => /^\s*/u.exec(entry)?.[0].length ?? 0);
			const common = Math.min(...indents);
			blocks.push(
				shown
					.map((entry) => {
						const dedented = entry.slice(common);
						const tabs = /^\t*/u.exec(dedented)?.[0].length ?? 0;
						return `${"  ".repeat(tabs)}${dedented.slice(tabs)}`.trimEnd();
					})
					.join("\n")
			);
			open = null;
		} else if (open !== null) {
			open.push(line);
		}
	}
	return blocks;
}

/**
 * The page's fenced code blocks, in order, without the Python ones: those are
 * pinned by bindings/python/tests/test_services_tools_docs.py.
 */
function pageFences(): string[] {
	const blocks: string[] = [];
	let open: string[] | null = null;
	let skip = false;
	for (const line of readFileSync(PAGE, "utf8").split("\n")) {
		if (open === null && /^\s*```\S*/u.test(line)) {
			open = [];
			skip = /^\s*```python\b/u.test(line);
		} else if (open !== null && /^\s*```\s*$/u.test(line)) {
			if (!skip) {
				blocks.push(open.join("\n"));
			}
			open = null;
		} else if (open !== null) {
			open.push(line);
		}
	}
	return blocks;
}

/** The `docs:show` text of one region of this file. */
function shownRegion(id: string): string {
	const source = readFileSync(import.meta.path, "utf8");
	const start = source.indexOf(`// docs:start ${id}\n`);
	const end = source.indexOf(`// docs:end ${id}\n`);
	return source
		.slice(start, end)
		.split("\n")
		.slice(1)
		.map((line) => /^\s*\/\/ docs:show ?(.*)$/u.exec(line)?.[1] ?? "")
		.join("\n");
}

describe("agent-tools.mdx", () => {
	test("an @ryuhq/sdk Agent calls a service tool and answers from its result", async () => {
		modelReplies = [
			modelReply(
				{
					content: null,
					tool_calls: [
						{
							id: "call_1",
							type: "function",
							function: {
								name: "notify_list_events",
								arguments: JSON.stringify({ limit: 1 }),
							},
						},
					],
				},
				"tool_calls"
			),
			modelReply({ content: "The last event was titled Fourth." }, "stop"),
		];
		const text = await askAgent();
		expect(text).toBe("The last event was titled Fourth.");

		const offered = modelBodies[0]?.tools?.map((tool) => tool.function.name);
		// Read-only by default: Mail and Notify reads, no sends.
		expect(offered).toEqual([
			"mail_status",
			"mail_list_inboxes",
			"mail_list_messages",
			"mail_get_message",
			"notify_list_events",
			"notify_get_event",
			"notify_usage",
		]);
		expect(notifyRequests).toHaveLength(1);
		expect(
			new URL(notifyRequests[0]?.url ?? "").searchParams.get("limit")
		).toBe("1");
		const toolMessage = modelBodies[1]?.messages.find(
			(message) => message.role === "tool"
		);
		const result = JSON.parse(toolMessage?.content ?? "null") as {
			data: { events: { title: string }[] };
			error: null;
			meta: { requestId: string };
		};
		expect(result.error).toBeNull();
		expect(result.data.events[0]?.title).toBe("Fourth");
		expect(result.meta.requestId).toBe("req_4cbae62e029546ccb69dea25d83c62ba");
		expect(toolMessage?.content).not.toContain(ENV.RYU_NOTIFY_API_KEY);
	});

	test("arguments the schema rejects reach the model as a tool error", async () => {
		modelReplies = [
			modelReply(
				{
					content: null,
					tool_calls: [
						{
							id: "call_bad",
							type: "function",
							function: {
								name: "notify_list_events",
								arguments: JSON.stringify({ limit: 5000 }),
							},
						},
					],
				},
				"tool_calls"
			),
			modelReply({ content: "I asked for too many." }, "stop"),
		];
		expect(await askAgent()).toBe("I asked for too many.");
		expect(notifyRequests).toHaveLength(0);
		const toolMessage = modelBodies[1]?.messages.find(
			(message) => message.role === "tool"
		);
		const result = JSON.parse(toolMessage?.content ?? "null") as {
			error: { code: string; details: { issues: { path: string }[] } };
		};
		expect(result.error.code).toBe("invalid_arguments");
		expect(result.error.details.issues[0]?.path).toBe("limit");
	});

	test("an Agent without an approval handler stops before a write it must ask about", async () => {
		const { Agent } = await import("../../../sdk/src/agent/agent.ts");
		modelReplies = [
			modelReply(
				{
					content: null,
					tool_calls: [
						{
							id: "call_publish",
							type: "function",
							function: {
								name: "notify_publish",
								arguments: JSON.stringify({ title: "Deploy finished" }),
							},
						},
					],
				},
				"tool_calls"
			),
		];
		const agent = new Agent({
			name: "ops",
			model: "openai/gpt-4o-mini",
			tools: toRyuAgentTools(new Ryu(), {
				services: ["notify"],
				readOnly: false,
			}),
		});
		const result = await agent.generate("Tell the team the deploy finished.");
		expect(result.approvalRequired).toMatchObject({ name: "notify_publish" });
		expect(notifyRequests).toHaveLength(0);
	});

	test("aborting the Agent run aborts the tool's request", async () => {
		const { Agent } = await import("../../../sdk/src/agent/agent.ts");
		modelReplies = [
			modelReply(
				{
					content: null,
					tool_calls: [
						{
							id: "call_exec",
							type: "function",
							function: {
								name: "box_exec",
								arguments: JSON.stringify({
									boxId: "bx_1",
									command: "sleep 600",
								}),
							},
						},
					],
				},
				"tool_calls"
			),
			modelReply({ content: "Stopped." }, "stop"),
		];
		const boxSignals: AbortSignal[] = [];
		const ryu = new Ryu({
			env: { RYU_BOX_URL: "http://127.0.0.1:8090", RYU_BOX_API_KEY: "k" },
			maxRetries: 0,
			fetch: (_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					if (signal) {
						boxSignals.push(signal);
						signal.addEventListener(
							"abort",
							() => reject(new DOMException("aborted", "AbortError")),
							{ once: true }
						);
					}
				}),
		});
		const agent = new Agent({
			name: "ops",
			model: "openai/gpt-4o-mini",
			tools: toRyuAgentTools(ryu, { readOnly: false, needsApproval: false }),
		});
		const controller = new AbortController();
		const run = agent
			.generate("Run the long job.", controller.signal)
			.catch((error: unknown) => error);
		for (let tick = 0; tick < 500 && boxSignals.length === 0; tick += 1) {
			await new Promise((done) => setTimeout(done, 2));
		}
		expect(boxSignals).toHaveLength(1);
		controller.abort();
		await run;
		expect(boxSignals[0]?.aborted).toBe(true);
	});

	test("the options block exposes writes, minus the excluded send", () => {
		const tools = chooseTools();
		expect(Object.keys(tools)).toEqual([
			"mail_status",
			"mail_list_inboxes",
			"mail_list_messages",
			"mail_get_message",
			"mail_create_inbox",
			"notify_publish",
			"notify_request_approval",
			"notify_list_events",
			"notify_get_event",
			"notify_ack_event",
			"notify_usage",
		]);
		expect(tools.notify_publish?.needsApproval).toBe(true);
		expect(tools.notify_ack_event?.needsApproval).toBe(false);
	});

	test("the AI SDK block builds tools whose execute calls Notify", async () => {
		const tools = aiSdkTools();
		expect(Object.keys(tools)).toEqual([
			"notify_list_events",
			"notify_get_event",
			"notify_usage",
		]);
		const output = await tools.notify_list_events?.execute(
			{ acknowledged: false },
			{ toolCallId: "call_1" }
		);
		expect(output?.error).toBeNull();
		expect(
			new URL(notifyRequests[0]?.url ?? "").searchParams.get("acknowledged")
		).toBe("false");
	});

	test("the page's code blocks are this file's regions, in order", () => {
		expect(pageFences()).toEqual(renderedRegions());
		expect(renderedRegions()).toHaveLength(4);
	});

	test("the MCP entry is valid JSON for ryu-cli's services server", () => {
		const entry = JSON.parse(shownRegion("mcp-config")) as {
			mcpServers: Record<string, { args: string[]; command: string }>;
		};
		const server = entry.mcpServers["ryu-services"];
		// ryu-cli ships with Ryu; @ryuhq/services-cli is not on npm yet.
		expect(server?.command).toBe("ryu-cli");
		// Read-only is the default; `--allow-writes` opts into write tools.
		expect(server?.args).toEqual(["services", "mcp", "--services", "notify"]);
	});
});
