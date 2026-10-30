// Shared client↔node compatibility. Both rules under test are deliberate:
// WARN-NEVER-BLOCK (every verdict is advisory) and FAIL-SOFT (anything unknown
// resolves to "fine"). A node that predates a field must never be reported as
// broken for not answering a question nobody used to ask.

import { describe, expect, it } from "bun:test";
import {
	assessNode,
	channelOf,
	compareSemver,
	hasCapability,
	isNodeCompatible,
	MIN_CORE_VERSION,
} from "./node-compat.ts";

describe("channelOf", () => {
	it("derives the channel from the version alone", () => {
		// Mirrors Core's channel_of, so both sides agree with nothing stored.
		expect(channelOf("0.0.18")).toBe("stable");
		expect(channelOf("v0.0.18")).toBe("stable");
		expect(channelOf("0.0.18-nightly.20260802.23")).toBe("nightly");
		expect(channelOf("0.0.18-canary.4")).toBe("canary");
		expect(channelOf("0.0.18-beta.1")).toBe("beta");
		// Build metadata is not a channel.
		expect(channelOf("0.0.18+f1a68ac")).toBe("stable");
		expect(channelOf("0.0.18-nightly.3+f1a68ac")).toBe("nightly");
	});

	it("fails soft on a missing version", () => {
		expect(channelOf(null)).toBe("stable");
		expect(channelOf(undefined)).toBe("stable");
		expect(channelOf("")).toBe("stable");
	});
});

describe("assessNode", () => {
	it("catches channel skew the version comparison cannot see", () => {
		// The blind spot: compareSemver discards the prerelease, so a stable and a
		// canary build of the SAME version compare equal and no version check could
		// ever flag the pairing.
		expect(compareSemver("0.0.18", "0.0.18-canary.4")).toBe(0);
		const v = assessNode("0.0.18", {
			status: "ok",
			version: "0.0.18-canary.4",
		});
		expect(v.channelMismatch).toEqual({ client: "stable", node: "canary" });
		expect(v.ok).toBe(false);
	});

	it("prefers the channel the node reports over deriving it", () => {
		const v = assessNode("0.0.18", {
			channel: "nightly",
			status: "ok",
			version: "0.0.18",
		});
		expect(v.channelMismatch).toEqual({ client: "stable", node: "nightly" });
	});

	it("flags a newer node — the lapsed-updates case", () => {
		// A client whose update window ended, driving a node that kept moving. Not
		// an error: a prompt that some node features may not render here.
		const v = assessNode("0.0.18", { status: "ok", version: "0.1.0" });
		expect(v.nodeIsNewer).toBe(true);
		expect(v.belowFloor).toBe(false);
		expect(v.ok).toBe(false);
	});

	it("is silent when client and node agree", () => {
		const v = assessNode("0.0.18", { status: "ok", version: "0.0.18" });
		expect(v).toEqual({
			belowFloor: false,
			channelMismatch: null,
			nodeIsNewer: false,
			ok: true,
		});
	});

	it("an older node is not 'newer', and clears the floor", () => {
		const v = assessNode("0.1.0", { status: "ok", version: "0.0.18" });
		expect(v.nodeIsNewer).toBe(false);
		expect(v.belowFloor).toBe(false);
	});

	it("fails soft when either side has no version", () => {
		expect(assessNode("0.0.18", { status: "ok", version: null }).ok).toBe(true);
		expect(assessNode(null, { status: "ok", version: "0.1.0" }).ok).toBe(true);
		expect(assessNode("0.0.18", null).ok).toBe(true);
	});
});

describe("floor and capabilities", () => {
	it("treats an unknown version as compatible", () => {
		expect(isNodeCompatible(null)).toBe(true);
		expect(isNodeCompatible("garbage")).toBe(true);
		expect(isNodeCompatible(MIN_CORE_VERSION)).toBe(true);
	});

	it("treats a node with no capability list as having everything", () => {
		// Otherwise upgrading the client would silently hide features that work.
		expect(hasCapability(undefined, "spaces")).toBe(true);
		expect(hasCapability([], "spaces")).toBe(true);
		expect(hasCapability(["spaces"], "spaces")).toBe(true);
		expect(hasCapability(["other"], "spaces")).toBe(false);
	});
});
