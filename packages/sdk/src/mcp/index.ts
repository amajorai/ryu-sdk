/**
 * @ryuhq/sdk/mcp — MCP server + client surfaces.
 *
 * `McpServer` handles 2026-07-28 `server/discover`, per-request metadata,
 * `tools/list`, and `tools/call` over stdio while retaining legacy initialize.
 * `listTools` / `callTool` negotiate with modern and legacy servers. Re-exported
 * here so consumers can import from `@ryuhq/sdk/mcp` (or the narrower
 * `/mcp/server` and `/mcp/client` subpaths) as a single entry point.
 */

export type { McpStdioCommand, McpTool } from "./client.ts";
export {
	callTool,
	listTools,
	MCP_LEGACY_PROTOCOL_VERSION,
	MCP_PROTOCOL_VERSION,
} from "./client.ts";
export type {
	JsonSchema,
	PassthroughRegistration,
	SdkRunnable,
} from "./server.ts";
export { McpServer, unwrapContent } from "./server.ts";
