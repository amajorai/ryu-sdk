/**
 * Fixture MCP stdio server used by bridge.test.ts.
 *
 * Registers one test Runnable ("greet") and serves over stdin/stdout.
 * Spawn with: bun run packages/sdk/src/mcp/fixture-server.ts
 */
import { z } from "zod";
import { McpServer } from "./server.ts";

const server = new McpServer().register({
	name: "greet",
	description: "Returns a greeting for the given name.",
	inputSchema: {
		type: "object",
		properties: { name: { type: "string", description: "Name to greet" } },
		required: ["name"],
	},
	run: (args) => {
		const a = z.object({ name: z.string().optional() }).parse(args);
		return Promise.resolve({ message: `Hello, ${a.name ?? "world"}!` });
	},
});

await server.serve();
