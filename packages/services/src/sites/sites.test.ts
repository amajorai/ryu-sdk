import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	isRyuError,
	RyuAuthenticationError,
	RyuConfigurationError,
	RyuConflictError,
	type RyuError,
	RyuInvalidRequestError,
	RyuNotFoundError,
	RyuUnavailableError,
} from "../errors.ts";
import { Ryu } from "../ryu.ts";
import {
	type SitesSettingsPatch,
	type SitesStatus,
	siteUrl,
} from "./client.ts";
import {
	SITES_PUBLIC_DISABLED_HINT,
	SITES_STORED_PUBLIC_HINT,
} from "./helpers.ts";
import { SITES_ROUTES, SITES_SDK_ROUTES } from "./routes.ts";

interface Recorded {
	body: string | null;
	headers: Headers;
	method: string;
	url: string;
}

type Respond = (request: Recorded) => Response | Promise<Response>;

function stubFetch(respond: Respond) {
	const calls: Recorded[] = [];
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const body = init?.body;
		const recorded: Recorded = {
			body: typeof body === "string" ? body : null,
			headers: new Headers(init?.headers),
			method: init?.method ?? "GET",
			url: String(input),
		};
		calls.push(recorded);
		return await respond(recorded);
	};
	return { calls, fetch };
}

const BASE = "http://127.0.0.1:8021";
const KEY = "sites-management-token-0123456789abcdef";
const ENV = { RYU_SITES_API_KEY: KEY, RYU_SITES_URL: BASE };
const SITE_ID = "site_0123456789";
const NOW = "2026-10-21T12:00:00.000Z";
const HTML = "<!doctype html><title>Launch</title><h1>Launch</h1>";

function version(id: string) {
	return {
		bytes: HTML.length,
		commit: null,
		createdAt: NOW,
		extensions: { mcp: false },
		id,
		message: "first",
	};
}

/** Every setting, as the Sites satellite stores a new Site's (its `siteSettings` defaults). */
const SETTINGS = {
	mode: "local",
	audience: "private",
	workspaceId: null,
	viewers: [],
	editors: [],
	optionalSignIn: false,
	agentActions: false,
	ai: false,
	aiDailyLimit: 100,
	aiMode: "grounded",
	aiAnonymous: false,
	aiSystemPrompt: "Answer briefly.",
	storage: false,
	uploads: false,
	spaceId: null,
	database: { databaseId: "db_1", spaceId: "space_1" },
	sharedData: { enabled: false, write: "signed-in" },
	extensions: { connections: [], mcp: false },
	allowRemix: false,
};

function site(
	revision: number,
	versions: string[] = [],
	deploymentId: string | null = null,
	settings: Record<string, unknown> = SETTINGS
) {
	return {
		access: "owner",
		aliases: [],
		createdAt: NOW,
		deploymentId,
		domains: [],
		hasPublished: deploymentId !== null,
		id: SITE_ID,
		name: "Launch",
		ownerId: "node-owner",
		prompt: "",
		revision,
		schemaVersion: 1,
		settings,
		slug: "launch-notes",
		template: "website",
		updatedAt: NOW,
		versions: versions.map(version),
	};
}

const STATUS = {
	apiVersion: "v1",
	baseDomain: "localhost",
	limits: { projects: 30, versions: 100 },
	mode: "standalone",
	publicEnabled: false,
	visitorPort: 8022,
};

function sitesError(
	status: number,
	code: string,
	message: string,
	fields?: string[]
): Response {
	return Response.json(
		{ error: { code, message, ...(fields ? { fields } : {}) } },
		{ status }
	);
}

