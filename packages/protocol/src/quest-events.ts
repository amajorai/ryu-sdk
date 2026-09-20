/**
 * The authenticated waitlist quest events that first-party clients may report.
 *
 * This is deliberately a small wire contract. Clients identify the surface and
 * event only; the control plane derives progress and rewards from its own data.
 */
export const QUEST_EVENT_NAMES = [
	"desktop_app_opened",
	"referral_sync",
] as const;

export type QuestEventName = (typeof QUEST_EVENT_NAMES)[number];

export const QUEST_EVENT_SURFACES = [
	"desktop",
	"extension",
	"mobile",
	"cli",
] as const;

export type QuestEventSurface = (typeof QUEST_EVENT_SURFACES)[number];

export interface QuestEventRequest {
	event: QuestEventName;
	surface: QuestEventSurface;
}
