/**
 * @ryuhq/sdk/model — the gateway-mandatory model client.
 *
 * Every model call routes through the Ryu Gateway, never a direct provider.
 * Re-exports the `ModelClient` / `defineModel` surface plus the gateway
 * resolution + egress helpers, so consumers can import from
 * `@ryuhq/sdk/model` as a single entry point.
 */

export type {
	ChatDelta,
	ChatMessage,
	ChatResult,
	ModelClientOptions,
} from "./client.ts";
export { defineModel, ModelClient } from "./client.ts";
export {
	assertAllowedEgressUrl,
	DEFAULT_GATEWAY_URL,
	resolveGatewayToken,
	resolveGatewayUrl,
} from "./gateway.ts";