/** A tiny Sites management server holding one Site. */
function sitesServer(
	options: {
		publicEnabled?: boolean;
		revision?: number;
		settings?: Record<string, unknown>;
	} = {}
) {
	let current = site(options.revision ?? 0, [], null, options.settings);
	return (request: Recorded): Response => {
		const path = new URL(request.url).pathname;
		const route = `${request.method} ${path}`;
		const body = JSON.parse(request.body ?? "{}") as {
			expectedRevision?: number;
			settings?: Record<string, unknown>;
			versionId?: string;
		};
		if (route === "GET /api/sites/status") {
			return Response.json(STATUS);
		}
		if (route === `GET /api/sites/projects/${SITE_ID}`) {
			return Response.json(current);
		}
		if (
			(request.method === "POST" || request.method === "PUT") &&
			body.expectedRevision !== current.revision
		) {
			return sitesError(409, "conflict", "Site changed. Reload before saving.");
		}
		if (route === `POST /api/sites/projects/${SITE_ID}/versions`) {
			current = site(
				current.revision + 1,
				[...current.versions.map((item) => item.id), "ver_1"],
				current.deploymentId
			);
			return Response.json(current, { status: 201 });
		}
		if (route === `POST /api/sites/projects/${SITE_ID}/deploy`) {
			current = site(
				current.revision + 1,
				current.versions.map((item) => item.id),
				body.versionId ?? null
			);
			return Response.json(current);
		}
		if (route === `PUT /api/sites/projects/${SITE_ID}/settings`) {
			// The satellite refuses a changed database or extensions, and the
			// public audience unless the operator allowed it.
			const settings = body.settings ?? {};
			if (
				JSON.stringify(settings.database) !==
					JSON.stringify(current.settings.database) ||
				JSON.stringify(settings.extensions) !==
					JSON.stringify(current.settings.extensions)
			) {
				return sitesError(400, "invalid_input", "Managed separately");
			}
			if (settings.audience === "public" && options.publicEnabled !== true) {
				return sitesError(
					403,
					"policy_denied",
					"Public publishing is disabled by the operator"
				);
			}
			current = site(
				current.revision + 1,
				current.versions.map((item) => item.id),
				current.deploymentId,
				settings
			);
			return Response.json(current);
		}
		if (route === `POST /api/sites/projects/${SITE_ID}/unpublish`) {
			current = site(
				current.revision + 1,
				current.versions.map((item) => item.id),
				null
			);
			return Response.json(current);
		}
		return sitesError(404, "not_found", "Route not found");
	};
}

function client(respond: Respond, env: Record<string, string> = ENV) {
	const stub = stubFetch(respond);
	const ryu = new Ryu({ env, fetch: stub.fetch, maxRetryDelayMs: 50 });
	return { ...stub, ryu };
}

async function failure(promise: Promise<unknown>): Promise<RyuError> {
	try {
		await promise;
	} catch (error) {
		if (isRyuError(error)) {
			return error;
		}
		throw error;
	}
	throw new Error("expected the call to fail");
}

describe("Sites route table", () => {
	test("mounts the management contract and has no idempotent routes", () => {
		expect(SITES_ROUTES.mount).toBe("/api/sites");
		expect(SITES_ROUTES.idempotent).toEqual([]);
		for (const route of SITES_SDK_ROUTES) {
			expect(route.path.startsWith("/api/sites/")).toBe(true);
		}
	});
});

describe("siteUrl", () => {
	test("builds the visitor URL the way the Sites service does", () => {
		expect(siteUrl("launch-notes", STATUS)).toBe(
			"http://launch-notes.localhost:8022/"
		);
		expect(
			siteUrl("launch-notes", {
				baseDomain: "sites.example.com",
				visitorPort: 8022,
			})
		).toBe("https://launch-notes.sites.example.com/");
	});
});

