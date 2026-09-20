// Typed Core proxy client for the device-local Shadow timeline.

import { type ApiTarget, request } from "./client.ts";

export interface SpeechHistoryInput {
	end: string;
	limit?: number;
	offset?: number;
	start: string;
}
export interface SpeechSegment {
	endedAt: string;
	id: string;
	startedAt: string;
	text: string;
	timing: "segment" | "window";
}
export interface SpeechHistory {
	nextOffset: number | null;
	segments: SpeechSegment[];
	truncated?: boolean;
}

/** Validated before privileged dispatch as well as at the Shadow endpoint. */
export function parseSpeechHistoryInput(
	value: unknown
): SpeechHistoryInput | null {
	if (!value || typeof value !== "object") {
		return null;
	}
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).some(
			(key) => !["start", "end", "limit", "offset"].includes(key)
		)
	) {
		return null;
	}
	const { start, end, limit = 100, offset = 0 } = record;
	if (
		typeof start !== "string" ||
		typeof end !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(start) ||
		!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(end)
	) {
		return null;
	}
	const duration = Date.parse(end) - Date.parse(start);
	if (
		!Number.isFinite(duration) ||
		Date.parse(start) < 0 ||
		duration <= 0 ||
		duration > 86_400_000 ||
		typeof limit !== "number" ||
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > 500 ||
		typeof offset !== "number" ||
		!Number.isInteger(offset) ||
		offset < 0 ||
		offset > 10_000
	) {
		return null;
	}
	return { start, end, limit, offset };
}

export function speechHistoryQuery(input: SpeechHistoryInput): string {
	const valid = parseSpeechHistoryInput(input);
	if (!valid) {
		throw new Error("Invalid speech history range.");
	}
	return new URLSearchParams({
		start: valid.start,
		end: valid.end,
		limit: String(valid.limit),
		offset: String(valid.offset),
	}).toString();
}

/** The caller supplies the physical device's Core target; never infer a remote sensor. */
export function fetchSpeechHistory(
	target: ApiTarget,
	input: SpeechHistoryInput
): Promise<SpeechHistory> {
	return request(
		target,
		`/api/shadow/transcripts?${speechHistoryQuery(input)}`
	);
}

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
