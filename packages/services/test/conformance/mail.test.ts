// Server conformance for the Mail slice. The hosted router
// (packages/api/src/routers/mail.ts and its routers/mail/ modules) and the self-hosted server
// (apps-store/mail/backend/src/api.rs) are read as text, in this test only:
// importing the router would pull in the whole API runtime, and the
// satellite's Rust source cannot be imported at all. The published SDK never
// depends on either.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MAIL_MESSAGE_CODES } from "../../src/mail/helpers.ts";
import { MAIL_ROUTES } from "../../src/mail/routes.ts";
import {
	isRetryableFailure,
	NON_RETRYABLE_CODES,
} from "../../src/transport/retry.ts";

/** Hosted Mail router sources: the facade, mail/router.ts, the other helper modules, then the route modules in registration order. */
function hostedMailRouterFiles(
	routersDir: string
): { name: string; text: string }[] {
	const facade = readFileSync(join(routersDir, "mail.ts"), "utf8");
	const routeModules = [
		...facade.matchAll(/^import "\.\/mail\/([\w-]+\.ts)";$/gm),
	].map((match) => match[1] ?? "");
	const helpers = readdirSync(join(routersDir, "mail"))
		.filter(
			(name) =>
				name.endsWith(".ts") &&
				!name.endsWith(".test.ts") &&
				!routeModules.includes(name)
		)
		.sort((a, b) => {
			if (a === "router.ts") {
				return -1;
			}
			if (b === "router.ts") {
				return 1;
			}
			return a.localeCompare(b);
		});
	return [
		{ name: join(routersDir, "mail.ts"), text: facade },
		...[...helpers, ...routeModules].map((name) => ({
			name: join(routersDir, "mail", name),
			text: readFileSync(join(routersDir, "mail", name), "utf8"),
		})),
	];
}

/** The hosted Mail router sources concatenated in `hostedMailRouterFiles` order. */
function hostedMailRouterSource(routersDir: string): string {
	return hostedMailRouterFiles(routersDir)
		.map((file) => file.text)
		.join("\n");
}

const HOSTED = hostedMailRouterSource(
	resolve(import.meta.dir, "../../../api/src/routers")
);
const SELF_HOSTED = readFileSync(
	resolve(import.meta.dir, "../../../../apps-store/mail/backend/src/api.rs"),
	"utf8"
);

/**
 * Rows of the route table the self-hosted server does not serve: held-draft
 * approval and the agent routes exist on hosted Mail only.
 */
const HOSTED_ONLY_ROUTES: ReadonlySet<string> = new Set([
	"/drafts/{id}/approve",
	"/agents/{agentId}/send",
	"/agents/{agentId}/messages/{messageId}/reply",
]);

/** `/inboxes/{id}/send` -> `/inboxes/:id/send` (Hono and axum spelling). */
function colonPath(path: string): string {
	return path.replaceAll(/\{([^}]+)\}/g, ":$1");
}

/** `/inboxes/:id/x` and `/inboxes/:inbox/x` compare equal. */
function shape(path: string): string {
	return path.replaceAll(/:[A-Za-z_]+/g, ":_");
}

/** The source of the hosted handler registered as `mailRouter.<method>("<path>", ...)`, or null. */
function hostedHandler(method: string, path: string): string | null {
	const registration =
		/\nmailRouter\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g;
	for (const match of HOSTED.matchAll(registration)) {
		if (
			match[1] === method.toLowerCase() &&
			shape(match[2] ?? "") === shape(path)
		) {
			const start = match.index ?? 0;
			const next = HOSTED.indexOf("\nmailRouter.", start + 1);
			return HOSTED.slice(start, next === -1 ? undefined : next);
		}
	}
	return null;
}

/** The name of the enclosing hosted function or route for each `idempotency-key` header read. */
function hostedHeaderReaders(): string[] {
	const lines = HOSTED.split("\n");
	const readers: string[] = [];
	let enclosing = "";
	for (const line of lines) {
		const fn = /^(?:export )?(?:async )?function (\w+)/.exec(line);
		const route = /^mailRouter\.(\w+)\(\s*"([^"]+)"/.exec(line);
		if (fn) {
			enclosing = fn[1] ?? "";
		} else if (route) {
			enclosing = `${(route[1] ?? "").toUpperCase()} ${route[2] ?? ""}`;
		}
		if (/req\.header\("idempotency-key"\)/.test(line)) {
			readers.push(enclosing);
		}
	}
	return [...new Set(readers)].sort();
}

