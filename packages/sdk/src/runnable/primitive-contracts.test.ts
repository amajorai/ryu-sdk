import { describe, expect, test } from "bun:test";
import type { BackupOperation, BackupRecord } from "../backups.types.ts";
import {
	backgroundProcessSchema,
	backgroundStopSchema,
	backupOperationSchema,
	backupRecordSchema,
	checkpointSchema,
	compareAndSetSchema,
	embeddingSchema,
	imageReplyItemUrl,
	imageReplySchema,
	memoryItemSchema,
	primitiveJsonSchema,
	ragChunkSchema,
	ragRerankSchema,
	realtimeSubscriptionSchema,
	resumedCheckpointSchema,
	storageKeysSchema,
	storageValueSchema,
	transcriptionReplySchema,
} from "./primitive-contracts.ts";

describe("primitive response ownership", () => {
	test("preserves valid metadata identities and own prototype-named properties", () => {
		const metadata = JSON.parse(
			'{"__proto__":{"tag":"retained"},"future":[null,true,3]}'
		);
		const chunk = { id: "chunk", text: "answer", score: 0.8, metadata };
		expect(ragChunkSchema.parse(chunk)).toBe(chunk);
		expect(ragChunkSchema.parse(chunk).metadata).toBe(metadata);
		expect(Object.hasOwn(metadata, "__proto__")).toBe(true);
		expect(primitiveJsonSchema.parse(metadata)).toBe(metadata);
		const invalidMetadata = Object.defineProperty({}, "__proto__", {
			value: () => "not JSON",
			enumerable: true,
		});
		expect(primitiveJsonSchema.safeParse(invalidMetadata).success).toBe(false);
		expect(
			primitiveJsonSchema.safeParse({ nested: invalidMetadata }).success
		).toBe(false);
		expect(
			ragChunkSchema.safeParse({ ...chunk, metadata: invalidMetadata }).success
		).toBe(false);
		const cycle = { next: {} };
		cycle.next = cycle;
		expect(primitiveJsonSchema.safeParse(cycle).success).toBe(false);
		const checkpoint = { state: metadata, future: { version: 2 } };
		expect(resumedCheckpointSchema.parse(checkpoint)).toBe(checkpoint);
		expect(resumedCheckpointSchema.parse(null)).toBeNull();
	});
	test("requires actual retrieval, reranking, memory and subscription fields", () => {
		expect(
			ragChunkSchema.safeParse({ id: "chunk", text: "answer", score: "0.8" })
				.success
		).toBe(false);
		expect(
			ragRerankSchema.safeParse({ document: "text", index: 1, score: 0.8 })
				.success
		).toBe(true);
		expect(
			ragRerankSchema.safeParse({ document: "text", index: "1", score: 0.8 })
				.success
		).toBe(false);
		expect(
			memoryItemSchema.safeParse({
				content: "remember",
				id: "memory",
				tags: [3],
			}).success
		).toBe(false);
		expect(
			realtimeSubscriptionSchema.safeParse({
				room: "room",
				subscriptionId: "subscription",
			}).success
		).toBe(true);
		expect(realtimeSubscriptionSchema.safeParse({ room: "room" }).success).toBe(
			false
		);
		expect(checkpointSchema.safeParse({ token: "resume" }).success).toBe(true);
		expect(checkpointSchema.safeParse({ token: 3 }).success).toBe(false);
	});
	test("matches generated backup scope and operation fields", () => {
		const record = {
			id: "snapshot",
			bytes: 32,
			createdAt: "2026-01-01",
			objectKey: "key",
			scope: { kind: "node" },
			sha256: "hash",
			version: 1,
		} satisfies BackupRecord;
		expect(backupRecordSchema.parse(record)).toBe(record);
		const operation = {
			action: "create",
			backup: record,
			createdAt: "2026-01-01",
			destinationId: "destination",
			id: "operation",
			scope: { kind: "app", appId: "app", namespace: "data", tenant: "tenant" },
			status: "complete",
			result: { extra: true },
		} satisfies BackupOperation;
		expect(backupOperationSchema.parse(operation)).toBe(operation);
		expect(
			backupOperationSchema.safeParse({
				...operation,
				scope: { kind: "app", appId: "app" },
			}).success
		).toBe(false);
		expect(
			backupRecordSchema.safeParse({ ...record, bytes: "32" }).success
		).toBe(false);
	});
	test("checks background status and native process identifiers", () => {
		const process = {
			command: "echo",
			cwd: "/tmp",
			elapsed_ms: 0,
			kind: "command",
			process_id: "process",
			producer: "plugin",
			running: true,
			started_at: 1,
			exit_code: null,
			future: { pid: 2 },
		};
		expect(backgroundProcessSchema.parse(process)).toBe(process);
		expect(
			backgroundProcessSchema.safeParse({ ...process, running: "true" }).success
		).toBe(false);
		expect(
			backgroundStopSchema.safeParse({
				ok: true,
				requested: false,
				process_id: "process",
			}).success
		).toBe(true);
		expect(
			backgroundStopSchema.safeParse({
				ok: true,
				requested: false,
				process_id: 2,
			}).success
		).toBe(false);
	});
	test("keeps missing storage keys tolerant while enforcing string values and vectors", () => {
		expect(storageKeysSchema.parse(null)).toEqual([]);
		expect(storageKeysSchema.parse(["a", 1])).toEqual([]);
		expect(storageKeysSchema.parse(["a", "b"])).toEqual(["a", "b"]);
		expect(storageValueSchema.parse(null)).toBeNull();
		expect(storageValueSchema.safeParse(3).success).toBe(false);
		expect(compareAndSetSchema.safeParse("true").success).toBe(false);
		expect(embeddingSchema.parse([[0, 1], []])).toEqual([[0, 1], []]);
		expect(embeddingSchema.safeParse([["1"]]).success).toBe(false);
	});
	test("retains optional media envelope defaults and rejects malformed entries", () => {
		expect(transcriptionReplySchema.parse({}).text).toBeUndefined();
		expect(transcriptionReplySchema.parse({ text: null }).text).toBeNull();
		expect(transcriptionReplySchema.safeParse({ text: 42 }).success).toBe(
			false
		);
		expect(imageReplySchema.parse({ data: null }).data).toBeNull();
		expect(imageReplySchema.safeParse({ data: [{ url: 42 }] }).success).toBe(
			false
		);
	});
	test("labels base64 images with their reported raster media type", () => {
		expect(imageReplyItemUrl({ url: "https://images.invalid/a.png" })).toBe(
			"https://images.invalid/a.png"
		);
		expect(
			imageReplyItemUrl({ b64_json: "AA", media_type: "image/webp" })
		).toBe("data:image/webp;base64,AA");
		expect(imageReplyItemUrl({ b64_json: "AA" })).toBe(
			"data:image/png;base64,AA"
		);
		expect(
			imageReplyItemUrl({ b64_json: "AA", media_type: "image/svg+xml" })
		).toBe("data:image/png;base64,AA");
		expect(
			imageReplySchema.safeParse({ data: [{ b64_json: "AA", media_type: 1 }] })
				.success
		).toBe(false);
	});
});
