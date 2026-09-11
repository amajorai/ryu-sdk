import type {
	BackupDestination,
	BackupOperation,
	BackupPolicy,
	BackupRecord,
	CreateBackup,
	SaveBackupDestination,
	SaveBackupPolicy,
} from "./backups.types.ts";
import { type ApiTarget, request } from "./client.ts";

export type * from "./backups.types.ts";

export interface RestoreBackup {
	backupId: string;
	destinationId: string;
	dryRun?: boolean;
	idempotencyKey: string;
}

export interface BackupOverview {
	destinations: BackupDestination[];
	operations: BackupOperation[];
	policies: BackupPolicy[];
}

export function getBackups(target: ApiTarget): Promise<BackupOverview> {
	return request(target, "/api/backups");
}
export function generateBackupKey(
	target: ApiTarget
): Promise<{ recoveryKey: string }> {
	return request(target, "/api/backups/recovery-key", { method: "POST" });
}
export function saveBackupDestination(
	target: ApiTarget,
	body: SaveBackupDestination,
	id?: string
): Promise<BackupDestination> {
	return request(
		target,
		`/api/backups/destinations${id ? `/${encodeURIComponent(id)}` : ""}`,
		{ method: id ? "PUT" : "POST", body }
	);
}
export function deleteBackupDestination(
	target: ApiTarget,
	id: string
): Promise<void> {
	return request(
		target,
		`/api/backups/destinations/${encodeURIComponent(id)}`,
		{ method: "DELETE" }
	);
}
export function testBackupDestination(
	target: ApiTarget,
	id: string
): Promise<{ ok: boolean }> {
	return request(
		target,
		`/api/backups/destinations/${encodeURIComponent(id)}/test`,
		{ method: "POST" }
	);
}
export function listBackups(
	target: ApiTarget,
	id: string,
	spaceId?: string
): Promise<BackupRecord[]> {
	return request(
		target,
		`/api/backups/destinations/${encodeURIComponent(id)}/backups${spaceId ? `?spaceId=${encodeURIComponent(spaceId)}` : ""}`
	);
}
export function saveBackupPolicy(
	target: ApiTarget,
	body: SaveBackupPolicy
): Promise<BackupPolicy> {
	return request(target, "/api/backups/policies", { method: "POST", body });
}
export function deleteBackupPolicy(
	target: ApiTarget,
	id: string
): Promise<void> {
	return request(target, `/api/backups/policies/${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
}
export function createBackup(
	target: ApiTarget,
	body: CreateBackup
): Promise<BackupOperation> {
	return request(target, "/api/backups/runs", { method: "POST", body });
}
export function restoreBackup(
	target: ApiTarget,
	body: RestoreBackup
): Promise<BackupOperation> {
	return request(target, "/api/backups/restore", { method: "POST", body });
}
export function getBackupOperation(
	target: ApiTarget,
	id: string
): Promise<BackupOperation> {
	return request(target, `/api/backups/operations/${encodeURIComponent(id)}`);
}
