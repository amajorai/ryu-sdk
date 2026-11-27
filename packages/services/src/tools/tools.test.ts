import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as z from "zod";
import type { RyuService } from "../errors.ts";
import { Ryu } from "../ryu.ts";
import {
	credentialFreeRyuTools,
	defineRyuTool,
	getRyuTool,
	RYU_TOOL_PREFIXES,
	RYU_TOOL_SERVICES,
	RYU_TOOLS,
	RYU_TOOLS_BY_SERVICE,
	runRyuTool,
	ryuToolJsonSchema,
	selectRyuTools,
	settled,
	settleToolCall,
	toAiSdkTools,
	toolOutput,
	toRyuAgentTools,
	toToolResultJson,
} from "./index.ts";

const NOTIFY_ENV = {
	RYU_NOTIFY_URL: "https://notify.example.com",
	RYU_NOTIFY_API_KEY: "notify-tools-secret",
};

/** Env that configures every service with tools. */
const ALL_ENV = {
	...NOTIFY_ENV,
	RYU_API_KEY: "ryu_test_key",
	RYU_ORGANIZATION_ID: "org_test",
	RYU_MAIL_URL: "https://mail.example.com",
	RYU_MAIL_API_KEY: "mail-key",
	RYU_BOX_URL: "https://box.example.com",
	RYU_BOX_API_KEY: "box-key",
	RYU_GATEWAY_URL: "https://gateway.example.com",
	RYU_GATEWAY_TOKEN: "gateway-token",
	RYU_PASSPORT_URL: "https://passport.example.com",
	RYU_PASSPORT_API_KEY: "passport-key",
	RYU_SITES_URL: "https://sites.example.com",
	RYU_SITES_API_KEY: "sites-key",
};

/** The registry tool `name`; a missing one fails the test. */
function registryTool(name: string) {
	const found = getRyuTool(name);
	if (found === undefined) {
		throw new Error(`${name} is not in RYU_TOOLS`);
	}
	return found;
}

function fixture(name: string) {
	return JSON.parse(
		readFileSync(
			resolve(import.meta.dir, "../../test/fixtures/notify", name),
			"utf8"
		)
	) as { body: unknown; headers: Record<string, string>; status: number };
}

/** A Notify client whose fetch answers every request with `name` and records it. */
function notifyRyu(name: string) {
	const requests: Request[] = [];
	const answer = fixture(name);
	const ryu = new Ryu({
		env: NOTIFY_ENV,
		maxRetries: 0,
		fetch: (input, init) => {
			requests.push(new Request(input, init));
			return Promise.resolve(
				new Response(JSON.stringify(answer.body), {
					status: answer.status,
					headers: answer.headers,
				})
			);
		},
	});
	return { requests, ryu };
}