describe("ryu.sites.deploy", () => {
	test("reads the revision, saves the HTML with expectedRevision, then deploys", async () => {
		const { calls, ryu } = client(sitesServer({ revision: 4 }));
		const result = await ryu.sites.deploy({
			projectId: SITE_ID,
			html: HTML,
			message: "first",
		});
		expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
			`GET ${BASE}/api/sites/projects/${SITE_ID}`,
			`GET ${BASE}/api/sites/status`,
			`POST ${BASE}/api/sites/projects/${SITE_ID}/versions`,
			`POST ${BASE}/api/sites/projects/${SITE_ID}/deploy`,
		]);
		expect(JSON.parse(calls[2]?.body ?? "{}")).toEqual({
			expectedRevision: 4,
			html: HTML,
			message: "first",
		});
		expect(JSON.parse(calls[3]?.body ?? "{}")).toEqual({
			expectedRevision: 5,
			versionId: "ver_1",
		});
		expect(result.version?.id).toBe("ver_1");
		expect(result.project.deploymentId).toBe("ver_1");
		expect(result.project.revision).toBe(6);
		expect(result.project.settings.audience).toBe("private");
		expect(result.url).toBe("http://launch-notes.localhost:8022/");
		for (const call of calls) {
			expect(call.headers.get("authorization")).toBe(`Bearer ${KEY}`);
			expect(call.headers.get("idempotency-key")).toBeNull();
		}
	});

	test("a pinned expectedRevision skips the read", async () => {
		const { calls, ryu } = client(sitesServer({ revision: 2 }));
		await ryu.sites.deploy({
			projectId: SITE_ID,
			html: HTML,
			expectedRevision: 2,
		});
		expect(calls.map((call) => call.method)).toEqual(["GET", "POST", "POST"]);
		expect(calls[0]?.url).toBe(`${BASE}/api/sites/status`);
	});

	test("deploys a saved version", async () => {
		const { calls, ryu } = client(sitesServer({ revision: 0 }));
		const saved = await ryu.sites.versions.create(SITE_ID, {
			html: HTML,
			expectedRevision: 0,
		});
		expect(saved.revision).toBe(1);
		const result = await ryu.sites.deploy({
			projectId: SITE_ID,
			versionId: "ver_1",
		});
		expect(result.version?.id).toBe("ver_1");
		expect(JSON.parse(calls.at(-1)?.body ?? "{}")).toEqual({
			expectedRevision: 1,
			versionId: "ver_1",
		});
	});

	test("a stale revision is RyuConflictError with details, and is not retried", async () => {
		const { calls, ryu } = client(sitesServer({ revision: 3 }));
		const error = await failure(
			ryu.sites.deploy({ projectId: SITE_ID, html: HTML, expectedRevision: 1 })
		);
		expect(error).toBeInstanceOf(RyuConflictError);
		expect(error.status).toBe(409);
		expect(error.code).toBe("conflict");
		expect(error.details).toEqual({
			expectedRevision: 1,
			projectId: SITE_ID,
			step: "version",
		});
		expect(error.attempts).toBe(1);
		expect(calls.filter((call) => call.url.endsWith("/versions"))).toHaveLength(
			1
		);
	});

	test("a blocked deploy names the saved version so it can be deployed later", async () => {
		const server = sitesServer({ revision: 0 });
		const { ryu } = client((request) =>
			request.url.endsWith("/deploy")
				? sitesError(
						422,
						"security_blocked",
						"A potential secret was detected."
					)
				: server(request)
		);
		const error = await failure(
			ryu.sites.deploy({ projectId: SITE_ID, html: HTML })
		);
		expect(error).toBeInstanceOf(RyuInvalidRequestError);
		expect(error.code).toBe("security_blocked");
		expect(error.details).toEqual({
			expectedRevision: 1,
			projectId: SITE_ID,
			step: "deploy",
			versionId: "ver_1",
		});
	});

	test("object mode returns the last response's meta", async () => {
		const stub = stubFetch(sitesServer());
		const ryu = new Ryu({ env: ENV, fetch: stub.fetch, result: "object" });
		const { data, error, meta } = await ryu.sites.deploy({
			projectId: SITE_ID,
			html: HTML,
		});
		expect(error).toBeNull();
		expect(data?.url).toBe("http://launch-notes.localhost:8022/");
		expect(meta?.status).toBe(200);
		expect(meta?.attempts).toBe(1);
	});
});

