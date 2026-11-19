/**
 * The Sites client's settings updates and refusals, and the `SitesStatus`
 * shape against the keys the Sites sidecar's `GET /status` returns.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	RyuConflictError,
	RyuInvalidRequestError,
	RyuNotFoundError,
	RyuUnavailableError,
} from "../errors.ts";
import type { SitesSettingsPatch, SitesStatus } from "./client.ts";
import {
	SITES_PUBLIC_DISABLED_HINT,
	SITES_STORED_PUBLIC_HINT,
} from "./helpers.ts";

import {
	client,
	failure,
	KEY,
	SETTINGS,
	SITE_ID,
	site,
	sitesError,
	sitesServer,
} from "./sites-test-fixtures.ts";

describe("ryu.sites.projects.updateSettings", () => {
	test("reads the Site, then PUTs every setting with only the patch changed", async () => {
		const { calls, ryu } = client(sitesServer({ revision: 2 }));
		const updated = await ryu.sites.projects.updateSettings(SITE_ID, {
			audience: "invited",
			viewers: ["ada@example.com"],
			allowRemix: undefined,
		});
		expect(
			calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)
		).toEqual([
			`GET /api/sites/projects/${SITE_ID}`,
			`PUT /api/sites/projects/${SITE_ID}/settings`,
		]);
		expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({
			expectedRevision: 2,
			settings: {
				...SETTINGS,
				audience: "invited",
				viewers: ["ada@example.com"],
			},
		});
		expect(calls[1]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
		expect(calls[1]?.headers.get("idempotency-key")).toBeNull();
		expect(updated.revision).toBe(3);
		expect(updated.settings.audience).toBe("invited");
	});

	test("a pinned stale expectedRevision is sent as given and fails with 409", async () => {
		const { calls, ryu } = client(sitesServer({ revision: 5 }));
		const error = await failure(
			ryu.sites.projects.updateSettings(
				SITE_ID,
				{ allowRemix: true },
				{ expectedRevision: 4 }
			)
		);
		expect(error).toBeInstanceOf(RyuConflictError);
		expect(error.details).toMatchObject({
			step: "settings",
			expectedRevision: 4,
			projectId: SITE_ID,
		});
		expect(calls.map((call) => call.method)).toEqual(["GET", "PUT"]);
	});

	test("a missing Site fails at the read step without a write", async () => {
		const { calls, ryu } = client(() =>
			sitesError(404, "not_found", "Site not found")
		);
		const error = await failure(
			ryu.sites.projects.updateSettings(SITE_ID, { audience: "private" })
		);
		expect(error).toBeInstanceOf(RyuNotFoundError);
		expect(error.details).toMatchObject({ step: "read", projectId: SITE_ID });
		expect(calls).toHaveLength(1);
	});

	test("refuses an empty patch and the separately managed settings before any request", async () => {
		const { calls, ryu } = client(sitesServer());
		for (const patch of [
			{},
			{ audience: undefined },
			{ database: null },
			{ extensions: {} },
		]) {
			const error = await failure(
				ryu.sites.projects.updateSettings(
					SITE_ID,
					patch as Parameters<typeof ryu.sites.projects.updateSettings>[1]
				)
			);
			expect(error).toBeInstanceOf(RyuInvalidRequestError);
			expect(error.code).toBe("invalid_request");
		}
		expect(calls).toHaveLength(0);
	});
});

describe("ryu.sites.projects.updateSettings: refusals", () => {
	test("the patch type checks the named settings", () => {
		const valid: SitesSettingsPatch = {
			audience: "public",
			aiDailyLimit: 10,
			workspaceId: null,
		};
		// @ts-expect-error: not an audience.
		const typo: SitesSettingsPatch = { audience: "publik" };
		// @ts-expect-error: aiDailyLimit is a number.
		const wrongType: SitesSettingsPatch = { aiDailyLimit: "x" };
		// @ts-expect-error: not a setting.
		const unknown: SitesSettingsPatch = { bogus: 1 };
		// @ts-expect-error: managed by its own routes.
		const managed: SitesSettingsPatch = { database: null };
		expect([valid, typo, wrongType, unknown, managed]).toHaveLength(5);
	});

	test("refuses null on a setting that cannot be cleared, before any request", async () => {
		const { calls, ryu } = client(sitesServer());
		const error = await failure(
			ryu.sites.projects.updateSettings(SITE_ID, {
				audience: null,
			} as unknown as SitesSettingsPatch)
		);
		expect(error).toBeInstanceOf(RyuInvalidRequestError);
		expect(error.details).toEqual({ fields: ["audience"] });
		expect(calls).toHaveLength(0);
	});

	test("null clears workspaceId", async () => {
		const { calls, ryu } = client(sitesServer({ revision: 1 }));
		await ryu.sites.projects.updateSettings(SITE_ID, { workspaceId: null });
		expect(JSON.parse(calls[1]?.body ?? "{}").settings.workspaceId).toBeNull();
	});

	test("a 503 unavailable configuration refusal is sent once and is not retryable", async () => {
		const { calls, ryu } = client((request) =>
			request.method === "GET"
				? Response.json(site(3))
				: sitesError(
						503,
						"unavailable",
						"Connect platform identity before enabling sharing or sign-in"
					)
		);
		const error = await failure(
			ryu.sites.projects.updateSettings(SITE_ID, { audience: "invited" })
		);
		expect(error).toBeInstanceOf(RyuUnavailableError);
		expect(error.retryable).toBe(false);
		expect(error.details).toMatchObject({ step: "settings" });
		expect(calls.map((call) => call.method)).toEqual(["GET", "PUT"]);
	});

	test("another 503 from the settings route is sent once, not replayed", async () => {
		let puts = 0;
		const { calls, ryu } = client((request) => {
			if (request.method === "GET") {
				return Response.json(site(3));
			}
			puts += 1;
			return puts === 1
				? Response.json(
						{ error: { code: "overloaded", message: "Try again" } },
						{ headers: { "retry-after": "0" }, status: 503 }
					)
				: Response.json(site(4));
		});
		// The PUT carries expectedRevision; a replay after a lost reply would
		// answer a spurious 409 although the first attempt applied.
		const error = await failure(
			ryu.sites.projects.updateSettings(SITE_ID, { allowRemix: true })
		);
		expect(error).toBeInstanceOf(RyuUnavailableError);
		expect(calls.map((call) => call.method)).toEqual(["GET", "PUT"]);
	});

	test("a 429 with a wait on the settings route is still retried", async () => {
		let puts = 0;
		const { calls, ryu } = client((request) => {
			if (request.method === "GET") {
				return Response.json(site(3));
			}
			puts += 1;
			return puts === 1
				? Response.json(
						{ error: { code: "rate_limited", message: "Slow down" } },
						{ headers: { "retry-after": "0" }, status: 429 }
					)
				: Response.json(site(4));
		});
		const updated = await ryu.sites.projects.updateSettings(SITE_ID, {
			allowRemix: true,
		});
		expect(updated.revision).toBe(4);
		expect(calls.map((call) => call.method)).toEqual(["GET", "PUT", "PUT"]);
	});

	test("a Site still saved as public explains the 403 when the change names no audience", async () => {
		const { ryu } = client(
			sitesServer({ settings: { ...SETTINGS, audience: "public" } })
		);
		const error = await failure(
			ryu.sites.projects.updateSettings(SITE_ID, { allowRemix: true })
		);
		expect(error.code).toBe("policy_denied");
		expect(error.hint).toBe(SITES_STORED_PUBLIC_HINT);
		expect(error.details).toMatchObject({ step: "settings" });
	});

	test("asking for public keeps the public-disabled hint", async () => {
		const { ryu } = client(
			sitesServer({ settings: { ...SETTINGS, audience: "public" } })
		);
		const error = await failure(
			ryu.sites.projects.updateSettings(SITE_ID, {
				audience: "public",
				allowRemix: true,
			})
		);
		expect(error.hint).toBe(SITES_PUBLIC_DISABLED_HINT);
	});
});

describe("ryu.sites.projects.makePublic", () => {
	test("sets the audience to public when the operator allows it", async () => {
		const { calls, ryu } = client(
			sitesServer({ publicEnabled: true, revision: 1 })
		);
		const updated = await ryu.sites.projects.makePublic(SITE_ID);
		expect(updated.settings.audience).toBe("public");
		expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({
			expectedRevision: 1,
			settings: { ...SETTINGS, audience: "public" },
		});
	});

	test("a 403 policy_denied names RYU_SITES_PUBLIC=1 and status().publicEnabled in its hint", async () => {
		const { ryu } = client(sitesServer());
		const error = await failure(ryu.sites.projects.makePublic(SITE_ID));
		expect(error.status).toBe(403);
		expect(error.code).toBe("policy_denied");
		expect(error.details).toMatchObject({ step: "settings" });
		expect(error.hint).toContain("RYU_SITES_PUBLIC=1");
		expect(error.hint).toContain("publicEnabled");
	});

	test("another 403 keeps no public hint", async () => {
		const { ryu } = client(() =>
			sitesError(403, "forbidden", "Choose a workspace you belong to")
		);
		const error = await failure(
			ryu.sites.projects.updateSettings(SITE_ID, { workspaceId: "ws_9" })
		);
		expect(error.hint ?? "").not.toContain("RYU_SITES_PUBLIC");
	});
});

describe("SitesStatus", () => {
	const SIDECAR = join(
		import.meta.dir,
		"../../../../apps-store/sites/sidecar/src/admin-top-routes.ts"
	);

	/** The keys `GET /status` returns, read from the sidecar's route source. */
	function routeKeys(source: string): Set<string> {
		const start = source.indexOf("function status(");
		const body = source.slice(start, source.indexOf("});", start));
		return new Set(
			[...body.matchAll(/^\s*([A-Za-z]+)(?::|,)/gmu)].map(
				(match) => match[1] ?? ""
			)
		);
	}

	/** The named members of the `SitesStatus` interface in client.ts. */
	function declaredKeys(source: string): Set<string> {
		const start = source.indexOf("export interface SitesStatus {");
		const body = source.slice(start, source.indexOf("\n}", start));
		return new Set(
			[...body.matchAll(/^\t([A-Za-z]+)\??:/gmu)].map((match) => match[1] ?? "")
		);
	}

	test.skipIf(!existsSync(SIDECAR))(
		"declares every key the Sites sidecar's GET /status returns",
		() => {
			const returned = routeKeys(readFileSync(SIDECAR, "utf8"));
			expect(returned.has("identityAvailable")).toBe(true);
			expect(returned.has("visitorPort")).toBe(true);
			const declared = declaredKeys(
				readFileSync(join(import.meta.dir, "client.ts"), "utf8")
			);
			expect([...declared].sort()).toEqual([...returned].sort());
		}
	);

	test("types the capability flags as optional booleans", () => {
		const status = {
			apiVersion: "1",
			baseDomain: "localhost",
			limits: {},
			mode: "standalone",
			publicEnabled: false,
			visitorPort: 8080,
			identityAvailable: true,
		} satisfies SitesStatus;
		const identity: boolean | undefined = status.identityAvailable;
		const read = (value: SitesStatus): boolean | undefined =>
			value.domainsAvailable;
		expect(identity).toBe(true);
		expect(read(status)).toBeUndefined();
	});
});
