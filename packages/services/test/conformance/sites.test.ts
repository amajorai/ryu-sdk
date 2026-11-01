// Server conformance for the Sites slice. It runs the real standalone Sites
// management listener (`createSitesServer` from the Sites satellite's
// sidecar, on loopback port 0, with its SQLite store in a temporary RYU_DIR
// laid out by the sidecar runtime's helpers and a standalone bearer) and
// points the SDK at it. No Docker and no credentials.
//
// Satellite boundary (design D19): this is the only place the SDK touches
// apps-store/sites, and it is test-only. The satellite is loaded at runtime by
// computed relative path, so it is never re-exported, never a dependency of
// @ryuhq/services, and stays out of this package's type check. The recorded
// fixtures in test/fixtures/sites/*.json are the fallback for a future Sites
// that cannot run in-process: they are replayed through the SDK here, and
// checked against the live service's response shape so they cannot drift.

import { afterAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	isRyuError,
	RyuAuthenticationError,
	RyuConflictError,
	type RyuError,
	RyuInvalidRequestError,
} from "../../src/errors.ts";
import { Ryu } from "../../src/ryu.ts";
import {
	sitesProjectSchema,
	sitesStatusSchema,
} from "../../src/sites/client.ts";

const REPO = resolve(import.meta.dir, "../../../..");
const SITES_SRC = join(REPO, "apps-store/sites/sidecar/src");
const RUNTIME_SRC = join(REPO, "packages/sidecar-runtime/src/index.ts");
const FIXTURES = resolve(import.meta.dir, "../fixtures/sites");
const TOKEN = "sites-conformance-bearer-0123456789abcdef";
const HTML = "<!doctype html><title>Launch</title><h1>Launch notes</h1>";

interface RunningSites {
	baseUrl: string;
	stop(): void;
}

const cleanups: (() => void)[] = [];

afterAll(() => {
	for (const cleanup of cleanups.splice(0).reverse()) {
		cleanup();
	}
});

type Loaded = Record<string, unknown>;

const load = (path: string) => import(path) as Promise<Loaded>;

/** Starts the standalone Sites management listener with its data in a temporary RYU_DIR. */
async function startSites(): Promise<RunningSites> {
	const [server, store, scanner, runtime] = await Promise.all([
		load(join(SITES_SRC, "server.ts")),
		load(join(SITES_SRC, "store.ts")),
		load(join(SITES_SRC, "secret-scan.ts")),
		load(RUNTIME_SRC),
	]);
	const ryuDir = mkdtempSync(join(tmpdir(), "ryu-services-sites-"));
	cleanups.push(() => rmSync(ryuDir, { force: true, recursive: true }));
	const resolvePluginDataDir = runtime.resolvePluginDataDir as (
		env: Record<string, string>,
		pluginId: string
	) => string;
	const dataDir = resolvePluginDataDir({ RYU_DIR: ryuDir }, "@ryu/sites");
	if (!dataDir.startsWith(ryuDir)) {
		throw new Error(
			`the Sites data dir ${dataDir} is outside RYU_DIR ${ryuDir}`
		);
	}
	mkdirSync(dataDir, { recursive: true });
	const SitesStore = store.SitesStore as new (
		path: string
	) => { close(): void };
	const sitesStore = new SitesStore(join(dataDir, "sites.sqlite"));
	const createStandaloneScanner = scanner.createStandaloneScanner as (options: {
		gateway: null;
	}) => unknown;
	const createSitesServer = server.createSitesServer as (
		options: Record<string, unknown>
	) => { admin: { port: number }; stop(): void };
	const running = createSitesServer({
		mode: "standalone",
		port: 0,
		services: { scanArtifact: createStandaloneScanner({ gateway: null }) },
		store: sitesStore,
		token: TOKEN,
		visitorPort: 0,
	});
	const stop = () => {
		running.stop();
		sitesStore.close();
	};
	cleanups.push(stop);
	return { baseUrl: `http://127.0.0.1:${running.admin.port}`, stop };
}

