// Server conformance for the Managed Agents slice. Test-only relative imports:
// the published SDK never depends on packages/protocol or packages/api. The
// router is read as text (importing it would pull in the whole API runtime).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	isManagedAgentsIdempotencyKey,
	MANAGED_AGENTS_BASE_PATH,
	MANAGED_AGENTS_ERROR_STATUS,
	MANAGED_AGENTS_ROUTES as PROTOCOL_ROUTES,
} from "../../../protocol/src/managed-agents.ts";
import { AVAILABILITY_CODES } from "../../src/errors.ts";
import {
	MANAGED_AGENTS_ERROR_CODES,
	MANAGED_AGENTS_PREVIEW_HINTS,
} from "../../src/managed-agents/codes.ts";
import { MANAGED_AGENTS_ROUTES } from "../../src/managed-agents/routes.ts";
import { newIdempotencyKey } from "../../src/transport/idempotency.ts";
import { NON_RETRYABLE_CODES } from "../../src/transport/retry.ts";

const ROUTER = resolve(
	import.meta.dir,
	"../../../api/src/routers/managed-agents.ts"
);

/** `/sessions/${sessionId}/events` and `/sessions/{id}/events` compare equal. */
function shape(path: string): string {
	return path.replaceAll(/\$\{[^}]+\}|\{[^}]+\}/g, "{}");
}

function idempotencyCallSites(): string[] {
	const source = readFileSync(ROUTER, "utf8");
	const sites: string[] = [];
	for (const match of source.matchAll(
		/idempotencyOf\(\s*c,\s*["`](POST|PATCH|PUT|DELETE) ([^"`]+)["`]/g
	)) {
		sites.push(`${match[1]} ${shape(match[2] ?? "")}`);
	}
	return sites;
}

describe("Managed Agents conformance", () => {
	test("codes.ts equals the keys of MANAGED_AGENTS_ERROR_STATUS", () => {
		expect<string[]>([...MANAGED_AGENTS_ERROR_CODES]).toEqual(
			Object.keys(MANAGED_AGENTS_ERROR_STATUS)
		);
	});

	test("the route table equals the router's idempotencyOf call sites", () => {
		const sites = idempotencyCallSites();
		expect(sites).toHaveLength(7);
		expect(new Set(sites)).toEqual(
			new Set(
				MANAGED_AGENTS_ROUTES.idempotent.map(
					(route) => `${route.method} ${shape(route.path)}`
				)
			)
		);
		expect(
			MANAGED_AGENTS_ROUTES.idempotent.every((route) => !route.required)
		).toBe(true);
	});

	test("every idempotent route is a protocol route under the same mount", () => {
		expect(MANAGED_AGENTS_ROUTES.mount).toBe(MANAGED_AGENTS_BASE_PATH);
		const protocol = new Set(
			PROTOCOL_ROUTES.map((route) => `${route.method} ${shape(route.path)}`)
		);
		for (const route of MANAGED_AGENTS_ROUTES.idempotent) {
			expect(protocol.has(`${route.method} ${shape(route.path)}`)).toBe(true);
		}
	});

	test("SDK keys satisfy the server's Idempotency-Key grammar", () => {
		for (let index = 0; index < 20; index += 1) {
			expect(isManagedAgentsIdempotencyKey(newIdempotencyKey())).toBe(true);
		}
	});

	test("preview hints cover the two preview-off codes at their server statuses", () => {
		expect(Object.keys(MANAGED_AGENTS_PREVIEW_HINTS).sort()).toEqual([
			"feature_disabled",
			"managed_agents_disabled",
		]);
		expect(MANAGED_AGENTS_ERROR_STATUS.managed_agents_disabled).toBe(503);
		expect(MANAGED_AGENTS_ERROR_STATUS.feature_disabled).toBe(403);
		expect(AVAILABILITY_CODES.has("managed_agents_disabled")).toBe(true);
	});

	test("codes a retry cannot fix are never retried", () => {
		for (const code of [
			"managed_agents_disabled",
			"feature_disabled",
			"insufficient_credits",
			"stream_limit_reached",
		]) {
			expect(NON_RETRYABLE_CODES.has(code)).toBe(true);
		}
	});
});