describe("ryu.sites", () => {
	test("a Site's domains, connections, remix source and version tools are typed and decoded", async () => {
		const remixed = {
			...site(1),
			connections: [
				{
					agentId: "ryu",
					description: "",
					id: "crm",
					label: "CRM",
					readOnly: true,
					revision: 2,
					toolId: "crm.lookup",
					updatedAt: NOW,
					updatedBy: "node-owner",
				},
			],
			domains: [
				{
					checkedAt: null,
					host: "launch.example.com",
					status: "pending_dns",
					verification: "ryu-site-verify=abc",
				},
			],
			remixedFrom: { name: "Template", siteId: "site_src", versionId: "v_1" },
			versions: [
				{
					...version("ver_1"),
					extensions: {
						connections: ["crm"],
						mcp: true,
						tools: [
							{
								collection: "notes",
								description: "Lists notes.",
								name: "list_notes",
								operation: "records.list",
							},
						],
						ui: false,
					},
				},
			],
		};
		const { ryu } = client(() => Response.json(remixed));
		const project = await ryu.sites.projects.get(SITE_ID);
		expect(project.schemaVersion).toBe(1);
		expect(project.domains[0]?.status).toBe("pending_dns");
		expect(project.connections?.[0]?.toolId).toBe("crm.lookup");
		expect(project.remixedFrom?.siteId).toBe("site_src");
		expect(project.versions[0]?.extensions?.tools?.[0]?.name).toBe(
			"list_notes"
		);
		// A domain binding without its host is refused, not passed through.
		const broken = { ...remixed, domains: [{ status: "active" }] };
		const refused = client(() => Response.json(broken));
		await expect(refused.ryu.sites.projects.get(SITE_ID)).rejects.toMatchObject(
			{ code: "invalid_response" }
		);
	});

	test("status, list, get, create and delete use the management routes", async () => {
		const { calls, ryu } = client((request) => {
			const path = new URL(request.url).pathname;
			if (path === "/api/sites/status") {
				return Response.json(STATUS);
			}
			if (request.method === "DELETE") {
				return Response.json({ deleted: true });
			}
			if (path === "/api/sites/projects") {
				return request.method === "POST"
					? Response.json(site(0), { status: 201 })
					: Response.json([site(0)]);
			}
			return Response.json(site(0));
		});
		expect((await ryu.sites.status()).visitorPort).toBe(8022);
		expect(await ryu.sites.projects.list({ scope: "shared" })).toHaveLength(1);
		expect((await ryu.sites.projects.get(SITE_ID)).slug).toBe("launch-notes");
		const created = await ryu.sites.projects.create({
			name: "Launch",
			slug: "launch-notes",
		});
		expect(created.revision).toBe(0);
		expect(
			await ryu.sites.projects.delete(SITE_ID, {
				expectedRevision: 0,
				slug: "launch-notes",
			})
		).toEqual({ deleted: true });
		expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
			`GET ${BASE}/api/sites/status`,
			`GET ${BASE}/api/sites/projects?scope=shared`,
			`GET ${BASE}/api/sites/projects/${SITE_ID}`,
			`POST ${BASE}/api/sites/projects`,
			`DELETE ${BASE}/api/sites/projects/${SITE_ID}`,
		]);
		expect(JSON.parse(calls[3]?.body ?? "{}")).toEqual({
			name: "Launch",
			slug: "launch-notes",
		});
		expect(JSON.parse(calls[4]?.body ?? "{}")).toEqual({
			expectedRevision: 0,
			slug: "launch-notes",
		});
	});

	test("unpublish reads the revision when it is not given", async () => {
		const { calls, ryu } = client(sitesServer({ revision: 7 }));
		const project = await ryu.sites.unpublish(SITE_ID);
		expect(project.deploymentId).toBeNull();
		expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
		expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({ expectedRevision: 7 });
		const pinned = client(sitesServer({ revision: 7 }));
		await pinned.ryu.sites.unpublish(SITE_ID, { expectedRevision: 7 });
		expect(pinned.calls).toHaveLength(1);
	});

	test("{error:{code,message,fields}} maps to details.fields", async () => {
		const { ryu } = client(() =>
			sitesError(400, "invalid_input", "Check the submitted fields", [
				"slug",
				"name",
			])
		);
		const error = await failure(
			ryu.sites.projects.create({ name: "", slug: "x" })
		);
		expect(error).toBeInstanceOf(RyuInvalidRequestError);
		expect(error.code).toBe("invalid_input");
		expect(error.message).toBe("Check the submitted fields");
		expect(error.details).toEqual({ fields: ["slug", "name"] });
		expect(error.envelope).toBe("nested-error");
	});

	test("a 409 on a direct write is not retried", async () => {
		const { calls, ryu } = client(() =>
			sitesError(409, "conflict", "Site changed. Reload before saving.")
		);
		const error = await failure(
			ryu.sites.versions.create(SITE_ID, { html: HTML, expectedRevision: 0 })
		);
		expect(error).toBeInstanceOf(RyuConflictError);
		expect(calls).toHaveLength(1);
	});

	test("401 and 404 map to typed errors", async () => {
		const denied = client(() =>
			sitesError(401, "unauthorized", "Sign in to manage Sites")
		);
		const unauthorized = await failure(denied.ryu.sites.projects.list());
		expect(unauthorized).toBeInstanceOf(RyuAuthenticationError);
		expect(unauthorized.code).toBe("unauthorized");
		const missing = client(() =>
			sitesError(404, "not_found", "Site not found")
		);
		const notFound = await failure(missing.ryu.sites.projects.get("site_x"));
		expect(notFound).toBeInstanceOf(RyuNotFoundError);
	});

	test("a dot-segment project id is refused before any request", async () => {
		const { calls, ryu } = client(sitesServer());
		const error = await failure(ryu.sites.projects.get(".."));
		expect(error).toBeInstanceOf(RyuInvalidRequestError);
		expect(error.code).toBe("invalid_id");
		expect(calls).toHaveLength(0);
	});

	test("a missing RYU_SITES_URL is a configuration error naming it", async () => {
		const { calls, ryu } = client(sitesServer(), { RYU_SITES_API_KEY: KEY });
		const error = await failure(ryu.sites.status());
		expect(error).toBeInstanceOf(RyuConfigurationError);
		expect(error.details).toEqual({ missing: ["RYU_SITES_URL"] });
		expect(calls).toHaveLength(0);
	});
});

