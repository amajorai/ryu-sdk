// Generated from ryu-backup Rust schemas by tools/generate-backup-contracts.mjs.
// Do not edit; run `bun tools/generate-backup-contracts.mjs`.

export interface BackupDestination {
	allowedApps: string[];
	allowHttp: boolean;
	bucket: string;
	createdAt: string;
	endpoint: string;
	id: string;
	name: string;
	pathStyle: boolean;
	prefix: string;
	region: string;
}

export interface BackupOperation {
	action: string;
	backup?: null | BackupRecord;
	completedAt?: string | null;
	createdAt: string;
	destinationId: string;
	error?: string | null;
	id: string;
	result?: unknown;
	scope: BackupScope;
	status: string;
}

export interface BackupPolicy {
	destinationId: string;
	enabled: boolean;
	id: string;
	lastAttemptAt?: string | null;
	retentionCount: number;
	schedule: string;
	scope: BackupScope;
}

export interface BackupRecord {
	bytes: number;
	createdAt: string;
	id: string;
	objectKey: string;
	scope: BackupScope;
	sha256: string;
	sourceNodeId?: string;
	version: number;
}

export type BackupScope =
	| {
			kind: "node";
	  }
	| {
			kind: "space";
			spaceId: string;
	  }
	| {
			appId: string;
			kind: "app";
			namespace: string;
			tenant: string;
	  };

export interface CreateBackup {
	destinationId: string;
	idempotencyKey: string;
	scope: BackupScope;
}

export interface SaveBackupDestination {
	accessKeyId: string;
	allowedApps?: string[];
	allowHttp?: boolean;
	bucket: string;
	endpoint: string;
	name: string;
	pathStyle?: boolean;
	prefix?: string;
	recoveryKey: string;
	region: string;
	secretAccessKey: string;
	sessionToken?: string | null;
}

export interface SaveBackupPolicy {
	destinationId: string;
	enabled: boolean;
	retentionCount: number;
	schedule: string;
	scope: BackupScope;
}
