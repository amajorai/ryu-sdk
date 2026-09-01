/**
 * Publisher identity trust is deliberately separate from listing review and
 * manifest-signature provenance. It answers one question only: who stands
 * behind this publication?
 */

export const PUBLISHER_TRUST_LEVELS = ["gold", "blue", "dotted"] as const;
export type PublisherTrustLevel = (typeof PUBLISHER_TRUST_LEVELS)[number];

export const PUBLISHER_TRUST_SOURCES = [
	"ryu_staff",
	"stripe_connect",
	"none",
] as const;
export type PublisherTrustSource = (typeof PUBLISHER_TRUST_SOURCES)[number];

export interface PublisherTrustInput {
	firstParty?: boolean | null;
	ryuStaffVerified?: boolean | null;
	stripeIdentityVerified?: boolean | null;
}

export interface PublisherTrustSummary {
	level: PublisherTrustLevel;
	source: PublisherTrustSource;
	verified: boolean;
}

/**
 * Resolve the publisher mark from server-controlled signals.
 *
 * Gold wins over blue: a Ryu staff decision is a stronger, separate
 * endorsement than a completed Stripe identity check. Stripe identity is
 * still useful for publishers who have not gone through Ryu's staff review.
 * Missing signals fail closed to the dotted community mark.
 */
export function resolvePublisherTrust(
	input: PublisherTrustInput
): PublisherTrustSummary {
	if (input.firstParty || input.ryuStaffVerified) {
		return { level: "gold", source: "ryu_staff", verified: true };
	}
	if (input.stripeIdentityVerified) {
		return { level: "blue", source: "stripe_connect", verified: true };
	}
	return { level: "dotted", source: "none", verified: false };
}

export function publisherTrustLabel(level: PublisherTrustLevel): string {
	switch (level) {
		case "gold":
			return "Officially verified by Ryu staff";
		case "blue":
			return "Identity verified via Stripe Connect";
		case "dotted":
			return "Unverified publisher";
	}
}

export function publisherTrustTooltip(level: PublisherTrustLevel): string {
	switch (level) {
		case "gold":
			return "Ryu staff has officially verified this publisher.";
		case "blue":
			return "This organization has verified its identity through Stripe Connect. Ryu has not officially endorsed the publisher.";
		case "dotted":
			return "This is not a verified publisher. Review the health signals before installing.";
	}
}
