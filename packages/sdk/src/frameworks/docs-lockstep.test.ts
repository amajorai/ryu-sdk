/**
 * Docs lockstep for the framework helpers. The "Switch from Mastra" and
 * "Switch from LangChain" pages and the README show code that imports from
 * `@ryuhq/sdk/mastra` and `@ryuhq/sdk/langchain`. This guard fails when a
 * page names an export, an option, a returned field or an environment
 * variable the helpers do not have. Filesystem only.
 *
 * The public SDK hub (`tools/mirror-sdk.sh`) carries this package and its
 * README but not the docs site, so the page checks run only where
 * `apps/fumadocs` exists. The README check runs everywhere.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RYU_NO_KEY } from "./gateway-target.ts";
import * as langchain from "./langchain.ts";
import * as mastra from "./mastra.ts";

const REPO = join(import.meta.dir, "../../../..");
const DOCS_SITE = "apps/fumadocs";
const DOCS = `${DOCS_SITE}/content/docs/extend/develop/sdk`;
const HAS_DOCS_SITE = existsSync(join(REPO, DOCS_SITE));
const README = "packages/sdk/README.md";
const PAGES = {
	langchain: `${DOCS}/switch-from-langchain.mdx`,
	mastra: `${DOCS}/switch-from-mastra.mdx`,
} as const;
const ENTRIES: Record<string, Record<string, unknown>> = { langchain, mastra };

const RE_SDK_IMPORT =
	/import\s*\{([^}]+)\}\s*from\s*"@ryuhq\/sdk\/(mastra|langchain)"/g;
const RE_HELPER_NAME = /\bryu[A-Z][A-Za-z]+\b/g;
const RE_RYU_ENV = /\bRYU_[A-Z_]+\b/g;
const RE_TABLE_FIELD = /^\| `([A-Za-z.]+)` \|/gm;
const HEADER_FIELDS = new Set(["headers", "defaultHeaders"]);

function read(path: string): string {
	return readFileSync(join(REPO, path), "utf8");
}

function section(page: string, heading: string): string {
	const start = page.indexOf(`## ${heading}`);
	if (start === -1) {
		throw new Error(`the page has no section "${heading}"`);
	}
	const end = page.indexOf("\n## ", start + 1);
	return page.slice(start, end === -1 ? undefined : end);
}

function tableFields(text: string): string[] {
	return [...text.matchAll(RE_TABLE_FIELD)].map((match) => match[1] ?? "");
}

/** Dotted field paths of a helper result. A headers map counts as one field. */
function fieldPaths(value: object, prefix = ""): string[] {
	return Object.entries(value).flatMap(([key, child]) =>
		child !== null && typeof child === "object" && !HEADER_FIELDS.has(key)
			? fieldPaths(child, `${prefix}${key}.`)
			: [`${prefix}${key}`]
	);
}

describe("the SDK README and the framework helpers", () => {
	test("the README names both helpers with their entry points", () => {
		const readme = read(README);
		expect(readme).toContain("`@ryuhq/sdk/mastra`");
		expect(readme).toContain("`@ryuhq/sdk/langchain`");
		expect(readme).toContain(`${mastra.ryuModel.name}("gpt-4o")`);
		expect(readme).toContain(`${langchain.ryuChatOpenAI.name}("gpt-4o")`);
	});
});

const describeDocs = describe.skipIf(!HAS_DOCS_SITE);

describeDocs("the switch pages name only what the helpers export", () => {
	test("every import from the two entry points resolves", () => {
		let imports = 0;
		for (const path of Object.values(PAGES)) {
			for (const match of read(path).matchAll(RE_SDK_IMPORT)) {
				const entry = ENTRIES[match[2] ?? ""];
				for (const name of (match[1] ?? "").split(",")) {
					imports += 1;
					expect(
						typeof entry?.[name.trim()],
						`${path} imports ${name.trim()} from @ryuhq/sdk/${match[2]}`
					).toBe("function");
				}
			}
		}
		// Two code samples on each of the two pages import a helper.
		expect(imports).toBeGreaterThanOrEqual(4);
	});

	test("every ryu helper name on the two pages is a real export", () => {
		const known = new Set([...Object.keys(mastra), ...Object.keys(langchain)]);
		for (const path of [PAGES.mastra, PAGES.langchain]) {
			const names = new Set(read(path).match(RE_HELPER_NAME));
			expect(names.size).toBeGreaterThan(0);
			for (const name of names) {
				expect(known.has(name), `${path} names ${name}`).toBe(true);
			}
		}
	});

	test("the environment variables are the ones the helpers read", () => {
		const known = new Set([mastra.ENV_GATEWAY_URL, mastra.ENV_GATEWAY_TOKEN]);
		for (const path of [PAGES.mastra, PAGES.langchain]) {
			const names = new Set(read(path).match(RE_RYU_ENV));
			expect(names.size).toBeGreaterThan(0);
			for (const name of names) {
				expect(known.has(name), `${path} names ${name}`).toBe(true);
			}
		}
	});

	test("the options tables list exactly the helper options", () => {
		for (const path of [PAGES.mastra, PAGES.langchain]) {
			expect(tableFields(section(read(path), "Options")).sort()).toEqual([
				"apiKey",
				"baseUrl",
				"headers",
			]);
		}
	});

	test("the returned field tables match what the helpers return", () => {
		const options = { headers: { "x-trace-id": "t1" } };
		expect(
			tableFields(section(read(PAGES.mastra), "What ryuModel returns")).sort()
		).toEqual(fieldPaths(mastra.ryuModel("gpt-4o", options)).sort());
		expect(
			tableFields(
				section(read(PAGES.langchain), "What ryuChatOpenAI returns")
			).sort()
		).toEqual(fieldPaths(langchain.ryuChatOpenAI("gpt-4o", options)).sort());
	});

	test("the placeholder key and the default URL are quoted correctly", () => {
		for (const path of [PAGES.mastra, PAGES.langchain]) {
			const page = read(path);
			expect(page).toContain(`\`${RYU_NO_KEY}\``);
			expect(page).toContain(mastra.DEFAULT_GATEWAY_URL);
		}
	});
});
