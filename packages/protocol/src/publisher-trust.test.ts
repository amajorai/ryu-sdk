import { describe, expect, test } from "bun:test";
import {
	publisherTrustLabel,
	publisherTrustTooltip,
	resolvePublisherTrust,
} from "./publisher-trust.ts";

describe("resolvePublisherTrust", () => {
	test("Ryu staff verification wins and produces the gold mark", () => {
		expect(
			resolvePublisherTrust({
				ryuStaffVerified: true,
				stripeIdentityVerified: true,
			})
		).toEqual({ level: "gold", source: "ryu_staff", verified: true });
	});

	test("Stripe identity verification produces the blue mark", () => {
		expect(resolvePublisherTrust({ stripeIdentityVerified: true })).toEqual({
			level: "blue",
			source: "stripe_connect",
			verified: true,
		});
	});

	test("missing or revoked signals remain explicitly dotted", () => {
		expect(resolvePublisherTrust({})).toEqual({
			level: "dotted",
			source: "none",
			verified: false,
		});
	});
});

describe("publisher trust copy", () => {
	test("does not collapse identity verification into a generic verified label", () => {
		expect(publisherTrustLabel("gold")).toContain("Ryu staff");
		expect(publisherTrustLabel("blue")).toContain("Stripe Connect");
		expect(publisherTrustLabel("dotted")).toBe("Unverified publisher");
		expect(publisherTrustTooltip("dotted")).toContain(
			"not a verified publisher"
		);
	});
});
