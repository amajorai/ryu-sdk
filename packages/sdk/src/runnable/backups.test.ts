import { expect, test } from "bun:test";
import { createPrimitives, type PrimitiveTransport } from "./primitives.ts";

test("app snapshots use only the grant-gated backup bridge and propagate failures", async () => {
	const calls: Array<{ method: string; args: unknown }> = [];
	const transport: PrimitiveTransport = {
		bridge: async (method, args) => {
			calls.push({ method, args });
			if (method === "backups.restore") {
				throw new Error("Wrong recovery key");
			}
			return [];
		},
		direct: async () => {
			throw new Error("Unexpected direct request");
		},
		capability: async () => {
			throw new Error("Unexpected broker request");
		},
	};
	const backups = createPrimitives(transport).backups;
	await backups.destinations();
	await backups.create({
		destinationId: "dest",
		namespace: "data",
		idempotencyKey: "save-1",
		data: { version: 1 },
	});
	await backups.list({ destinationId: "dest", namespace: "data" });
	await backups.get({
		destinationId: "dest",
		namespace: "data",
		operationId: "job",
	});
	await expect(
		backups.restore({
			destinationId: "dest",
			namespace: "data",
			backupId: "backup",
		})
	).rejects.toThrow("Wrong recovery key");
	expect(calls.map((call) => call.method)).toEqual([
		"backups.destinations",
		"backups.create",
		"backups.list",
		"backups.get",
		"backups.restore",
	]);
	expect(calls[1]?.args).toEqual({
		destinationId: "dest",
		namespace: "data",
		idempotencyKey: "save-1",
		data: { version: 1 },
	});
});
