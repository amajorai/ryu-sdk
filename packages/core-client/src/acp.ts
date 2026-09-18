// apps/desktop/src/lib/api/acp.ts
//
// Typed client for Core's ACP session-config endpoints. These expose, per
// active agent, exactly what the ACP agent advertises at `session/new`:
//   - permission **modes** (default / acceptEdits / plan / bypassPermissions /
//     read-only, …) — agent-reported strings, NOT hardcoded by Ryu;
//   - **config options** (e.g. a reasoning-effort / `thoughtLevel` selector);
//   - **models** (unstable ACP capability; null when unsupported).
//
// This is the same data-driven contract Zed uses: the desktop renders a picker
// only for what the agent reports, and applies a choice by sending it on the
// next chat turn (Core re-applies it to that turn's session). The interactive
// permission prompt (when an agent in a gating mode asks to run a tool) is
// resolved via `respondPermission`.

import { type ApiTarget, request } from "./client.ts";

/** A single permission/session mode the agent supports. */
export interface AcpSessionMode {
	description?: string | null;
	id: string;
	name: string;
}

/** The agent's mode set + currently active mode (from `session/new`). */
export interface AcpSessionModeState {
	availableModes: AcpSessionMode[];
	currentModeId: string;
}

/** A selectable model the agent advertises (unstable ACP capability). */
export interface AcpModelInfo {
	description?: string | null;
	modelId: string;
	name: string;
}

export interface AcpSessionModelState {
	availableModels: AcpModelInfo[];
	currentModelId: string;
}

/** One selectable value for a `select` config option. */
export interface AcpConfigSelectOption {
	description?: string | null;
	name: string;
	value: string;
}

/**
 * A session config option. The common case (and the only `kind` Ryu surfaces a
 * picker for) is `type: "select"` — a dropdown with `currentValue` + `options`.
 * `category` is a UX hint: `"mode"` | `"model"` | `"thoughtLevel"` (reasoning
 * effort) | any agent-defined string.
 */
export interface AcpConfigOption {
	category?: string | null;
	currentValue?: string;
	description?: string | null;
	id: string;
	name: string;
	/** Flat list for ungrouped selects; grouped selects expose `{ options }`. */
	options?: AcpConfigSelectOption[] | { options: AcpConfigSelectOption[] }[];
	type?: string;
}

/** The full agent-reported session config (each field null when unsupported). */
export interface AcpConfig {
	configOptions: AcpConfigOption[] | null;
	models: AcpSessionModelState | null;
	modes: AcpSessionModeState | null;
}

/** A permission option offered by the agent when it asks to run a tool. */
export interface AcpPermissionOption {
	/** allow_once | allow_always | reject_once | reject_always. */
	kind: string;
	name: string;
	optionId: string;
}

/**
 * Config-option picks to apply to the probe session before reading what the
 * agent advertises, as Core's `?selections=` query param (empty string for none).
 *
 * An agent's option SET can depend on the values already selected — ACP's
 * `session/set_config_option` answers with the whole refreshed list precisely so
 * a client can see that. opencode advertises its reasoning-`effort` option only
 * while the session's model has effort levels, so probing with no model pick
 * reports an option set that is real but incomplete. Passing the picks is what
 * makes the composer show the controls that exist FOR THE CHOSEN MODEL.
 *
 * Keys are sorted so the same picks always produce the same URL — Core's probe
 * cache is keyed by this, and an unstable order would fragment it.
 */
export function acpSelectionsParam(
	selections?: Record<string, string> | null
): string {
	const entries = Object.entries(selections ?? {})
		.filter(([id, value]) => id.length > 0 && value.length > 0)
		.sort(([a], [b]) => a.localeCompare(b));
	if (entries.length === 0) {
		return "";
	}
	const encoded = encodeURIComponent(
		JSON.stringify(Object.fromEntries(entries))
	);
	return `?selections=${encoded}`;
}

/**
 * Fetch the agent's advertised ACP session config. Returns all-null for non-ACP
 * agents (they have no `session/new` advertisement). Core caches per agent (and
 * per `selections`), so this is cheap to call on agent selection.
 */
export async function fetchAcpConfig(
	target: ApiTarget,
	agentId: string,
	selections?: Record<string, string> | null
): Promise<AcpConfig> {
	return await request<AcpConfig>(
		target,
		`/api/agents/${encodeURIComponent(agentId)}/acp-config${acpSelectionsParam(selections)}`
	);
}

/**
 * Resolve an interactive tool-permission prompt raised mid-turn. Pass the
 * `requestId` from the `data-ryu-permission` stream part and the chosen
 * `optionId` (or `null` to reject/cancel). Unblocks the awaiting agent turn.
 */
export async function respondPermission(
	target: ApiTarget,
	requestId: string,
	optionId: string | null
): Promise<{ resolved: boolean }> {
	return await request<{ resolved: boolean }>(target, "/api/chat/permission", {
		method: "POST",
		body: { request_id: requestId, option_id: optionId },
	});
}

/** Flatten a select option's `options` (ungrouped or grouped) to a flat list. */
export function flattenConfigOptions(
	option: AcpConfigOption
): AcpConfigSelectOption[] {
	const raw = option.options ?? [];
	const first = raw[0];
	if (!first) {
		return [];
	}
	// Grouped form: `[{ options: [...] }, ...]`.
	if ("options" in first) {
		return (raw as { options: AcpConfigSelectOption[] }[]).flatMap(
			(g) => g.options
		);
	}
	return raw as AcpConfigSelectOption[];
}