describe("ryu.sites.deploy after the deploy committed", () => {
	/** Wraps the test server so the deploy reply leaves the deployed version out of `versions`. */
	function withoutDeployedVersion(revision: number) {
		const server = sitesServer({ revision });
		return async (request: Recorded): Promise<Response> => {
			const response = server(request);
			if (!new URL(request.url).pathname.endsWith("/deploy")) {
				return response;
			}
			const project = (await response.json()) as Record<string, unknown>;
			return Response.json({ ...project, versions: [] });
		};
	}

	test("falls back to the saved version instead of throwing", async () => {
		const { calls, ryu } = client(withoutDeployedVersion(0));
		const result = await ryu.sites.deploy({ projectId: SITE_ID, html: HTML });
		expect(result.project.deploymentId).toBe("ver_1");
		expect(result.version?.id).toBe("ver_1");
		expect(calls.at(-1)?.url).toBe(
			`${BASE}/api/sites/projects/${SITE_ID}/deploy`
		);
	});

	test("returns version null for a saved version the reply leaves out", async () => {
		const { ryu } = client(withoutDeployedVersion(0));
		const result = await ryu.sites.deploy({
			projectId: SITE_ID,
			versionId: "ver_9",
			expectedRevision: 0,
		});
		expect(result.project.deploymentId).toBe("ver_9");
		expect(result.version).toBeNull();
	});
});

