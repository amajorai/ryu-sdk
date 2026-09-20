// Shared wire contract for Core's release verdict. The install mechanism is
// surface-specific: desktop uses Tauri, mobile uses Expo Updates, and Chrome
// uses the Web Store. Keeping the verdict shape here prevents browser clients
// from drifting as Core adds fields.

import { type ApiTarget, request } from "./client.ts";

export interface UpdateReleaseAsset {
	kind: string;
	name: string;
	size: number;
	url: string;
}

export interface UpdateCheck {
	asset: UpdateReleaseAsset | null;
	channel: string;
	current: string;
	cutoff_unresolved?: boolean;
	cutoff_waived_for_security?: boolean;
	error?: string | null;
	html_url: string | null;
	latest: string;
	latest_unrestricted?: string;
	notes: string | null;
	published_at?: string | null;
	restricted_by_cutoff?: boolean;
	tag?: string | null;
	update_available: boolean;
}

export interface FetchUpdateCheckOptions {
	channel?: string;
	signal?: AbortSignal;
}

/** True when a verdict is a failed check rather than a clean no-update result. */
export function updateCheckFailed(verdict: UpdateCheck): boolean {
	return (
		Boolean(verdict.error) || !(verdict.update_available || verdict.latest)
	);
}

/**
 * Fetch Core's release verdict without making any claim about installation.
 * Errors stay explicit in the returned sentinel so notify-only clients do not
 * silently turn an unavailable Core into an "up to date" message.
 */
export async function fetchUpdateCheck(
	target: ApiTarget,
	options?: FetchUpdateCheckOptions
): Promise<UpdateCheck> {
	const params = new URLSearchParams();
	if (options?.channel) {
		params.set("channel", options.channel);
	}
	const suffix = params.toString() ? `?${params.toString()}` : "";
	try {
		return await request<UpdateCheck>(target, `/api/update/check${suffix}`, {
			signal: options?.signal,
		});
	} catch (error) {
		return {
			asset: null,
			channel: options?.channel ?? "stable",
			current: "",
			error: error instanceof Error ? error.message : "Update check failed",
			html_url: null,
			latest: "",
			notes: null,
			update_available: false,
		};
	}
}
