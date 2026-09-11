// packages/core-client/src/gateway.test.ts
//
// Pins the ONE contract `@ryuhq/core-client/gateway` has that can silently
// destroy a node's config: `fetchGatewayConfig` must return `routing` exactly as
// the gateway served it.
//
// Why this is worth a test even though no in-repo surface imports this module
// (the desktop carries its own copy of the client): the package's export map is
// `"./*": "./src/*.ts"`, so `@ryuhq/core-client/gateway` is a published entry
// point on npm. The assertions below are about the shape a third-party consumer
// receives, not about an internal call graph — which is exactly the case where
// "nothing in this repo calls it" is not a reason to leave it wrong.
//
// The defect being pinned: `fetchGatewayConfig` used to coalesce
// `routing.smart_routing` to `DEFAULT_SMART_ROUTING`. `PUT /v1/config { routing }`
// replaces the routing section wholesale and `RoutingConfig::smart_routing` is
// `#[serde(default)]`, so that fabricated `enabled: false` is not inert — a
// consumer that read, spread and wrote back any *other* routing field would turn
// a hand-written `[routing.smart_routing]` off. Served-and-off and never-served
// must therefore stay distinguishable at the load edge.

import { afterEach, describe, expect, test } from "bun:test";
import type { ApiTarget } from "./client.ts";
import {
	DEFAULT_SMART_ROUTING,
	fetchGatewayConfig,
	type GatewayRoutingConfig,
	routingViewIncludesSmartRouting,
	type SmartRoutingConfig,
} from "./gateway.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const target: ApiTarget = {
	url: "http://127.0.0.1:7980",
	token: "t",
	userJwt: null,
};

function stub(body: unknown, status = 200): void {
	globalThis.fetch = ((_url: string, _init: RequestInit) =>
		Promise.resolve(
			new Response(JSON.stringify(body), { status })
		)) as typeof fetch;
}

/** A minimal `GET /api/gateway/config` body with a routing section we control. */
function configBody(routing: Record<string, unknown> | undefined) {
	return {
		auth: { api_keys: [], require_auth: false },
		providers: {
			anthropic: null,
			core: null,
			local: null,
			openai: null,
			openrouter: null,
		},
		...(routing === undefined ? {} : { routing }),
	};
}

const servedRouting = {
	default_provider: "openai",
	model_map: {},
	fallback_chain: [],
};

describe("fetchGatewayConfig: routing.smart_routing served vs not served", () => {
	test("a gateway that does not serve the section yields no smart_routing key", async () => {
		stub(configBody(servedRouting));

		const cfg = await fetchGatewayConfig(target);

		// Not `toBeUndefined()`: the point is the KEY is absent, so a spread-based
		// read-modify-write cannot carry a fabricated section back out to the PUT.
		expect("smart_routing" in cfg.routing).toBe(false);
		expect(routingViewIncludesSmartRouting(cfg.routing)).toBe(false);
	});

	test("a gateway that serves the section switched off is NOT the same state", async () => {
		const off: SmartRoutingConfig = { ...DEFAULT_SMART_ROUTING };
		stub(configBody({ ...servedRouting, smart_routing: off }));

		const cfg = await fetchGatewayConfig(target);

		expect(routingViewIncludesSmartRouting(cfg.routing)).toBe(true);
		expect(cfg.routing.smart_routing).toEqual(off);
	});

	test("a served section is passed through byte-for-byte, not merged over a default", async () => {
		// Every field deliberately differs from DEFAULT_SMART_ROUTING, including the
		// three (`strategy`, `embedding_model`, `similarity_threshold`) this
		// package's interface could not see until now. A merge-over-default would
		// still produce `enabled: true` and pass a shallower assertion.
		const served = {
			enabled: true,
			strategy: "embedding",
			classifier_model: "gemma-3-270m-it-qat-Q4_0",
			embedding_model: "nomic-embed-text",
			similarity_threshold: 0.62,
			rules: [{ description: "writing code", model: "claude-sonnet" }],
			default_model: "gpt-4o-mini",
			cache_by_session: false,
			timeout_ms: 1500,
		};
		stub(configBody({ ...servedRouting, smart_routing: served }));

		const cfg = await fetchGatewayConfig(target);

		expect(cfg.routing.smart_routing).toEqual(served as SmartRoutingConfig);
	});

	test("no routing section at all still omits smart_routing", async () => {
		// The `DEFAULT_ROUTING` stand-in used when a 2xx carries no `routing` at all
		// must not manufacture the section either — it stands for "the gateway told
		// us nothing", which is the strongest form of not-served.
		stub(configBody(undefined));

		const cfg = await fetchGatewayConfig(target);

		expect(routingViewIncludesSmartRouting(cfg.routing)).toBe(false);
		expect(cfg.routing.default_provider).toBe("openai");
	});
});

describe("routingViewIncludesSmartRouting", () => {
	test("an explicitly undefined value still counts as served", () => {
		// `in` is a key test, not a value test, and that is the intended semantics:
		// the desktop predicate behaves the same way. A caller that constructs
		// `{ smart_routing: undefined }` by hand has asserted the key exists; only
		// omission means the gateway never mentioned it.
		const routing = {
			default_provider: "openai",
			model_map: {},
			fallback_chain: [],
			smart_routing: undefined,
		} as unknown as GatewayRoutingConfig;

		expect(routingViewIncludesSmartRouting(routing)).toBe(true);
	});
});

describe("DEFAULT_SMART_ROUTING", () => {
	test("carries every field RoutingView serves, so a form bound to it round-trips", () => {
		// `RoutingView.smart_routing` (apps/gateway/src/api/config.rs) is a plain
		// struct whose `#[serde(default)]` fields are all always emitted. A default
		// object missing any of them is a consumer-visible hole: spread it into a
		// PUT and the absent fields deserialize back to the Rust defaults, silently
		// resetting an operator's `strategy`/`similarity_threshold`.
		expect(Object.keys(DEFAULT_SMART_ROUTING).sort()).toEqual([
			"cache_by_session",
			"classifier_model",
			"default_model",
			"embedding_model",
			"enabled",
			"escalation_confirmations",
			"escalation_judge_model",
			"escalation_message_chars",
			"escalation_recent_message_window",
			"escalation_strong_model",
			"escalation_weak_model",
			"random_seed",
			"router_type",
			"rules",
			"similarity_threshold",
			"stage_capable_model",
			"stage_confidence_threshold",
			"stage_efficient_model",
			"stage_picker",
			"stage_recent_message_window",
			"strategy",
			"timeout_ms",
		]);
	});
});
