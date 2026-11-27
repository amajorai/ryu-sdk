/**
 * The `@ryuhq/sdk/langchain` entry point. It switches a LangChain JS app to
 * the Ryu Gateway in one line.
 *
 *   import { ChatOpenAI } from "@langchain/openai";
 *   import { ryuChatOpenAI } from "@ryuhq/sdk/langchain";
 *
 *   const model = new ChatOpenAI(ryuChatOpenAI("gpt-4o"));
 *
 * `ryuChatOpenAI` returns the fields LangChain's stock `ChatOpenAI` takes, so
 * that class does the calls: `invoke`, `stream`, `bindTools` and LangGraph
 * agents work as they do for any OpenAI model, and every call passes the
 * Gateway's policies, budgets and audit log. This module imports nothing from
 * LangChain and nothing native. Option names match `@langchain/openai` 1.8.
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

/**
 * The `ChatOpenAI` constructor fields that point it at the Ryu Gateway.
 * Spread it to add your own fields: `{ ...ryuChatOpenAI("gpt-4o"), temperature: 0 }`.
 */
export interface RyuChatOpenAIFields {
	/**
	 * The Gateway key. Always set: when `apiKey` is undefined `ChatOpenAI`
	 * falls back to `OPENAI_API_KEY` and would send that provider key here.
	 */
	apiKey: string;
	/** Options of the underlying OpenAI client. */
	configuration: {
		/** The Gateway's OpenAI compatible base URL (ends in `/v1`). */
		baseURL: string;
		/** Extra headers sent with every call. */
		defaultHeaders?: Record<string, string>;
	};
	/** The Gateway model id, as listed by `GET /v1/models`. */
	model: string;
	/**
	 * Keeps ordinary calls on `/v1/chat/completions`, the route the Gateway
	 * governs end to end.
	 */
	useResponsesApi: false;
}

/**
 * Build the `ChatOpenAI` fields for a Gateway model.
 *
 * The URL and key come from `options`, then `RYU_GATEWAY_URL` and
 * `RYU_GATEWAY_TOKEN`, then the local Gateway. A direct provider URL throws.
 */
export function ryuChatOpenAI(
	model: string,
	options: RyuGatewayOptions = {}
): RyuChatOpenAIFields {
	const id = gatewayModelId(model);
	const target = resolveRyuGateway(options);
	const configuration: RyuChatOpenAIFields["configuration"] = {
		baseURL: target.baseUrl,
	};
	if (target.headers) {
		configuration.defaultHeaders = target.headers;
	}
	return {
		apiKey: target.apiKey,
		configuration,
		model: id,
		useResponsesApi: false,
	};
}
