import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coreDocumentParser, LocalFileLoader } from "./file.ts";
import {
	CsvLoader,
	JsonLinesLoader,
	JsonLoader,
	jsonPointer,
	parseCsv,
} from "./structured.ts";
import { jsonResponse, mockNetwork, textResponse } from "./test-support.ts";

describe("parseCsv", () => {
	test("handles quotes, embedded newlines, CRLF, BOM, and blank lines", () => {
		expect(
			parseCsv('﻿a,b\r\n"x, y","multi\nline"\r\n\r\n"say ""hi""",2\n')
		).toEqual([
			["a", "b"],
			["x, y", "multi\nline"],
			['say "hi"', "2"],
		]);
	});

	test("detects semicolon and tab delimiters", () => {
		expect(parseCsv("a;b\n1;2")).toEqual([
			["a", "b"],
			["1", "2"],
		]);
		expect(parseCsv("a\tb\n1\t2")).toEqual([
			["a", "b"],
			["1", "2"],
		]);
	});

	test("rejects an unterminated quote", () => {
		expect(() => parseCsv('a\n"open')).toThrow("unterminated");
	});
});

describe("CsvLoader", () => {
	test("one document per row with content and metadata columns", async () => {
		const docs = await new CsvLoader(
			{
				text: "question,answer,category,url\nWhat?,This.,faq,https://e.com/1\nWhy?,Because.,faq,",
				source: "faq.csv",
			},
			{
				contentColumns: ["question", "answer"],
				metadataColumns: ["category"],
				sourceColumn: "url",
			}
		).load();
		expect(docs).toEqual([
			{
				content: "question: What?\nanswer: This.",
				metadata: {
					category: "faq",
					source: "https://e.com/1",
					loader: "csv",
					row: 0,
				},
			},
			{
				content: "question: Why?\nanswer: Because.",
				metadata: { category: "faq", source: "faq.csv", loader: "csv", row: 1 },
			},
		]);
	});

	test("reports unknown columns", async () => {
		await expect(
			new CsvLoader({ text: "a\n1" }, { contentColumns: ["b"] }).load()
		).rejects.toThrow("no column b");
	});

	test("fetches a URL under the SSRF policy", async () => {
		const net = mockNetwork({
			"https://data.example.com/x.csv": textResponse("a\n1", "text/csv"),
		});
		const docs = await new CsvLoader(
			{ url: "https://data.example.com/x.csv" },
			net
		).load();
		expect(docs[0]?.metadata.source).toBe("https://data.example.com/x.csv");
		await expect(
			new CsvLoader({ url: "http://127.0.0.1/x.csv" }, net).load()
		).rejects.toThrow("private address");
	});
});

describe("JSON loaders", () => {
	const json = JSON.stringify({
		data: {
			items: [
				{ id: 1, body: { text: "first" }, tags: ["a"] },
				{ id: 2, body: { text: "second" } },
			],
		},
	});

	test("JsonLoader follows a pointer and extracts content and metadata keys", async () => {
		const docs = await new JsonLoader(
			{ text: json, source: "items.json" },
			{
				pointer: "/data/items",
				contentKey: "body.text",
				metadataKeys: ["id", "tags"],
			}
		).load();
		expect(docs).toEqual([
			{
				content: "first",
				metadata: {
					id: 1,
					tags: ["a"],
					source: "items.json",
					loader: "json",
					index: 0,
				},
			},
			{
				content: "second",
				metadata: {
					id: 2,
					tags: null,
					source: "items.json",
					loader: "json",
					index: 1,
				},
			},
		]);
	});

	test("JsonLoader without contentKey stringifies the value", async () => {
		const [doc] = await new JsonLoader({ text: '{"a":1}' }).load();
		expect(doc?.content).toBe('{\n  "a": 1\n}');
	});

	test("jsonPointer handles escapes and misses", () => {
		expect(jsonPointer({ "a/b": { "~c": 3 } }, "/a~1b/~0c")).toBe(3);
		expect(jsonPointer({ a: 1 }, "/missing/deeper")).toBeUndefined();
	});

	test("JsonLinesLoader reads one document per line and names bad lines", async () => {
		const docs = await new JsonLinesLoader(
			{ text: '{"t":"a"}\n\n{"t":"b"}\n' },
			{ contentKey: "t" }
		).load();
		expect(docs.map((doc) => [doc.content, doc.metadata.index])).toEqual([
			["a", 0],
			["b", 1],
		]);
		await expect(
			new JsonLinesLoader({ text: '{"t":1}\n{oops' }).load()
		).rejects.toThrow("line 2");
	});
});

describe("LocalFileLoader", () => {
	let dir = "";

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "ryu-loaders-"));
		await mkdir(join(dir, "sub"));
		await mkdir(join(dir, ".git"));
		await writeFile(join(dir, "a.md"), "# A");
		await writeFile(join(dir, "page.html"), "<h1>Title</h1><p>Body</p>");
		await writeFile(
			join(dir, "sub", "report.pdf"),
			new Uint8Array([37, 80, 68, 70])
		);
		await writeFile(join(dir, ".git", "config"), "ignored");
	});

	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("reads text, converts HTML, and sends binaries to Core document.parse", async () => {
		const net = mockNetwork({
			"http://127.0.0.1:7980/api/documents/parse": jsonResponse({
				status: "queued",
				job_id: "job-1",
			}),
			"http://127.0.0.1:7980/api/documents/parse/jobs/job-1": jsonResponse({
				status: "succeeded",
				markdown: "# Report",
			}),
		});
		const docs = await new LocalFileLoader(dir, {
			core: {
				nodeUrl: "http://127.0.0.1:7980",
				token: "tok",
				fetch: net.fetch,
				pollIntervalMs: 1,
			},
		}).load();
		expect(docs.map((doc) => [doc.metadata.source, doc.content])).toEqual([
			[join(dir, "a.md"), "# A"],
			[join(dir, "page.html"), "# Title\n\nBody"],
			[join(dir, "sub", "report.pdf"), "# Report"],
		]);
		const submit = net.requests[0];
		expect(submit?.method).toBe("POST");
		expect(submit?.headers.get("x-filename")).toBe("report.pdf");
		expect(submit?.headers.get("authorization")).toBe("Bearer tok");
	});

	test("without a parser, binaries fail unless skipped", async () => {
		await expect(new LocalFileLoader(dir).load()).rejects.toThrow(
			"no parser for .pdf"
		);
		const docs = await new LocalFileLoader(dir, {
			skipUnsupported: true,
			recursive: false,
		}).load();
		expect(docs.map((doc) => doc.metadata.extension)).toEqual([".md", ".html"]);
	});

	test("a symlinked directory cycle is walked once", async () => {
		const looped = await mkdtemp(join(tmpdir(), "ryu-loaders-loop-"));
		try {
			await writeFile(join(looped, "a.md"), "# A");
			await symlink(looped, join(looped, "loop"), "dir");
			expect(await new LocalFileLoader(looped).files()).toEqual([
				join(looped, "a.md"),
			]);
		} finally {
			await rm(looped, { recursive: true, force: true });
		}
	});

	test("coreDocumentParser surfaces Core's refusal", async () => {
		const net = mockNetwork({
			"http://core/api/documents/parse": jsonResponse(
				{
					error: "no document parser is installed that can read .pdf",
					code: "no_provider",
				},
				415
			),
		});
		const parse = coreDocumentParser({
			nodeUrl: "http://core",
			fetch: net.fetch,
		});
		await expect(parse(new Uint8Array([1]), "x.pdf")).rejects.toThrow(
			"no document parser is installed"
		);
	});
});
