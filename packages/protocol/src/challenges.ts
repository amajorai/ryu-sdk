/** Canonical wire contract for public Ryu challenges, hackathons, and events. */

export const CHALLENGE_KINDS = ["challenge", "hackathon", "event"] as const;
export type ChallengeKind = (typeof CHALLENGE_KINDS)[number];

export const CHALLENGE_FORMATS = ["online", "in_person", "hybrid"] as const;
export type ChallengeFormat = (typeof CHALLENGE_FORMATS)[number];

export const CHALLENGE_PUBLICATION_STATES = [
	"draft",
	"published",
	"archived",
] as const;
export type ChallengePublicationState =
	(typeof CHALLENGE_PUBLICATION_STATES)[number];

export const CHALLENGE_STATUSES = [
	"draft",
	"upcoming",
	"live",
	"closed",
	"archived",
] as const;
export type ChallengeStatus = (typeof CHALLENGE_STATUSES)[number];

export const CHALLENGE_ENTRY_STATUSES = [
	"registered",
	"submitted",
	"shortlisted",
	"awarded",
	"declined",
] as const;
export type ChallengeEntryStatus = (typeof CHALLENGE_ENTRY_STATUSES)[number];

export interface ChallengePrizeTier {
	label: string;
	place: number;
	points: number;
}

export interface ChallengeWinner {
	allowPublicDisplay: boolean;
	awardPlace: number;
	awardPoints: number;
	displayName: string;
	id: string;
	prizeLabel: string;
	projectName: string;
}

/** Public summary and detail shape. All dates use RFC 3339 UTC strings. */
export interface Challenge {
	awardedPoints: number;
	brief: string;
	category: string;
	endsAt: string;
	featured: boolean;
	format: ChallengeFormat;
	hostName: string;
	hostUrl: string | null;
	id: string;
	judgingCriteria: string[];
	kind: ChallengeKind;
	location: string | null;
	participantCount: number;
	prizeSummary: string | null;
	prizeTiers: ChallengePrizeTier[];
	publicationState: ChallengePublicationState;
	rules: string[];
	slug: string;
	startsAt: string;
	status: ChallengeStatus;

	submissionCount: number;
	summary: string;
	timezone: string;
	title: string;
	totalPoints: number;
	winners: ChallengeWinner[];
}

/** Submission and registration shape returned to its owner or a platform admin. */
export interface ChallengeEntry {
	allowPublicDisplay: boolean;
	awardPlace: number | null;
	awardPoints: number | null;
	challengeId: string;
	displayName: string;
	email?: string;
	fulfillmentNote: string | null;
	fulfillmentStatus: "pending" | "fulfilled" | null;
	id: string;
	pitch: string | null;
	prizeLabel: string | null;
	projectName: string | null;
	projectUrl: string | null;
	registeredAt: string;
	reviewNote: string | null;
	status: ChallengeEntryStatus;
	submittedAt: string | null;
	teamName: string | null;
}

/** Full fields an admin saves for a challenge or event. */
export interface ChallengeDraftInput {
	brief: string;
	category: string;
	endsAt: string;
	featured: boolean;
	format: ChallengeFormat;
	hostName: string;
	hostUrl: string | null;
	judgingCriteria: string[];
	kind: ChallengeKind;
	location: string | null;
	prizeSummary: string | null;
	prizeTiers: ChallengePrizeTier[];
	publicationState: ChallengePublicationState;
	rules: string[];
	startsAt: string;
	summary: string;
	timezone: string;
	title: string;
}

/** A participant can register first, then submit or update a project. */
export interface ChallengeSubmissionInput {
	allowPublicDisplay: boolean;
	pitch: string;
	projectName: string;
	projectUrl: string;
	teamName?: string;
}

export interface ChallengeUserEntry {
	challenge: Challenge;
	entry: ChallengeEntry;
}
