import { expect, test } from "bun:test";
import {
	createBackup,
	restoreBackup,
	saveBackupDestination,
} from "./backups.ts";
import { ApiError } from "./client.ts";

test("backup clients preserve remote node credentials, scope and idempotency", async () => {
	const calls: Array<{ url: string; body: unknown; headers: Headers }> = [];
	const target = {
		url: "https://node.example",
		token: "node-token",
		userJwt: "user-token",
		fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
			calls.push({
				url: String(url),
				body: JSON.parse(String(init?.body)),
				headers: new Headers(init?.headers),
			});
			return Response.json({ id: "operation", status: "pending" });
		},
	};
	const body = {
		destinationId: "dest",
		scope: { kind: "space" as const, spaceId: "space" },
		idempotencyKey: "request-1",
	};
	await createBackup(target, body);
	await restoreBackup(target, {
		destinationId: "dest",
		backupId: "snapshot",
		dryRun: true,
		idempotencyKey: "request-2",
	});
	expect(calls.map((call) => call.url)).toEqual([
		"https://node.example/api/backups/runs",
		"https://node.example/api/backups/restore",
	]);
	expect(calls[0]?.body).toEqual(body);
	expect(calls[1]?.body).toEqual({
		destinationId: "dest",
		backupId: "snapshot",
		dryRun: true,
		idempotencyKey: "request-2",
	});
	expect(calls[0]?.headers.get("authorization")).toBe("Bearer node-token");
	expect(calls[0]?.headers.get("x-ryu-user-jwt")).toBe("user-token");
});

test("failed destination validation remains a failure with the safe server reason", async () => {
	const target = {
		url: "https://node.example",
		token: null,
		fetch: async () =>
			Response.json(
				{ error: "Recovery key must contain 32 bytes" },
				{ status: 400 }
			),
	};
	try {
		await saveBackupDestination(target, {
			name: "Test",
			endpoint: "https://s3.example",
			bucket: "backup-bucket",
			region: "auto",
			accessKeyId: "test",
			secretAccessKey: "test",
			recoveryKey: "invalid",
		});
		throw new Error("Expected validation failure");
	} catch (error) {
		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).serverMessage).toBe(
			"Recovery key must contain 32 bytes"
		);
	}
});
