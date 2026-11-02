import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MESSAGING_ROUTES } from "./routes.ts";

// The SDK's route tables and error envelope in lockstep with #777's server:
// the Messaging router's source (packages/api/src/routers/messaging*.ts) and
// its error renderer (packages/api/src/lib/messaging-auth.ts).

const ROUTER = resolve(
	import.meta.dir,
	"../../../api/src/routers/messaging.ts"
);
const AUTH = resolve(import.meta.dir, "../../../api/src/lib/messaging-auth.ts");

/**
 * The modules that register routes onto `messagingRouter`: routers/messaging.ts
 * and each module it imports for that side effect (`import "./messaging-*.ts"`).
 * The same rule as apps/web's OpenAPI test and apps/fumadocs' docs test, so
 * all three read the same route table.
 */
function routerSource(): string {
	const dir = resolve(ROUTER, "..");
	const entry = readFileSync(ROUTER, "utf8");
	const modules = [
		...entry.matchAll(/^import "\.\/(messaging-[a-z-]+\.ts)";$/gmu),
	].map((match) => match[1] ?? "");
	if (!modules.includes("messaging-router.ts")) {
		throw new Error(
			"routers/messaging.ts no longer imports messaging-router.ts"
		);
	}
	return [
		entry,
		...modules.map((name) => readFileSync(resolve(dir, name), "utf8")),
	].join("\n");
}

/** Every non-test source of the Messaging router (routes, pipeline, errors). */
function messagingSources(): string {
	const dir = resolve(ROUTER, "..");
	return readdirSync(dir)
		.filter((name) => /^messaging(?:-[a-z-]+)?\.ts$/u.test(name))
		.sort()
		.map((name) => readFileSync(resolve(dir, name), "utf8"))
		.join("\n");
}

/** Each `messagingRouter.<method>("<path>", ...)` registration and its handler source. */
function routerRegistrations(): {
	body: string;
	method: string;
	path: string;
}[] {
	const source = routerSource();
	const pattern = /messagingRouter\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g;
	const matches = [...source.matchAll(pattern)];
	return matches.map((match) => {
		const start = match.index ?? 0;
		// The registration call ends at the first `)` or `})` at column 0.
		const end = source.slice(start).search(/\n\}?\);/);
		return {
			method: (match[1] ?? "").toUpperCase(),
			path: (match[2] ?? "").replaceAll(/:([A-Za-z]+)/g, "{$1}"),
			body: source.slice(start, end === -1 ? source.length : start + end),
		};
	});
}

describe("lockstep with #777's server", () => {
	test("the route table equals the routes that require an Idempotency-Key", () => {
		const required = routerRegistrations()
			.filter(
				({ body }) =>
					body.includes("requireIdempotencyKey(c)") || body.includes("runSend(")
			)
			.map(({ method, path }) => `${method} ${path}`)
			.sort();
		const table = MESSAGING_ROUTES.idempotent
			.map((route) => `${route.method} ${route.path}`)
			.sort();
		expect(required).toEqual(table);
		expect(MESSAGING_ROUTES.idempotent.every((route) => route.required)).toBe(
			true
		);
		// The mount the table is relative to (`/api` + `/messaging`).
		expect(readFileSync(resolve(ROUTER, "../index.ts"), "utf8")).toContain(
			'mountRouter("/messaging", messagingRouter)'
		);
		expect(MESSAGING_ROUTES.mount).toBe("/api/messaging");
	});

	test("refusals are rendered as { ...details, error, message } with retry-after", () => {
		const source = readFileSync(AUTH, "utf8");
		expect(source).toContain(
			"{ ...error.details, error: error.code, message: error.message }"
		);
		expect(source).toContain(
			'headers.set("retry-after", String(error.retryAfterSeconds))'
		);
	});

	test("outcome_unknown and the send caps are the codes these tests assume", () => {
		const source = messagingSources();
		for (const code of [
			'"outcome_unknown"',
			'"provider_refused"',
			'"media_upload_failed"',
			'"send_rate_limited"',
			'"insufficient_credits"',
			"details: { limit: refusal.limit, window: refusal.window }",
		]) {
			expect({ code, found: source.includes(code) }).toEqual({
				code,
				found: true,
			});
		}
		expect(readFileSync(AUTH, "utf8")).toContain(
			'"Ryu Messaging is not available for this organization"'
		);
	});

	test("a refused or unstaged send releases the key's claim, so a retry is a new send", () => {
		// The send pipeline (routers/messaging-send.ts) fails with the tagged
		// errors messaging-errors.ts renders as `provider_refused` and
		// `media_upload_failed`; each must follow the claim's release.
		const source = messagingSources();
		const refused = source.indexOf("new MessagingSendRefused(");
		const staged = source.indexOf("new MessagingMediaUploadFailed(");
		expect(refused).toBeGreaterThan(0);
		expect(staged).toBeGreaterThan(0);
		for (const at of [refused, staged]) {
			const before = source.slice(Math.max(0, at - 400), at);
			expect(before).toContain("claim.release()");
		}
		const errors = readFileSync(
			resolve(ROUTER, "../messaging-errors.ts"),
			"utf8"
		);
		expect(errors).toMatch(
			/MessagingSendRefused: [\s\S]*?code: "provider_refused",\s*message: "AWS End User Messaging refused this send/u
		);
		expect(errors).toMatch(
			/MessagingMediaUploadFailed: [\s\S]*?code: "media_upload_failed"/u
		);
	});
});

describe("the router serves the SDK's non-replay-safe route", () => {
	test("the non-replay-safe list names the settings PUT the router serves", () => {
		expect(
			MESSAGING_ROUTES.nonReplaySafe?.map((r) => `${r.method} ${r.path}`)
		).toEqual(["PUT /orgs/{orgId}/settings"]);
		const router = routerSource();
		expect(router).toMatch(
			/messagingRouter\.put\(\s*"\/orgs\/:orgId\/settings"/u
		);
	});
});
