import { describe, expect, test } from "bun:test";
import { ConfluenceLoader } from "./confluence.ts";
import { GitHubRepoLoader } from "./github.ts";
import { driveId, GoogleDriveLoader } from "./google-drive.ts";
import { NotionLoader, notionId } from "./notion.ts";
import { jsonResponse, mockNetwork, textResponse } from "./test-support.ts";

describe("GitHubRepoLoader", () => {
	const api = "https://api.github.com/repos/acme/handbook";
	const routes = {
		[api]: jsonResponse({ default_branch: "main" }),
		[`${api}/git/trees/main?recursive=1`]: jsonResponse({
			truncated: false,
			tree: [
				{ type: "blob", path: "README.md", sha: "r1", size: 10 },
				{ type: "tree", path: "docs", sha: "t1" },
				{ type: "blob", path: "docs/intro.md", sha: "a1", size: 20 },
				{ type: "blob", path: "docs/logo.png", sha: "b1", size: 30 },
				{ type: "blob", path: "docs/huge.md", sha: "h1", size: 5_000_000 },
				{ type: "blob", path: "docs/data.bin.md", sha: "z1", size: 4 },
			],
		}),
		[`${api}/contents/docs/intro.md?ref=main`]: textResponse(
			"# Intro",
			"text/plain"
		),
		[`${api}/contents/docs/data.bin.md?ref=main`]: new Response(
			new Uint8Array([0, 1, 2, 3])
		),
	};

	test("lists the tree, filters, and downloads raw files with the token", async () => {
		const net = mockNetwork(routes);
		const docs = await new GitHubRepoLoader({
			...net,
			owner: "acme",
			repo: "handbook",
			path: "docs",
			extensions: [".md"],
			token: () => "ghp_test",
		}).load();
		expect(docs).toEqual([
			{
				content: "# Intro",
				metadata: {
					source: "https://github.com/acme/handbook/blob/main/docs/intro.md",
					loader: "github",
					repository: "acme/handbook",
					ref: "main",
					path: "docs/intro.md",
					sha: "a1",
				},
			},
		]);
		for (const request of net.requests) {
			expect(request.headers.get("authorization")).toBe("Bearer ghp_test");
		}
		const raw = net.requests.find((request) =>
			request.url.includes("/contents/")
		);
		expect(raw?.headers.get("accept")).toBe("application/vnd.github.raw");
		expect(
			net.requests.some((request) => request.url.includes("huge.md"))
		).toBe(false);
	});

	test("rejects path-like owner names", () => {
		expect(() => new GitHubRepoLoader({ owner: "../x", repo: "y" })).toThrow(
			"plain names"
		);
	});
});

