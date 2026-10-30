import { describe, expect, test } from "bun:test";
import {
	app,
	defineApp,
	definePlugin,
	SlashCommandContributionSchema,
} from "./index.ts";

const slashCommand = {
	args: [
		{
			custom: { label: "Use another environment" },
			name: "environment",
			options: [
				{ label: "Staging", value: "staging" },
				{ label: "Production", value: "production" },
			],
		},
	],
	command: "/deploy",
	description: "Deploy the current project",
};

describe("slash command contributions", () => {
	test("validate sequential options and custom choices", () => {
		expect(SlashCommandContributionSchema.parse(slashCommand)).toEqual(
			slashCommand
		);
	});

	test("defineApp publishes slash commands", () => {
		const manifest = defineApp({
			id: "com.example.deploy",
			title: "Deploy",
			version: "1.0.0",
			slug: "deploy",
			uiEntry: "src/deploy.tsx",
			tools: [{ name: "render", description: "Render deploy status" }],
			slashCommands: [slashCommand],
		});

		expect(manifest.contributes?.slash_commands).toEqual([slashCommand]);
	});

	test("definePlugin publishes slash commands", () => {
		const manifest = definePlugin({
			id: "com.example.deploy-plugin",
			name: "Deploy",
			version: "1.0.0",
			slashCommands: [slashCommand],
		});

		expect(manifest.contributes?.slash_commands).toEqual([slashCommand]);
	});

	test("AppBuilder publishes slash commands", () => {
		const manifest = app()
			.id("com.example.deploy-builder")
			.title("Deploy")
			.version("1.0.0")
			.slug("deploy-builder")
			.uiEntry("src/deploy.tsx")
			.tool({ name: "render", description: "Render deploy status" })
			.slashCommand(slashCommand)
			.build();

		expect(manifest.contributes?.slash_commands).toEqual([slashCommand]);
	});
});