describe("ryu.sites.projects.delete retries", () => {
	/**
	 * Mirrors the Sites DELETE handler: it bumps the revision before removing
	 * the Site's Spaces database, so a database failure (503) leaves a newer
	 * revision behind and a replay with the old one is refused with 409.
	 */
	function partialDelete() {
		let revision = 3;
		return (request: Recorded): Response => {
			const body = JSON.parse(request.body ?? "{}") as {
				expectedRevision?: number;
			};
			if (body.expectedRevision !== revision) {
				return sitesError(
					409,
					"conflict",
					"Site changed. Reload before saving."
				);
			}
			revision += 1;
			return Response.json(
				{
					error: {
						code: "platform_unavailable",
						message: "Ryu Spaces is unavailable",
					},
				},
				{ status: 503, headers: { "retry-after": "0" } }
			);
		};
	}

	test("a 5xx after the revision moved is sent once and reports the first failure", async () => {
		const { calls, ryu } = client(partialDelete());
		const error = await failure(
			ryu.sites.projects.delete(SITE_ID, {
				expectedRevision: 3,
				slug: "launch-notes",
			})
		);
		// A replay would resend the stale expectedRevision and answer a spurious 409.
		expect(error).toBeInstanceOf(RyuUnavailableError);
		expect(error.code).toBe("platform_unavailable");
		expect(calls.map((call) => call.method)).toEqual(["DELETE"]);
	});

	test("a lost reply after the write applied is not replayed into a spurious 409", async () => {
		const stub = stubFetch(() => {
			throw new TypeError("fetch failed");
		});
		const ryu = new Ryu({ env: ENV, fetch: stub.fetch });
		await failure(
			ryu.sites.projects.delete(SITE_ID, {
				expectedRevision: 3,
				slug: "launch-notes",
			})
		);
		expect(stub.calls).toHaveLength(1);
	});

	test("maxRetries: 0 reports the first failure", async () => {
		const stub = stubFetch(partialDelete());
		const ryu = new Ryu({ env: ENV, fetch: stub.fetch, maxRetries: 0 });
		const error = await failure(
			ryu.sites.projects.delete(SITE_ID, {
				expectedRevision: 3,
				slug: "launch-notes",
			})
		);
		expect(error).toBeInstanceOf(RyuUnavailableError);
		expect(error.code).toBe("platform_unavailable");
		expect(stub.calls).toHaveLength(1);
	});
});

describe("a RYU_SITES_URL on the visitor listener", () => {
	const visitorEnv = {
		RYU_SITES_API_KEY: "s",
		RYU_SITES_URL: "http://127.0.0.1:8022",
	};

	test("gets a hint naming the management port", async () => {
		const { ryu } = client(
			() => sitesError(404, "not_found", "Site is not deployed"),
			visitorEnv
		);
		for (const call of [
			ryu.sites.status(),
			ryu.sites.projects.create({ name: "Launch", slug: "launch-site" }),
		]) {
			const error = await failure(call);
			expect(error).toBeInstanceOf(RyuNotFoundError);
			expect(error.message).toBe(`Site is not deployed. Hint: ${error.hint}`);
			expect(error.hint).toContain("visitor listener");
			expect(error.hint).toContain("RYU_SITES_PORT, 8021 by default");
		}
	});

	test("a management 404 keeps its own message and no visitor hint", async () => {
		const { ryu } = client(() =>
			sitesError(404, "not_found", "Project not found")
		);
		const error = await failure(ryu.sites.projects.get("site_9"));
		expect(error).toBeInstanceOf(RyuNotFoundError);
		expect(error.hint ?? "").not.toContain("visitor listener");
	});
});

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
		"../../../../apps-store/sites/sidecar/src/server.ts"
	);

	/** The keys `GET /status` returns, read from the sidecar's route source. */
	function routeKeys(source: string): Set<string> {
		const start = source.indexOf(
			'if (path === "/status" && request.method === "GET")'
		);
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