describe("the registry", () => {
	test("tool names are unique, snake_case and carry their service's prefix", () => {
		const names = RYU_TOOLS.map((tool) => tool.name);
		expect(new Set(names).size).toBe(names.length);
		for (const tool of RYU_TOOLS) {
			expect({
				name: tool.name,
				ok:
					/^[a-z][a-z0-9_]*$/u.test(tool.name) &&
					tool.name.startsWith(RYU_TOOL_PREFIXES[tool.service]),
			}).toEqual({ name: tool.name, ok: true });
		}
	});

	test("every tool states all four effects, a title and a description", () => {
		for (const tool of RYU_TOOLS) {
			const { annotations } = tool;
			expect(Object.keys(annotations).sort()).toEqual([
				"destructiveHint",
				"idempotentHint",
				"openWorldHint",
				"readOnlyHint",
			]);
			// A read-only tool can never be destructive.
			expect({
				name: tool.name,
				consistent: !(annotations.readOnlyHint && annotations.destructiveHint),
			}).toEqual({ name: tool.name, consistent: true });
			expect(tool.title.length).toBeGreaterThan(0);
			expect(tool.description.length).toBeGreaterThan(20);
			expect(tool.inputSchema).toBeInstanceOf(z.ZodObject);
		}
	});

	test("RYU_TOOLS is the services' lists in RYU_TOOL_SERVICES order", () => {
		expect(RYU_TOOL_SERVICES).toEqual([
			"managedAgents",
			"messaging",
			"mail",
			"notify",
			"box",
			"gateway",
			"passport",
			"sites",
		]);
		expect(RYU_TOOLS).toEqual(
			RYU_TOOL_SERVICES.flatMap(
				(service) => RYU_TOOLS_BY_SERVICE[service] ?? []
			)
		);
		for (const [service, tools] of Object.entries(RYU_TOOLS_BY_SERVICE)) {
			for (const tool of tools ?? []) {
				expect({ name: tool.name, service: tool.service }).toEqual({
					name: tool.name,
					service: service as RyuService,
				});
			}
		}
	});

	test("tools that send, charge or run something are open-world writes", () => {
		for (const name of [
			"mail_send",
			"messaging_send_sms",
			"notify_publish",
			"notify_request_approval",
			"gateway_chat",
			"managed_agents_create_session",
			"managed_agents_send_message",
			"box_exec",
		]) {
			expect({ name, ...getRyuTool(name)?.annotations }).toMatchObject({
				name,
				readOnlyHint: false,
				openWorldHint: true,
			});
		}
		for (const name of ["box_delete", "box_stop", "sites_deploy"]) {
			expect({ name, ...getRyuTool(name)?.annotations }).toMatchObject({
				name,
				readOnlyHint: false,
				destructiveHint: true,
			});
		}
	});

	test("every input schema converts to a JSON Schema object", () => {
		for (const tool of RYU_TOOLS) {
			const schema = ryuToolJsonSchema(tool);
			expect(schema.type).toBe("object");
			expect(typeof schema.properties).toBe("object");
			expect("$schema" in schema).toBe(false);
		}
		expect(ryuToolJsonSchema(registryTool("mail_send")).required).toEqual(
			expect.arrayContaining(["from", "to", "subject", "idempotencyKey"])
		);
	});

	test("every tool input property carries a description", () => {
		const undescribed: string[] = [];
		for (const tool of RYU_TOOLS) {
			const { properties } = ryuToolJsonSchema(tool);
			for (const [name, property] of Object.entries(properties)) {
				if (!property.description?.trim()) {
					undescribed.push(`${tool.name}.${name}`);
				}
			}
		}
		expect(undescribed).toEqual([]);
	});

	test("a stopped Box can be started again: box_stop points at box_resume", () => {
		expect(registryTool("box_stop").description).toContain("box_resume");
		expect(registryTool("box_resume").annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
		expect(registryTool("box_get").annotations.readOnlyHint).toBe(true);
		expect(registryTool("box_create").description).toContain("box_get");
		// Every Box lifecycle verb the SDK has at the top level is a tool.
		expect(RYU_TOOLS_BY_SERVICE.box?.map((entry) => entry.name)).toEqual([
			"box_list",
			"box_get",
			"box_create",
			"box_exec",
			"box_read_file",
			"box_write_file",
			"box_stop",
			"box_resume",
			"box_delete",
		]);
	});

	test("box_write_file says what happens to parent directories and size", () => {
		const { description } = registryTool("box_write_file");
		expect(description).toContain("parent directories are created");
		expect(description).toContain("64 MiB");
		// apps/box/src/contracts.ts: the per-file limit the description names.
		const contracts = readFileSync(
			resolve(import.meta.dir, "../../../../apps/box/src/contracts.ts"),
			"utf8"
		);
		expect(contracts).toContain("MAX_FILE_BYTES = 64 * 1024 * 1024");
	});

	test("mail_send names its from parameter and the hosted inboxId difference", () => {
		const { description } = registryTool("mail_send");
		expect(description).toContain("`from`");
		expect(description).toContain("`inboxId`");
	});
});

describe("an agent with a new Mail key", () => {
	test("mail_list_inboxes and mail_send point at mail_create_inbox and the person's paths", () => {
		for (const name of ["mail_list_inboxes", "mail_send"]) {
			const description = getRyuTool(name)?.description ?? "";
			expect(description).toContain("`mail_create_inbox`");
			expect(description).toContain("only when writes are allowed");
			expect(description).toContain("`mail.inboxes.create`");
			expect(description).toContain("`mail inboxes create`");
			expect(description).toContain("mail:manage");
			expect(description).not.toContain("No tool creates an inbox");
		}
	});

	test("mail_create_inbox is a write that needs a clientId and names both Mail modes", () => {
		const create = getRyuTool("mail_create_inbox");
		expect(create?.service).toBe("mail");
		expect(create?.annotations.readOnlyHint).toBe(false);
		expect(create?.description).toContain("`clientId` is required");
		expect(create?.description).toContain("Self-hosted Mail needs `address`");
		expect(create?.description).toContain("mail:manage");
		const names = RYU_TOOLS.map((tool) => tool.name);
		expect(names.indexOf("mail_create_inbox")).toBe(
			names.indexOf("mail_send") - 1
		);
	});

	test("mail_create_inbox refuses padded clientIds and blank names in any script", () => {
		const schema = getRyuTool("mail_create_inbox")?.inputSchema;
		const parses = (input: Record<string, unknown>) =>
			schema?.safeParse(input).success;
		expect(parses({ name: "Support", clientId: "a b" })).toBe(true);
		for (const clientId of [" k", "k ", "   ", "caf\u00e9"]) {
			expect(parses({ name: "Support", clientId })).toBe(false);
		}
		for (const name of [" ", "\u00a0", "\ufeff", "\u3000\u2028"]) {
			expect(parses({ name, clientId: "k" })).toBe(false);
		}
	});

	test("mail_create_inbox says a clientId retry returns the inbox and which Mail reads description", () => {
		const create = getRyuTool("mail_create_inbox");
		expect(create?.description).toContain(
			"a retry with the same one gives back the inbox already made"
		);
		const shape = JSON.stringify(
			create ? z.toJSONSchema(create.inputSchema) : {}
		);
		// Both Mail servers now hold clientId unique, so overlapping retries are
		// safe and the tool no longer limits them to sequential ones.
		expect(shape).not.toContain("still running");
		expect(create?.description).not.toContain("after the first call");
		expect(shape).toContain("Self-hosted Mail ignores it.");
	});
});

describe("selectRyuTools", () => {
	const all = new Ryu({ env: ALL_ENV });

	test("defaults to read-only tools of every configured service", () => {
		const selected = selectRyuTools(all);
		expect(selected.length).toBeGreaterThan(0);
		expect(selected.every((tool) => tool.annotations.readOnlyHint)).toBe(true);
		expect(selected.map((tool) => tool.name)).toEqual(
			RYU_TOOLS.filter((tool) => tool.annotations.readOnlyHint).map(
				(tool) => tool.name
			)
		);
	});

	test("readOnly: false exposes the writes too", () => {
		expect(selectRyuTools(all, { readOnly: false })).toEqual([...RYU_TOOLS]);
	});

	test("leaves out services the client is not configured for", () => {
		const notifyOnly = new Ryu({ env: NOTIFY_ENV });
		const names = selectRyuTools(notifyOnly, { readOnly: false }).map(
			(tool) => tool.service
		);
		expect(new Set(names)).toEqual(new Set(["notify"]));
	});

	test("services, include and exclude narrow the list", () => {
		expect(
			selectRyuTools(all, { services: ["notify"] }).map((tool) => tool.name)
		).toEqual(["notify_list_events", "notify_get_event", "notify_usage"]);
		expect(
			selectRyuTools(all, {
				include: ["notify_get_event", "box_list"],
			}).map((tool) => tool.name)
		).toEqual(["notify_get_event", "box_list"]);
		expect(
			selectRyuTools(all, {
				services: ["notify"],
				exclude: ["notify_usage"],
			}).map((tool) => tool.name)
		).toEqual(["notify_list_events", "notify_get_event"]);
	});

	test("a wrong option is a configuration error, never a silently missing tool", () => {
		expect(() => selectRyuTools(all, { include: ["mail_sned"] })).toThrow(
			"Unknown tool name in include: mail_sned"
		);
		expect(() => selectRyuTools(all, { exclude: ["nope"] })).toThrow(
			"Unknown tool name in exclude: nope"
		);
		expect(() => selectRyuTools(all, { include: ["mail_send"] })).toThrow(
			"pass readOnly: false"
		);
		expect(
			selectRyuTools(all, { include: ["mail_send"], readOnly: false }).map(
				(tool) => tool.name
			)
		).toEqual(["mail_send"]);
		const notifyOnly = new Ryu({ env: NOTIFY_ENV });
		try {
			selectRyuTools(notifyOnly, { services: ["notify", "box"] });
			throw new Error("expected a configuration error");
		} catch (error) {
			expect(error).toMatchObject({
				name: "RyuConfigurationError",
				code: "configuration_error",
				service: "box",
			});
		}
	});
});

describe("runRyuTool", () => {
	test("rejected arguments come back as invalid_arguments with the issues", async () => {
		const { ryu, requests } = notifyRyu("publish-created.json");
		const tool = registryTool("notify_publish");
		const result = await runRyuTool(ryu, tool, { level: "loud" });
		expect(requests).toEqual([]);
		expect(result.data).toBeNull();
		expect(result.error).toMatchObject({
			name: "RyuInvalidRequestError",
			code: "invalid_arguments",
			service: "notify",
			retryable: false,
		});
		const details = result.error?.details as {
			issues: { path: string }[];
			tool: string;
		};
		expect(details.tool).toBe("notify_publish");
		expect(details.issues.map((issue) => issue.path).sort()).toEqual([
			"level",
			"title",
		]);
		expect(result.error?.message).toContain(
			"notify_publish was called with invalid arguments"
		);
	});

	test("a facade call keeps its meta", async () => {
		const { ryu, requests } = notifyRyu("publish-created.json");
		const result = await runRyuTool(ryu, registryTool("notify_publish"), {
			title: "Deploy finished",
			idempotencyKey: "deploy-184",
		});
		expect(result.error).toBeNull();
		expect(result.meta).toMatchObject({
			requestId: "req_7432f3e0c3f847db8f7c3272bbd03391",
			idempotencyKey: "deploy-184",
		});
		expect(requests[0]?.headers.get("idempotency-key")).toBe("deploy-184");
	});

	test("settled() carries meta through an async body, and throws become RyuErrors", async () => {
		const { ryu } = notifyRyu("events-page-1.json");
		const viaSettled = await settleToolCall("notify", async () => {
			await Promise.resolve();
			return settled(ryu.notify.events.list({}));
		});
		expect(viaSettled.meta?.requestId).toBe(
			"req_4cbae62e029546ccb69dea25d83c62ba"
		);
		const thrown = await settleToolCall("notify", () => {
			throw new Error("Pass both from and to, or neither.");
		});
		expect(thrown.error).toMatchObject({ service: "notify" });
		expect(thrown.error?.message).toContain("Pass both from and to");
	});

	test("defineRyuTool types run from the schema", async () => {
		const echo = defineRyuTool({
			service: "notify",
			name: "notify_echo",
			title: "Echo",
			description: "Returns its input text, for tests of the registry types.",
			inputSchema: z.object({ text: z.string() }),
			annotations: registryTool("notify_get_event").annotations,
			outputSchema: toolOutput(z.object({ echoed: z.string() })),
			run: (_ryu, { text }) => ({ echoed: text.toUpperCase() }),
		});
		const result = await runRyuTool(new Ryu({ env: {} }), echo, { text: "hi" });
		expect(toToolResultJson(result)).toEqual({
			data: { echoed: "HI" },
			error: null,
			// No request was made, so the compact meta has nothing to report.
			meta: {},
		});
	});
});

describe("toAiSdkTools", () => {
	test("returns the AI SDK tool shape, keyed by tool name, read-only by default", () => {
		const { ryu } = notifyRyu("events-page-1.json");
		const tools = toAiSdkTools(ryu);
		expect(Object.keys(tools)).toEqual([
			"notify_list_events",
			"notify_get_event",
			"notify_usage",
		]);
		const listEvents = tools.notify_list_events;
		expect(typeof listEvents?.description).toBe("string");
		expect(listEvents?.inputSchema).toBe(
			registryTool("notify_list_events").inputSchema
		);
		expect(typeof listEvents?.execute).toBe("function");
		expect(listEvents?.needsApproval).toBe(false);
	});

	test("execute resolves to plain { data, error, meta } JSON", async () => {
		const { ryu, requests } = notifyRyu("events-page-1.json");
		const output = await toAiSdkTools(ryu).notify_list_events?.execute(
			{ limit: 2 },
			{ toolCallId: "call_1", abortSignal: new AbortController().signal }
		);
		expect(new URL(requests[0]?.url ?? "").searchParams.get("limit")).toBe("2");
		expect(output?.error).toBeNull();
		expect(JSON.parse(JSON.stringify(output))).toEqual(output);
		expect(
			(output?.data as { events: { title: string }[] }).events[0]?.title
		).toBe("Fourth");
	});

	// The AI SDK itself validates with inputSchema before calling execute; this
	// pins what a direct execute call (outside the AI SDK) answers.
	test("a direct execute call with invalid input resolves to invalid_arguments", async () => {
		const { ryu, requests } = notifyRyu("events-page-1.json");
		const output = await toAiSdkTools(ryu).notify_list_events?.execute({
			limit: 1000,
		});
		expect(requests).toEqual([]);
		expect(output?.error).toMatchObject({
			code: "invalid_arguments",
			details: { issues: [expect.objectContaining({ path: "limit" })] },
		});
		expect(JSON.stringify(output)).not.toContain("notify-tools-secret");
	});

	test("writes appear only with readOnly: false and ask for approval by default", () => {
		const { ryu } = notifyRyu("publish-created.json");
		const tools = toAiSdkTools(ryu, { readOnly: false });
		expect(tools.notify_publish?.needsApproval).toBe(true);
		expect(tools.notify_list_events?.needsApproval).toBe(false);
		const unattended = toAiSdkTools(ryu, {
			readOnly: false,
			needsApproval: false,
		});
		expect(unattended.notify_publish?.needsApproval).toBe(false);
		const custom = toAiSdkTools(ryu, {
			readOnly: false,
			needsApproval: (tool) => tool.annotations.openWorldHint,
		});
		expect(custom.notify_ack_event?.needsApproval).toBe(false);
		expect(custom.notify_publish?.needsApproval).toBe(true);
	});
});

describe("toRyuAgentTools", () => {
	test("returns @ryuhq/sdk tool runnables with a JSON Schema", () => {
		const { ryu } = notifyRyu("events-page-1.json");
		const tools = toRyuAgentTools(ryu, { readOnly: false });
		const publish = tools.notify_publish;
		expect(publish).toMatchObject({
			kind: "tool",
			id: "notify_publish",
			name: "Publish a Notify event",
			needsApproval: true,
		});
		expect(publish?.schema).toEqual(
			ryuToolJsonSchema(registryTool("notify_publish"))
		);
		expect(tools.notify_get_event?.needsApproval).toBe(false);
	});

	test("the sandbox body refuses to run outside the process", async () => {
		const { ryu } = notifyRyu("events-page-1.json");
		const code = toRyuAgentTools(ryu).notify_get_event?.code ?? "";
		const body = new Function(
			`return (async () => { ${code} })();`
		) as () => Promise<unknown>;
		await expect(body()).rejects.toThrow(
			"notify_get_event is an @ryuhq/services tool: it runs in-process"
		);
	});

	test("run validates with zod and returns failures as results", async () => {
		const { ryu, requests } = notifyRyu("events-page-1.json");
		const tools = toRyuAgentTools(ryu);
		const bad = await tools.notify_get_event?.run({ eventId: "" });
		expect(requests).toEqual([]);
		expect(bad?.error?.code).toBe("invalid_arguments");
		const good = await tools.notify_list_events?.run({});
		expect(good?.error).toBeNull();
	});
});

describe("credential-free tools", () => {
	test("only mail_status and messaging_status, read-only with no arguments", () => {
		const free = RYU_TOOLS.filter((tool) => tool.credentialFree === true);
		expect(free.map((tool) => tool.name)).toEqual([
			"messaging_status",
			"mail_status",
		]);
		for (const tool of free) {
			expect(tool.annotations.readOnlyHint).toBe(true);
			expect(tool.annotations.destructiveHint).toBe(false);
			expect(Object.keys(tool.inputSchema.shape)).toEqual([]);
		}
	});

	test("credentialFreeRyuTools applies only to unconfigured services whose URL resolves", () => {
		const anonymous = new Ryu({ env: {} });
		expect(
			credentialFreeRyuTools(anonymous, "messaging").map((tool) => tool.name)
		).toEqual(["messaging_status"]);
		expect(
			credentialFreeRyuTools(anonymous, "mail").map((tool) => tool.name)
		).toEqual(["mail_status"]);
		expect(credentialFreeRyuTools(anonymous, "notify")).toEqual([]);
		// Configured: every tool applies, so there is no fallback list.
		const configured = new Ryu({
			env: { RYU_API_KEY: "ryu_k", RYU_ORGANIZATION_ID: "org_1" },
		});
		expect(credentialFreeRyuTools(configured, "messaging")).toEqual([]);
		expect(credentialFreeRyuTools(configured, "mail")).toEqual([]);
		// Self-hosted Mail guards its status route.
		const selfHosted = new Ryu({
			env: { RYU_MAIL_URL: "http://127.0.0.1:7996" },
		});
		expect(credentialFreeRyuTools(selfHosted, "mail")).toEqual([]);
	});

	test("the adapters still expose only configured services' tools", () => {
		const names = selectRyuTools(new Ryu({ env: {} })).map((tool) => tool.name);
		expect(names).toEqual([]);
	});
});
