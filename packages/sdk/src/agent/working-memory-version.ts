/**
 * Optimistic concurrency for the SDK's `update_working_memory` tool, matching
 * Core's built-in tool: the injected block shows the document version, the
 * model sends it back as `expected_version`, and a stale version is refused
 * with the current document so the model can merge instead of overwriting a
 * concurrent update. Omitting `expected_version` keeps the unconditional
 * last-write-wins call.
 */

import type { WorkingMemoryDocument } from "./working-memory-client.ts";

/**
 * The concurrency part of the block's instructions: which version the block
 * shows and what to do when an update is refused because another writer got
 * there first.
 */
export function versionInstructions(version: number): string {
	return `This is version ${version}: pass \`expected_version: ${version}\` with your update (for a later update in the same turn, use the \`version\` your last update returned). If the update is refused because the version changed, merge your change into the current document the error shows and retry with its version.`;
}

/**
 * Read the optional `expected_version` argument: a non-negative integer (a
 * numeric string is accepted, since some models quote numbers). Absent or
 * `null` means an unconditional write.
 */
export function parseExpectedVersion(value: unknown): number | undefined {
	if (value === undefined || value === null) {
		return;
	}
	let parsed: number | undefined;
	if (typeof value === "number") {
		parsed = value;
	} else if (typeof value === "string" && /^\s*\d+\s*$/.test(value)) {
		parsed = Number(value.trim());
	}
	if (parsed === undefined || !Number.isSafeInteger(parsed) || parsed < 0) {
		throw new Error(
			"`expected_version` must be a non-negative integer: the version shown in your working memory, or the one your last update returned"
		);
	}
	return parsed;
}

function documentBody(doc: WorkingMemoryDocument): string {
	if (doc.mode === "template") {
		return doc.content ?? "";
	}
	return doc.data ? JSON.stringify(doc.data, null, 2) : "{}";
}

/**
 * The error message an agent gets when its `expected_version` is stale: what
 * happened, what to do, and the current document to merge into, so it can
 * recover in the same turn without a separate read tool.
 */
export function conflictMessage(
	toolName: string,
	expected: number,
	current: number,
	latest: WorkingMemoryDocument | null | undefined
): string {
	let message = `working memory version conflict: you sent expected_version ${expected}, but the document is now at version ${current} because it changed after you read it. Your update was NOT saved. Re-read the current document below, merge your change into it, and call \`${toolName}\` again with expected_version: ${current}.`;
	if (!latest) {
		return message;
	}
	const body = documentBody(latest);
	if (body.trim()) {
		message += `\n\nCurrent document (version ${current}):\n${body.trimEnd()}`;
	} else {
		message += "\n\nThe current document is empty.";
	}
	return message;
}