describe("NotionLoader", () => {
	const pageId = "0123456789abcdef0123456789abcdef";
	const dashed = "01234567-89ab-cdef-0123-456789abcdef";
	const dbId = "fedcba9876543210fedcba9876543210";
	const dbDashed = "fedcba98-7654-3210-fedc-ba9876543210";
	const rich = (text: string, annotations = {}, href: string | null = null) => [
		{ plain_text: text, annotations, href },
	];
	const routes = {
		[`https://api.notion.com/v1/pages/${dashed}`]: jsonResponse({
			id: dashed,
			url: `https://www.notion.so/Handbook-${pageId}`,
			last_edited_time: "2026-09-01T00:00:00.000Z",
			properties: { Name: { type: "title", title: rich("Handbook") } },
		}),
		[`https://api.notion.com/v1/blocks/${dashed}/children?page_size=100`]:
			jsonResponse({
				results: [
					{
						id: "b1",
						type: "heading_1",
						heading_1: { rich_text: rich("Welcome") },
					},
					{
						id: "b2",
						type: "paragraph",
						paragraph: {
							rich_text: [
								...rich("Read "),
								...rich("this", { bold: true }),
								...rich(" link", {}, "https://example.com"),
							],
						},
					},
					{
						id: "b3",
						type: "bulleted_list_item",
						has_children: true,
						bulleted_list_item: { rich_text: rich("Parent") },
					},
				],
				has_more: true,
				next_cursor: "c2",
			}),
		[`https://api.notion.com/v1/blocks/${dashed}/children?page_size=100&start_cursor=c2`]:
			jsonResponse({
				results: [
					{
						id: "b4",
						type: "numbered_list_item",
						numbered_list_item: { rich_text: rich("First") },
					},
					{
						id: "b5",
						type: "numbered_list_item",
						numbered_list_item: { rich_text: rich("Second") },
					},
					{
						id: "b6",
						type: "to_do",
						to_do: { rich_text: rich("Done"), checked: true },
					},
					{
						id: "b7",
						type: "code",
						code: { language: "typescript", rich_text: rich("const x = 1;") },
					},
					{ id: "b8", type: "table", has_children: true, table: {} },
				],
				has_more: false,
			}),
		"https://api.notion.com/v1/blocks/b3/children?page_size=100": jsonResponse({
			results: [
				{
					id: "b3a",
					type: "bulleted_list_item",
					bulleted_list_item: { rich_text: rich("Child") },
				},
			],
			has_more: false,
		}),
		"https://api.notion.com/v1/blocks/b8/children?page_size=100": jsonResponse({
			results: [
				{
					id: "r1",
					type: "table_row",
					table_row: { cells: [rich("Key"), rich("Value")] },
				},
				{
					id: "r2",
					type: "table_row",
					table_row: { cells: [rich("a"), rich("1")] },
				},
			],
			has_more: false,
		}),
		[`https://api.notion.com/v1/databases/${dbDashed}/query`]: jsonResponse({
			results: [
				{
					id: "row1",
					url: "https://www.notion.so/row1",
					properties: {
						Task: { type: "title", title: rich("Ship it") },
						Status: { type: "status", status: { name: "Done" } },
						Tags: {
							type: "multi_select",
							multi_select: [{ name: "a" }, { name: "b" }],
						},
						Points: { type: "number", number: 3 },
						Due: { type: "date", date: { start: "2026-10-01", end: null } },
					},
				},
			],
			has_more: false,
		}),
	};

	test("normalizes ids and URLs", () => {
		expect(
			notionId(`https://www.notion.so/acme/Handbook-${pageId}?v=abc`)
		).toBe(dashed);
		expect(notionId(dashed.toUpperCase())).toBe(dashed);
		expect(() => notionId("nope")).toThrow("not a Notion id");
	});

	test("renders a page block tree as Markdown with pagination and nesting", async () => {
		const net = mockNetwork(routes);
		const [doc] = await new NotionLoader({
			...net,
			token: "secret_x",
			pageIds: [pageId],
		}).load();
		expect(doc?.content).toBe(
			[
				"# Handbook",
				"",
				"# Welcome",
				"",
				"Read **this** [link](https://example.com)",
				"",
				"- Parent",
				"  - Child",
				"1. First",
				"2. Second",
				"- [x] Done",
				"",
				"```typescript\nconst x = 1;\n```",
				"",
				"| Key | Value |\n| --- | --- |\n| a | 1 |",
			].join("\n")
		);
		expect(doc?.metadata).toMatchObject({
			loader: "notion",
			title: "Handbook",
			id: dashed,
		});
		expect(net.requests[0]?.headers.get("notion-version")).toBe("2022-06-28");
		expect(net.requests[0]?.headers.get("authorization")).toBe(
			"Bearer secret_x"
		);
	});

	test("loads database rows with flattened properties", async () => {
		const net = mockNetwork(routes);
		const docs = await new NotionLoader({
			...net,
			token: "secret_x",
			databaseIds: [dbId],
			loadRowContent: false,
		}).load();
		expect(docs).toHaveLength(1);
		expect(docs[0]?.metadata).toMatchObject({
			title: "Ship it",
			databaseId: dbDashed,
			properties: {
				Task: "Ship it",
				Status: "Done",
				Tags: ["a", "b"],
				Points: 3,
				Due: "2026-10-01",
			},
		});
		const query = net.requests.find((request) =>
			request.url.endsWith("/query")
		);
		expect(query?.method).toBe("POST");
		expect(JSON.parse(query?.body ?? "{}")).toEqual({ page_size: 100 });
	});
});