/** The axum handler function name bound to `POST <path>` in api.rs, or null. */
function selfHostedPostHandler(path: string): string | null {
	const target = shape(`/api/mail${colonPath(path)}`);
	for (const match of SELF_HOSTED.matchAll(
		/\.route\(\s*"([^"]+)",\s*([^)]*\)[^)]*?)\)/g
	)) {
		if (shape(match[1] ?? "") !== target) {
			continue;
		}
		const post = /\bpost\((\w+)\)/.exec(match[2] ?? "");
		if (post) {
			return post[1] ?? null;
		}
	}
	return null;
}

/** The body of `async fn <name>(` in api.rs, up to the next top-level item. */
function selfHostedFunction(name: string): string {
	const start = SELF_HOSTED.indexOf(`\nasync fn ${name}(`);
	if (start === -1) {
		throw new Error(`api.rs has no async fn ${name}`);
	}
	const rest = SELF_HOSTED.slice(start + 1);
	const end = rest.search(/\n(?:async fn |fn |#\[|pub )/);
	return end === -1 ? rest : rest.slice(0, end);
}

describe("Mail route table vs hosted Mail", () => {
	test("every idempotent route is a POST route on mailRouter", () => {
		for (const route of MAIL_ROUTES.idempotent) {
			expect(
				hostedHandler(route.method, colonPath(route.path)),
				`${route.method} ${route.path}`
			).not.toBeNull();
		}
	});

	test("only sendHostedPayload claims the send ledger with Idempotency-Key", () => {
		// `POST /inboxes/:id/send` reaches the ledger through sendHostedPayload too.
		// `claimAgentAlias` only reads the header to reject an empty key; an alias
		// claim is not deduplicated by it.
		expect(hostedHeaderReaders()).toEqual([
			"claimAgentAlias",
			"sendHostedPayload",
		]);
	});

	test("reply, reply-all, forward and draft send claim the key through sendHostedPayload", () => {
		for (const route of MAIL_ROUTES.idempotent) {
			const handler = hostedHandler(route.method, colonPath(route.path)) ?? "";
			const claimsKey =
				handler.includes("sendHostedPayload(") ||
				handler.includes('req.header("idempotency-key")');
			expect(claimsKey, route.path).toBe(true);
		}
	});

	test("no route outside the table claims a send key", () => {
		const callers = new Set<string>();
		for (const match of HOSTED.matchAll(
			/\nmailRouter\.post\(\s*"([^"]+)"[\s\S]*?(?=\nmailRouter\.|$)/g
		)) {
			if ((match[0] ?? "").includes("sendHostedPayload(")) {
				callers.add(shape(match[1] ?? ""));
			}
		}
		const table = new Set(
			MAIL_ROUTES.idempotent.map((route) => shape(colonPath(route.path)))
		);
		expect([...callers].filter((path) => !table.has(path))).toEqual([]);
	});
});

describe("Mail route table vs self-hosted Mail", () => {
	test("the hosted-only rows are absent from api.rs", () => {
		for (const path of HOSTED_ONLY_ROUTES) {
			expect(MAIL_ROUTES.idempotent.some((route) => route.path === path)).toBe(
				true
			);
			expect(selfHostedPostHandler(path), path).toBeNull();
		}
	});

	test("every idempotent route is a POST route in api.rs and reaches send_message with its headers", () => {
		for (const route of MAIL_ROUTES.idempotent) {
			if (HOSTED_ONLY_ROUTES.has(route.path)) {
				continue;
			}
			const handler = selfHostedPostHandler(route.path);
			expect(handler, route.path).not.toBeNull();
			const body = selfHostedFunction(handler ?? "");
			const claimsKey =
				handler === "send_message"
					? body.includes('.get("idempotency-key")')
					: /send_message\(\s*State\([\s\S]*?\),\s*Path\([\s\S]*?\),\s*headers,/.test(
							body
						);
			expect(claimsKey, `${route.path} (${handler})`).toBe(true);
		}
	});
});

describe("Mail error prose lockstep", () => {
	test("every message the SDK names appears verbatim in a server source", () => {
		for (const entry of MAIL_MESSAGE_CODES) {
			const quotedTs = `"${entry.message}"`;
			const inHosted =
				HOSTED.includes(quotedTs) || HOSTED.includes(`\t"${entry.message}"`);
			const inSelfHosted = SELF_HOSTED.includes(`"${entry.message}"`);
			expect(inHosted || inSelfHosted, entry.message).toBe(true);
		}
	});

	test("the hosted send-key messages are all covered", () => {
		for (const name of [
			"SEND_KEY_IN_PROGRESS",
			"SEND_KEY_UNRESOLVED",
			"SEND_KEY_REUSED",
			"SEND_OUTCOME_UNKNOWN",
			"DRAFT_SEND_UNRESOLVED",
		]) {
			const match = new RegExp(`const ${name} =\\s*"([^"]+)"`).exec(HOSTED);
			expect(match, name).not.toBeNull();
			const text = match?.[1] ?? "";
			expect(
				MAIL_MESSAGE_CODES.some((entry) => entry.message === text),
				name
			).toBe(true);
		}
	});

	test("the hosted send-key messages are raised with the status the SDK expects", () => {
		const raised: [string, number, RegExp][] = [
			[
				"SEND_KEY_IN_PROGRESS",
				409,
				/HTTPException\(409, \{ message: SEND_KEY_IN_PROGRESS \}\)/,
			],
			[
				"SEND_KEY_UNRESOLVED",
				409,
				/HTTPException\(409, \{ message: SEND_KEY_UNRESOLVED \}\)/,
			],
			[
				"SEND_KEY_REUSED",
				409,
				/HTTPException\(409, \{ message: SEND_KEY_REUSED \}\)/,
			],
			[
				"SEND_OUTCOME_UNKNOWN",
				502,
				/super\(502, \{ message: SEND_OUTCOME_UNKNOWN/,
			],
			[
				"DRAFT_SEND_UNRESOLVED",
				409,
				/HTTPException\(409, \{ message: DRAFT_SEND_UNRESOLVED \}\)/,
			],
		];
		for (const [name, status, raise] of raised) {
			expect(raise.test(HOSTED), name).toBe(true);
			const text =
				new RegExp(`const ${name} =\\s*"([^"]+)"`).exec(HOSTED)?.[1] ?? "";
			expect(
				MAIL_MESSAGE_CODES.some(
					(entry) => entry.message === text && entry.status === status
				),
				`${name} ${status}`
			).toBe(true);
		}
	});

	test("every self-hosted message carries the status the SDK expects", () => {
		const statuses: Record<string, number> = {
			CONFLICT: 409,
			INTERNAL_SERVER_ERROR: 500,
		};
		const selfHosted = MAIL_MESSAGE_CODES.filter((entry) =>
			SELF_HOSTED.includes(`"${entry.message}"`)
		);
		expect(selfHosted.length).toBeGreaterThan(0);
		for (const entry of selfHosted) {
			const seen = new Set<number>();
			for (const match of SELF_HOSTED.matchAll(
				/err\(\s*StatusCode::(\w+),\s*"([^"]+)"/g
			)) {
				if (match[2] === entry.message) {
					seen.add(statuses[match[1] ?? ""] ?? 0);
				}
			}
			expect([...seen], entry.message).toEqual([entry.status]);
		}
	});

	test("only idempotency_in_progress is retryable once named; outcome_unknown never is", () => {
		for (const entry of MAIL_MESSAGE_CODES) {
			expect(
				isRetryableFailure(entry.status, entry.code),
				`${entry.status} ${entry.code}`
			).toBe(entry.code === "idempotency_in_progress");
		}
		expect(NON_RETRYABLE_CODES.has("outcome_unknown")).toBe(true);
	});
});
