import type {
	QuestEventName,
	QuestEventRequest,
	QuestEventSurface,
} from "@ryuhq/protocol/quest-events";
import { type ApiTarget, request } from "./client.ts";

export type {
	QuestEventName,
	QuestEventRequest,
	QuestEventSurface,
} from "@ryuhq/protocol/quest-events";

export interface QuestEventResponse {
	accepted?: boolean;
	event: QuestEventName;
	ok: boolean;
	progress?: number;
	questKey?: string;
	referralId?: string | null;
	referralStatus?: string;
	status?: string;
	surface: QuestEventSurface;
}
/**
 * Report a first-party waitlist event to the control plane.
 *
 * The caller must provide the Better Auth bearer, not a Core node token. The
 * endpoint is best-effort at the surface layer; a network failure should never
 * prevent the app from opening.
 */
export function recordQuestEvent(
	target: ApiTarget,
	event: QuestEventName,
	surface: QuestEventSurface
): Promise<QuestEventResponse> {
	const body: QuestEventRequest = { event, surface };
	return request<QuestEventResponse>(target, "/api/quests/events", {
		body,
		method: "POST",
	});
}
