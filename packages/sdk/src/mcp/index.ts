/**
 * @ryuhq/sdk/mcp — MCP server + client surfaces.
 *
 * `McpServer` handles the MCP `initialize` handshake, `tools/list`,
 * `tools/call`, and the content-block envelope over stdio; `listTools` /
 * `callTool` drive a stdio MCP server. Re-exported here so consumers can
 * import from `@ryuhq/sdk/mcp` (or the narrower `/mcp/server` and
 * `/mcp/client` subpaths) as a single entry point.
 */

export type { McpStdioCommand, McpTool } from "./client.ts";
export { callTool, listTools, MCP_PROTOCOL_VERSION } from "./client.ts";
export type {
	JsonSchema,
	PassthroughRegistration,
	SdkRunnable,
} from "./server.ts";
export { McpServer, unwrapContent } from "./server.ts";
