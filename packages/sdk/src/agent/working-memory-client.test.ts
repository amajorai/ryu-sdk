/**
 * The working-memory transport: Core's `/api/memory/working` routes through
 * an injected `fetch`.
 */

import { describe, expect, test } from "bun:test";
import { resolveWorkingMemory } from "./working-memory.ts";
import {
	createWorkingMemoryHandle,
	WorkingMemoryConflictError,
} from "./working-memory-client.ts";

const CORE = "http://127.0.0.1:7982";

function respondWith(response: () => Response, bodies: string[] = []) {
	return Object.assign(
		(
			_input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1]
		) => {
			bodies.push(String(init?.body ?? ""));
			return Promise.resolve(response());
		},
		{ preconnect: () => undefined }
	);
}

describe("working memory handle", () => {
	test("the handle surfaces Core errors", async () => {
		const handle = createWorkingMemoryHandle(
			resolveWorkingMemory({ id: "t" }),
			{
				coreBaseUrl: CORE,
				fetchImpl: respondWith(() =>
					Response.json({ error: "schema" }, { status: 400 })
				),
			}
		);
		await expect(handle.update({ content: "x" })).rejects.toThrow("400");
	});

	test("a stale expectedVersion is sent and raised as a conflict", async () => {
		const bodies: string[] = [];
		const handle = createWorkingMemoryHandle(
			resolveWorkingMemory({ id: "t" }),
			{
				coreBaseUrl: CORE,
				fetchImpl: respondWith(
					() =>
						Response.json(
							{ error: "version conflict", current_version: 3 },
							{ status: 409 }
						),
					bodies
				),
			}
		);
		const error = await handle
			.update({ content: "x", expectedVersion: 2 })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(WorkingMemoryConflictError);
		expect(error).toMatchObject({ currentVersion: 3, expectedVersion: 2 });
		expect(String(error)).toContain("409");
		expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({
			content: "x",
			expected_version: 2,
		});
	});

	test("a 409 without an expected version stays a plain error", async () => {
		const handle = createWorkingMemoryHandle(
			resolveWorkingMemory({ id: "t" }),
			{
				coreBaseUrl: CORE,
				fetchImpl: respondWith(() =>
					Response.json({ error: "conflict" }, { status: 409 })
				),
			}
		);
		const error = await handle
			.update({ content: "x" })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(WorkingMemoryConflictError);
	});
});

describe("working memory from the package root", () => {
	test("the documented conflict class is catchable from @ryuhq/sdk", async () => {
		const root = await import("../index.ts");
		const handle = root.createWorkingMemoryHandle(
			resolveWorkingMemory({ id: "t" }),
			{
				coreBaseUrl: CORE,
				fetchImpl: respondWith(() =>
					Response.json(
						{ error: "version conflict", current_version: 5 },
						{ status: 409 }
					)
				),
			}
		);
		const error = await handle
			.update({ content: "x", expectedVersion: 4 })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(root.WorkingMemoryConflictError);
		expect(error).toMatchObject({ currentVersion: 5 });
	});
});
