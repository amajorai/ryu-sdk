/**
 * The `@ryuhq/sdk/mastra` entry point. It switches a Mastra app to the Ryu
 * Gateway in one line.
 *
 *   import { Agent } from "@mastra/core/agent";
 *   import { ryuModel } from "@ryuhq/sdk/mastra";
 *
 *   const agent = new Agent({
 *     id: "support",
 *     name: "Support",
 *     instructions: "You are a helpful assistant.",
 *     model: ryuModel("gpt-4o"),
 *   });
 *
 * `ryuModel` returns Mastra's own OpenAI compatible model config (the `url`
 * form), so Mastra's stock client does the calls: streaming, tool calls and
 * structured output work as they do for any Mastra model, and every call
 * passes the Gateway's policies, budgets and audit log. This module imports
 * nothing from Mastra and nothing native. Option names match `@mastra/core`
 * 1.84.
 */

import {
	gatewayModelId,
	type RyuGatewayOptions,
	resolveRyuGateway,
} from "./gateway-target.ts";

export type { RyuGatewayOptions, RyuGatewayTarget } from "./gateway-target.ts";
export {
	assertGatewayUrl,
	DEFAULT_GATEWAY_URL,
	ENV_GATEWAY_TOKEN,
	ENV_GATEWAY_URL,
	RYU_NO_KEY,
	resolveRyuGateway,
} from "./gateway-target.ts";

/** The provider segment of the Mastra model id (`ryu/<model>`). */
export const RYU_MASTRA_PROVIDER = "ryu";

/**
 * A Mastra model config that points at the Ryu Gateway. Structurally the
 * `{ id, url, apiKey, headers }` form Mastra accepts wherever a model goes.
 */
export interface RyuMastraModel {
	/** The Gateway key. Mastra reads no key from the environment for a `url` model. */
	apiKey: string;
	/** Extra headers sent with every call. */
	headers?: Record<string, string>;
	/** `ryu/<gateway model id>`. Mastra sends the part after the first slash. */
	id: `ryu/${string}`;
	/** The Gateway's OpenAI compatible base URL (ends in `/v1`). */
	url: string;
}

/**
 * Build the Mastra model config for a Gateway model.
 *
 * `model` is a Gateway model id as listed by `GET /v1/models`, for example
 * `"gpt-4o"` or `"anthropic/claude-sonnet-4"`. Do not add the `ryu/` prefix
 * yourself. The URL and key come from `options`, then `RYU_GATEWAY_URL` and
 * `RYU_GATEWAY_TOKEN`, then the local Gateway. A direct provider URL throws.
 */
export function ryuModel(
	model: string,
	options: RyuGatewayOptions = {}
): RyuMastraModel {
	const id = gatewayModelId(model);
	const target = resolveRyuGateway(options);
	const config: RyuMastraModel = {
		apiKey: target.apiKey,
		id: `${RYU_MASTRA_PROVIDER}/${id}`,
		url: target.baseUrl,
	};
	if (target.headers) {
		config.headers = target.headers;
	}
	return config;
}
