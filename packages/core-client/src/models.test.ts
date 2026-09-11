import { expect, test } from "bun:test";
import {
	previewActiveModel,
	previewModelInstall,
	previewModelUninstall,
} from "./models.ts";

test("model previews carry dryRun without touching model files", async () => {
	const bodies: unknown[] = [];
	const target = {
		url: "https://node.example",
		token: "node-token",
		fetch: async (_url: RequestInfo | URL, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)));
			return Response.json({
				action: "install",
				dryRun: true,
				success: true,
			});
		},
	};

	await previewModelInstall(target, "owner/model", {
		file: "model-Q4.gguf",
		format: "gguf",
	});
	await previewModelUninstall(target, "owner/model", "model-Q4.gguf");

	expect(bodies).toEqual([
		{
			dryRun: true,
			file: "model-Q4.gguf",
			format: "gguf",
			id: "owner/model",
		},
		{ dryRun: true, file: "model-Q4.gguf", id: "owner/model" },
	]);
});

test("previews active model switches without using a live mutation body", async () => {
	const bodies: unknown[] = [];
	const target = {
		url: "https://node.example",
		token: "node-token",
		fetch: async (_url: RequestInfo | URL, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)));
			return Response.json({
				action: "switch",
				dryRun: true,
				success: true,
			});
		},
	};

	await previewActiveModel(target, "TheBloke/model.gguf", "llamacpp");

	expect(bodies).toEqual([
		{ dryRun: true, id: "TheBloke/model.gguf", engine: "llamacpp" },
	]);
});
