// Typed Core proxy client for the device-local Shadow timeline.

import { type ApiTarget, request } from "./client.ts";

/** A single timeline event returned by Shadow through Core. */
export interface TimelineEvent {
	app_name: string | null;
	event_type: string;
	track: number;
	ts: number;
	url: string | null;
	window_title: string | null;
}

/** Fetch timeline events in the trailing `rangeMinutes` window. */
export async function fetchTimeline(
	target: ApiTarget,
	rangeMinutes: number,
	signal?: AbortSignal
): Promise<TimelineEvent[]> {
	const now = Date.now() * 1000;
	const start = now - rangeMinutes * 60 * 1_000_000;
	const json = await request<{ entries?: TimelineEvent[] }>(
		target,
		`/api/shadow/timeline?start=${start}&end=${now}`,
		{ signal }
	);
	return json.entries ?? [];
}