async function rejection(promise: PromiseLike<unknown>): Promise<RyuError> {
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

describe("Sites conformance: live standalone service", () => {
	test("create, save and deploy, then a stale revision answers 409", async () => {
		const sites = await startSites();
		const ryu = new Ryu({
			env: { RYU_SITES_API_KEY: TOKEN, RYU_SITES_URL: sites.baseUrl },
		});

		const status = await ryu.sites.status();
		expect(status.mode).toBe("standalone");
		expect(status.apiVersion).toBe("v1");

		const project = await ryu.sites.projects.create({
			name: "Launch notes",
			slug: "launch-notes",
		});
		expect(project.revision).toBe(0);
		expect(project.settings.audience).toBe("private");

		const deployed = await ryu.sites.deploy({
			projectId: project.id,
			html: HTML,
			message: "First draft",
		});
		expect(deployed.version).not.toBeNull();
		expect(deployed.project.deploymentId).toBe(deployed.version?.id ?? null);
		expect(deployed.version?.message).toBe("First draft");
		expect(deployed.project.revision).toBe(2);
		// A first deploy keeps the Site private.
		expect(deployed.project.settings.audience).toBe("private");
		expect(deployed.url).toBe(
			`http://launch-notes.localhost:${status.visitorPort}/`
		);

		const listed = await ryu.sites.projects.list();
		expect(listed.map((item) => item.id)).toEqual([project.id]);

		const stale = await rejection(
			ryu.sites.versions.create(project.id, {
				html: HTML,
				expectedRevision: 0,
			})
		);
		expect(stale).toBeInstanceOf(RyuConflictError);
		expect(stale.code).toBe("conflict");
		expect(stale.attempts).toBe(1);

		const staleDeploy = await rejection(
			ryu.sites.deploy({
				projectId: project.id,
				html: HTML,
				expectedRevision: 1,
			})
		);
		expect(staleDeploy).toBeInstanceOf(RyuConflictError);
		expect(staleDeploy.details).toEqual({
			expectedRevision: 1,
			projectId: project.id,
			step: "version",
		});

		const offline = await ryu.sites.unpublish(project.id);
		expect(offline.deploymentId).toBeNull();
		expect(offline.versions).toHaveLength(1);

		const removed = await ryu.sites.projects.delete(project.id, {
			expectedRevision: offline.revision,
			slug: "launch-notes",
		});
		expect(removed).toEqual({ deleted: true });
	});

	test("schema errors carry fields, and a wrong bearer is 401", async () => {
		const sites = await startSites();
		const ryu = new Ryu({
			env: { RYU_SITES_API_KEY: TOKEN, RYU_SITES_URL: sites.baseUrl },
		});
		const invalid = await rejection(
			ryu.sites.projects.create({ name: "", slug: "x" })
		);
		expect(invalid).toBeInstanceOf(RyuInvalidRequestError);
		expect(invalid.code).toBe("invalid_input");
		expect(invalid.details).toEqual({ fields: ["name", "slug"] });

		const wrong = new Ryu({
			env: { RYU_SITES_API_KEY: "wrong-bearer", RYU_SITES_URL: sites.baseUrl },
		});
		const denied = await rejection(wrong.sites.projects.list());
		expect(denied).toBeInstanceOf(RyuAuthenticationError);
		expect(denied.code).toBe("unauthorized");
	});
});

interface Fixture {
	body: unknown;
	headers: Record<string, string>;
	status: number;
}

const FIXTURE_NAMES = [
	"deployed",
	"invalid-input",
	"project-created",
	"stale-revision",
	"status",
	"unauthorized",
	"version-saved",
] as const;

function fixture(name: (typeof FIXTURE_NAMES)[number]): Fixture {
	return JSON.parse(
		readFileSync(join(FIXTURES, `${name}.json`), "utf8")
	) as Fixture;
}

function respond(value: Fixture): Response {
	return new Response(JSON.stringify(value.body), {
		headers: value.headers,
		status: value.status,
	});
}

/** The key set of every object in `value`, by JSON path (array items merged). */
function shape(value: unknown, path = "$", out = new Map<string, string>()) {
	if (Array.isArray(value)) {
		for (const item of value) {
			shape(item, `${path}[]`, out);
		}
	} else if (value && typeof value === "object") {
		out.set(path, Object.keys(value).sort().join(","));
		for (const [key, item] of Object.entries(value)) {
			shape(item, `${path}.${key}`, out);
		}
	}
	return out;
}

describe("Sites conformance: recorded fixtures", () => {
	test("every fixture is listed here", () => {
		const files = readdirSync(FIXTURES)
			.filter((name) => name.endsWith(".json"))
			.map((name) => name.slice(0, -5))
			.sort();
		expect(files).toEqual([...FIXTURE_NAMES]);
	});

	test("fixtures decode through the SDK schemas", () => {
		expect(() => sitesStatusSchema.parse(fixture("status").body)).not.toThrow();
		for (const name of [
			"project-created",
			"version-saved",
			"deployed",
		] as const) {
			expect(() => sitesProjectSchema.parse(fixture(name).body)).not.toThrow();
		}
	});

	test("fixtures still match the live service's response shape", async () => {
		const sites = await startSites();
		const call = async (
			path: string,
			method = "GET",
			body?: unknown,
			token = TOKEN
		) => {
			const response = await fetch(`${sites.baseUrl}/api/sites${path}`, {
				body: body === undefined ? undefined : JSON.stringify(body),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method,
			});
			return {
				body: (await response.json()) as unknown,
				status: response.status,
			};
		};
		const created = await call("/projects", "POST", {
			name: "Launch notes",
			slug: "launch-notes",
		});
		const site = created.body as { id: string; revision: number };
		const saved = await call(`/projects/${site.id}/versions`, "POST", {
			expectedRevision: site.revision,
			html: HTML,
			message: "First draft",
		});
		const savedSite = saved.body as {
			revision: number;
			versions: { id: string }[];
		};
		const live: Record<
			(typeof FIXTURE_NAMES)[number],
			{ body: unknown; status: number }
		> = {
			"project-created": created,
			"version-saved": saved,
			deployed: await call(`/projects/${site.id}/deploy`, "POST", {
				expectedRevision: savedSite.revision,
				versionId: savedSite.versions.at(-1)?.id,
			}),
			"stale-revision": await call(`/projects/${site.id}/versions`, "POST", {
				expectedRevision: 0,
				html: HTML,
			}),
			"invalid-input": await call("/projects", "POST", { name: "", slug: "x" }),
			unauthorized: await call("/projects", "GET", undefined, "wrong-bearer"),
			status: await call("/status"),
		};
		for (const name of FIXTURE_NAMES) {
			const recorded = fixture(name);
			expect({ name, status: live[name].status }).toEqual({
				name,
				status: recorded.status,
			});
			expect(shape(live[name].body)).toEqual(shape(recorded.body));
		}
	});

	test("replayed fixtures drive the deploy composite and its conflict", async () => {
		const project = fixture("project-created").body as { id: string };
		const queue = [
			"project-created",
			"status",
			"version-saved",
			"deployed",
		] as const;
		const replayed: string[] = [];
		const ryu = new Ryu({
			env: { RYU_SITES_API_KEY: TOKEN, RYU_SITES_URL: "http://127.0.0.1:8021" },
			fetch: (input, init) => {
				const name = queue[replayed.length] ?? "deployed";
				replayed.push(
					`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`
				);
				return Promise.resolve(respond(fixture(name)));
			},
		});
		const result = await ryu.sites.deploy({
			projectId: project.id,
			html: HTML,
		});
		expect(replayed).toEqual([
			`GET /api/sites/projects/${project.id}`,
			"GET /api/sites/status",
			`POST /api/sites/projects/${project.id}/versions`,
			`POST /api/sites/projects/${project.id}/deploy`,
		]);
		expect(result.url).toBe("http://launch-notes.localhost:8022/");
		expect(result.version).not.toBeNull();
		expect(result.project.deploymentId).toBe(result.version?.id ?? null);

		const conflicted = new Ryu({
			env: { RYU_SITES_API_KEY: TOKEN, RYU_SITES_URL: "http://127.0.0.1:8021" },
			fetch: () => Promise.resolve(respond(fixture("stale-revision"))),
		});
		const error = await rejection(
			conflicted.sites.versions.create(project.id, {
				html: HTML,
				expectedRevision: 0,
			})
		);
		expect(error).toBeInstanceOf(RyuConflictError);
		expect(error.message).toBe("Site changed. Reload before saving.");
	});
});
