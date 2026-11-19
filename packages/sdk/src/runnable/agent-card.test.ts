import { expect, test } from "bun:test";
import { validateManifestValue } from "../cli/validate.ts";
import { defineAgent } from "./agent.ts";
import type { GatewayClient, RunnableContext } from "./runnable-types.ts";

test("an agent without a custom runner has a string result contract", async () => {
	const messages: Array<{ content: string; role: string }> = [];
	const gateway: GatewayClient = {
		chat: async (input) => {
			messages.push(...input);
			return { content: "answer", finishReason: "stop" };
		},
		async *stream() {
			yield { content: "answer", finishReason: "stop" };
		},
	};
	const agent = defineAgent({
		id: "agent-default",
		name: "Default runner",
		chat: { persona: "Respond briefly." },
	});
	const result: string = await agent.run({ question: "hello" }, { gateway });
	expect(result).toBe("answer");
	expect(messages).toEqual([
		{ role: "system", content: "Respond briefly." },
		{ role: "user", content: '{"question":"hello"}' },
	]);
});

test("a custom runner retains its inferred output and object identity", async () => {
	const gateway: GatewayClient = {
		chat: async () => ({ content: "unused", finishReason: null }),
		async *stream() {
			yield { content: "unused", finishReason: null };
		},
	};
	const context: RunnableContext = { gateway };
	const output = { count: 0, enabled: false };
	const agent = defineAgent({
		id: "agent-custom",
		name: "Custom runner",
		run: async () => output,
	});
	const result: typeof output = await agent.run({}, context);
	expect(result).toBe(output);
});

test("a declared identity mode lowers to config.identity_mode", () => {
	const agent = defineAgent({
		id: "agent-own",
		name: "Own identity",
		identityMode: "individual",
		chat: { model: "gpt-4o" },
	});
	expect(agent.card.identityMode).toBe("individual");
	const [meta] = agent.toManifest({
		id: "com.acme.own",
		version: "1.0.0",
	}).runnables;
	expect(meta?.config).toEqual({
		identity_mode: "individual",
		model: "gpt-4o",
	});
	expect(validateManifestValue(agentManifest(meta?.config))).toEqual([]);
});

test("an agent without an identity mode leaves Ryu's default in place", () => {
	const agent = defineAgent({
		id: "agent-legacy",
		name: "Legacy",
		chat: { model: "gpt-4o" },
	});
	const [meta] = agent.toManifest({
		id: "com.acme.legacy",
		version: "1.0.0",
	}).runnables;
	expect(meta?.config).toEqual({ model: "gpt-4o" });
});

test("an unknown identity mode is refused instead of dropped", () => {
	expect(() =>
		defineAgent({
			id: "agent-bad",
			name: "Bad",
			// @ts-expect-error -- JavaScript callers can still pass any string.
			identityMode: "owner",
		})
	).toThrow();
});

test("the public manifest schema refuses an app-supplied account allowlist", () => {
	const findings = validateManifestValue(
		agentManifest({ identity_mode: "mixed", account_access: ["platform:treg"] })
	);
	expect(findings.some((finding) => finding.source === "json-schema")).toBe(
		true
	);
	expect(
		validateManifestValue(agentManifest({ identity_mode: "owner" })).some(
			(finding) => finding.message.includes("identity_mode")
		)
	).toBe(true);
});

function agentManifest(config: unknown) {
	return {
		id: "com.acme.identity",
		name: "Identity",
		version: "1.0.0",
		runnables: [{ id: "agent", name: "Agent", kind: "agent", config }],
	};
}
