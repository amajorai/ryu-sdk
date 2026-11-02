/**
 * robots.txt parsing and matching (RFC 9309).
 *
 * The group for the most specific matching user-agent wins (falling back to
 * `*`); within it the longest matching `Allow`/`Disallow` path wins, and a tie
 * goes to `Allow`. `*` and a trailing `$` are supported in paths.
 */

/** One `Allow` or `Disallow` rule. */
interface RobotsRule {
	allow: boolean;
	path: string;
	pattern: RegExp;
}

interface RobotsGroup {
	agents: string[];
	crawlDelaySeconds?: number;
	rules: RobotsRule[];
}

/** A parsed robots.txt. */
export interface RobotsPolicy {
	/** The `Crawl-delay` for `userAgent`, in seconds, when one is set. */
	crawlDelay(userAgent: string): number | undefined;
	/** Whether `url` may be fetched by `userAgent`. */
	isAllowed(url: string | URL, userAgent: string): boolean;
	/** `Sitemap:` URLs declared in the file. */
	readonly sitemaps: readonly string[];
}

const REGEX_SPECIAL = /[.+?^${}()|[\]\\]/g;
const LINE_BREAK = /\r\n|\r|\n/;

function rulePattern(path: string): RegExp {
	const anchored = path.endsWith("$");
	const body = (anchored ? path.slice(0, -1) : path)
		.replace(REGEX_SPECIAL, "\\$&")
		.replaceAll("*", ".*");
	return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

function productToken(userAgent: string): string {
	return (userAgent.split("/")[0] ?? userAgent).trim().toLowerCase();
}

function parseGroups(text: string): {
	groups: RobotsGroup[];
	sitemaps: string[];
} {
	const groups: RobotsGroup[] = [];
	const sitemaps: string[] = [];
	let current: RobotsGroup | undefined;
	let lastWasAgent = false;
	for (const rawLine of text.split(LINE_BREAK)) {
		const line = rawLine.replace(/#.*$/, "").trim();
		const colon = line.indexOf(":");
		if (colon === -1) {
			continue;
		}
		const field = line.slice(0, colon).trim().toLowerCase();
		const value = line.slice(colon + 1).trim();
		if (field === "sitemap") {
			if (value) {
				sitemaps.push(value);
			}
			continue;
		}
		if (field === "user-agent") {
			if (!(current && lastWasAgent)) {
				current = { agents: [], rules: [] };
				groups.push(current);
			}
			current.agents.push(value.toLowerCase());
			lastWasAgent = true;
			continue;
		}
		lastWasAgent = false;
		if (!current) {
			continue;
		}
		if (field === "allow" || field === "disallow") {
			// An empty Disallow allows everything; it adds no rule.
			if (value) {
				current.rules.push({
					allow: field === "allow",
					path: value,
					pattern: rulePattern(value),
				});
			}
		} else if (field === "crawl-delay") {
			const seconds = Number.parseFloat(value);
			if (Number.isFinite(seconds) && seconds >= 0) {
				current.crawlDelaySeconds = seconds;
			}
		}
	}
	return { groups, sitemaps };
}

function selectGroup(
	groups: readonly RobotsGroup[],
	userAgent: string
): RobotsGroup | undefined {
	const token = productToken(userAgent);
	let best: RobotsGroup | undefined;
	let bestLength = -1;
	for (const group of groups) {
		for (const agent of group.agents) {
			if (agent !== "*" && token.includes(agent) && agent.length > bestLength) {
				best = group;
				bestLength = agent.length;
			}
		}
	}
	return best ?? groups.find((group) => group.agents.includes("*"));
}

/** Parse a robots.txt body. */
export function parseRobotsTxt(text: string): RobotsPolicy {
	const { groups, sitemaps } = parseGroups(text);
	return {
		sitemaps,
		crawlDelay(userAgent) {
			return selectGroup(groups, userAgent)?.crawlDelaySeconds;
		},
		isAllowed(url, userAgent) {
			const group = selectGroup(groups, userAgent);
			if (!group) {
				return true;
			}
			const parsed = typeof url === "string" ? new URL(url) : url;
			const target = `${parsed.pathname}${parsed.search}`;
			let verdict: RobotsRule | undefined;
			for (const rule of group.rules) {
				if (!rule.pattern.test(target)) {
					continue;
				}
				if (
					!verdict ||
					rule.path.length > verdict.path.length ||
					(rule.path.length === verdict.path.length && rule.allow)
				) {
					verdict = rule;
				}
			}
			return verdict?.allow ?? true;
		},
	};
}

/** A policy that allows everything (no robots.txt, or a 4xx for it). */
export const ALLOW_ALL_ROBOTS: RobotsPolicy = parseRobotsTxt("");

/** A policy that refuses everything (robots.txt unreachable with a 5xx). */
export const DISALLOW_ALL_ROBOTS: RobotsPolicy = parseRobotsTxt(
	"User-agent: *\nDisallow: /"
);
