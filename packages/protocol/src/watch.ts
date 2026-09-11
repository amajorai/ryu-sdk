/** Ryu Watch v1 wire contract. Evidence is bounded, redacted data, never instructions. */
export type WatchCheckId = "transport" | "management-auth";
export type WatchCheckStatus = "pass" | "finding" | "inconclusive";
export interface WatchCheck {
	id: WatchCheckId;
	severity: "info" | "medium";
	status: WatchCheckStatus;
	summary: string;
}
export interface WatchAssetView {
	checks: WatchCheck[];
	enrollmentSource: "dns" | "managed-cloud";
	id: string;
	lastError: string | null;
	lastScanAt: string | null;
	name: string;
	nextScanAt: string;
	notificationStatus: "pending" | "sent" | "suppressed" | "failed";
	notifiedAt: string | null;
	origin: string;
	ownerId: string;
	status: "pending" | "active" | "paused";
}
export interface WatchLeakView {
	credentialId: string | null;
	firstSeenAt: string;
	id: string;
	lastSeenAt: string;
	notificationStatus: "pending" | "sent" | "suppressed" | "failed";
	notifiedAt: string | null;
	status: "open" | "revoked" | "inactive" | "unmapped";
}
export interface WatchSnapshot {
	assets: WatchAssetView[];
	events: {
		id: string;
		action: string;
		actorId: string;
		targetId: string | null;
		status: "pending" | "completed" | "failed";
		createdAt: string;
	}[];
	leaks: WatchLeakView[];
	nextCursor: string | null;
	nextLeakCursor: string | null;
	reports: WatchAnalysisReport[];
	service: {
		workerEnabled: boolean;
		partnerIntakeEnabled: boolean;
		lastWorkerAt: string | null;
		lastPartnerAt: string | null;
		workerError: string | null;
	};
}

export interface WatchAnalysisReport {
	checks: {
		id:
			| "secrets"
			| "static-analysis"
			| "dependencies"
			| "vault-permissions"
			| "vault-encryption";
		status: "pass" | "finding" | "inconclusive";
		findings: number;
		errorCount?: number;
	}[];
	id: string;
	issues?: WatchAnalysisIssue[];
	observedAt: string;
	project: string;
	revision: string;
	source: "repository" | "node";
	subjectId: string;
}

/** Location-only triage. No source lines, matches, credentials, or arbitrary messages. */
export interface WatchAnalysisIssue {
	checkId: "secrets" | "static-analysis" | "dependencies";
	line: number;
	path: string;
	ruleId: string;
}