describe("GoogleDriveLoader", () => {
	const api = "https://www.googleapis.com/drive/v3";
	const fields = "id%2Cname%2CmimeType%2CmodifiedTime%2CwebViewLink";
	const folderQuery = new URLSearchParams({
		q: "'folder123456' in parents and trashed = false",
		fields: "nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink)",
		pageSize: "100",
		supportsAllDrives: "true",
		includeItemsFromAllDrives: "true",
	});
	const routes = {
		[`${api}/files/doc1234567890?fields=${fields}&supportsAllDrives=true`]:
			jsonResponse({
				id: "doc1234567890",
				name: "Plan",
				mimeType: "application/vnd.google-apps.document",
				webViewLink: "https://docs.google.com/document/d/doc1234567890/edit",
			}),
		[`${api}/files/doc1234567890/export?mimeType=text%2Fmarkdown`]:
			textResponse("# Plan", "text/markdown"),
		[`${api}/files?${folderQuery}`]: jsonResponse({
			files: [
				{
					id: "sheet123456789",
					name: "Budget",
					mimeType: "application/vnd.google-apps.spreadsheet",
				},
				{
					id: "pdf12345678901",
					name: "Report.pdf",
					mimeType: "application/pdf",
				},
				{ id: "note1234567890", name: "notes.txt", mimeType: "text/plain" },
				{
					id: "sub12345678901",
					name: "Sub",
					mimeType: "application/vnd.google-apps.folder",
				},
			],
		}),
		[`${api}/files/sheet123456789/export?mimeType=text%2Fcsv`]: textResponse(
			"a,b\n1,2",
			"text/csv"
		),
		[`${api}/files/note1234567890?alt=media&supportsAllDrives=true`]:
			textResponse("hello", "text/plain"),
		[`${api}/files/pdf12345678901?alt=media&supportsAllDrives=true`]:
			new Response(new Uint8Array([37, 80, 68, 70])),
	};

	test("extracts ids from URLs", () => {
		expect(
			driveId("https://docs.google.com/document/d/doc1234567890/edit")
		).toBe("doc1234567890");
		expect(driveId("https://drive.google.com/drive/folders/folder123456")).toBe(
			"folder123456"
		);
		expect(() => driveId("x'y")).toThrow("not a Google Drive id");
	});

	test("exports Google formats, downloads text, and parses binaries", async () => {
		const net = mockNetwork(routes);
		const parsed: string[] = [];
		const docs = await new GoogleDriveLoader({
			...net,
			accessToken: "ya29.test",
			fileIds: ["https://docs.google.com/document/d/doc1234567890/edit"],
			folderIds: ["folder123456"],
			parser: (bytes, name) => {
				parsed.push(name);
				return Promise.resolve(`parsed ${bytes.byteLength} bytes`);
			},
		}).load();
		expect(docs.map((doc) => [doc.metadata.title, doc.content])).toEqual([
			["Plan", "# Plan"],
			["Budget", "a,b\n1,2"],
			["Report.pdf", "parsed 4 bytes"],
			["notes.txt", "hello"],
		]);
		expect(parsed).toEqual(["Report.pdf"]);
		expect(
			net.requests.every(
				(request) => request.headers.get("authorization") === "Bearer ya29.test"
			)
		).toBe(true);
	});

	test("skips binaries without a parser", async () => {
		const net = mockNetwork(routes);
		const docs = await new GoogleDriveLoader({
			...net,
			accessToken: "t",
			folderIds: ["folder123456"],
		}).load();
		expect(docs.map((doc) => doc.metadata.title)).toEqual([
			"Budget",
			"notes.txt",
		]);
	});
});

describe("ConfluenceLoader", () => {
	const base = "https://acme.atlassian.net/wiki";
	const expand = "body.export_view%2Cbody.storage%2Cversion%2Cspace";
	const pageBody = (id: string, title: string, html: string) => ({
		id,
		title,
		body: { export_view: { value: html } },
		version: { number: 4, when: "2026-09-01T00:00:00Z" },
		space: { key: "ENG" },
		_links: { webui: `/spaces/ENG/pages/${id}` },
	});
	const routes = {
		[`${base}/rest/api/content/101?expand=${expand}`]: jsonResponse(
			pageBody("101", "Runbook", "<h2>Steps</h2><ol><li>Check</li></ol>")
		),
		[`${base}/rest/api/content?spaceKey=ENG&type=page&status=current&expand=${expand}&start=0&limit=50`]:
			jsonResponse({
				results: [pageBody("201", "One", "<p>first</p>")],
				_links: { next: "/rest/api/content?start=1" },
			}),
		[`${base}/rest/api/content?spaceKey=ENG&type=page&status=current&expand=${expand}&start=1&limit=50`]:
			jsonResponse({
				results: [pageBody("202", "Two", "<p>second</p>")],
				_links: {},
			}),
	};

	test("loads pages and paginates a space with Basic auth", async () => {
		const net = mockNetwork(routes);
		const docs = await new ConfluenceLoader({
			...net,
			baseUrl: `${base}/`,
			email: "me@acme.com",
			apiToken: "atl-token",
			pageIds: ["101"],
			spaceKey: "ENG",
		}).load();
		expect(docs.map((doc) => doc.content)).toEqual([
			"# Runbook\n\n## Steps\n\n1. Check",
			"# One\n\nfirst",
			"# Two\n\nsecond",
		]);
		expect(docs[0]?.metadata).toMatchObject({
			source: `${base}/spaces/ENG/pages/101`,
			space: "ENG",
			version: 4,
		});
		expect(net.requests[0]?.headers.get("authorization")).toBe(
			`Basic ${btoa("me@acme.com:atl-token")}`
		);
	});

	test("uses a bearer PAT and refuses a private base URL", async () => {
		const net = mockNetwork(routes);
		await new ConfluenceLoader({
			...net,
			baseUrl: base,
			personalAccessToken: "pat",
			pageIds: ["101"],
		}).load();
		expect(net.requests[0]?.headers.get("authorization")).toBe("Bearer pat");
		await expect(
			new ConfluenceLoader({
				...net,
				baseUrl: "http://10.0.0.8/confluence",
				personalAccessToken: "pat",
				pageIds: ["1"],
			}).load()
		).rejects.toThrow("private address");
	});

	test("validates ids and keys", () => {
		expect(
			() => new ConfluenceLoader({ baseUrl: base, pageIds: ["1/../2"] })
		).toThrow("numeric");
		expect(
			() => new ConfluenceLoader({ baseUrl: base, spaceKey: "a&b" })
		).toThrow("plain key");
	});
});
