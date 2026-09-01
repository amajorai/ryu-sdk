// RNP v0: explicit, consent-scoped conversation continuity between configured
// Ryu nodes. This module is deliberately pure. It validates and serializes the
// wire contract, but it never performs a network request or changes node state.

export const RNP_CONTINUITY_PROTOCOL = "ryu-node-continuity" as const;
export const RNP_CONTINUITY_VERSION = 0 as const;

export const RNP_CONTINUITY_LIMITS = {
	maxWireBytes: 2 * 1024 * 1024,
	maxMessages: 200,
	maxMessageBytes: 64 * 1024,
	maxTranscriptBytes: 1536 * 1024,
	maxContextItems: 16,
	maxContextItemBytes: 32 * 1024,
	maxContextBytes: 256 * 1024,
	maxIdBytes: 128,
	maxLabelBytes: 256,
	maxNodeUrlBytes: 2048,
} as const;

export type RnpTranscriptScopeV0 =
	| { mode: "all" }
	| { mode: "recent"; maxMessages: number };

export type RnpContextSourceV0 =
	| "browser-selection"
	| "clip-transcript"
	| "composer"
	| "manual"
	| "recent-activity"
	| "other";

export interface RnpContextTextV0 {
	id: string;
	kind: "text";
	label: string;
	mediaType: "text/markdown" | "text/plain";
	source: {
		kind: RnpContextSourceV0;
		label?: string;
	};
	text: string;
}

export interface RnpContextBundleV0 {
	items: RnpContextTextV0[];
	version: 0;
}

export interface RnpMessageV0 {
	createdAt: number;
	role: "assistant" | "user";
	sourceId: string;
	text: string;
}

export interface RnpContinuityBundleV0 {
	bundleId: string;
	context: RnpContextBundleV0;
	createdAt: number;
	messages: RnpMessageV0[];
	protocol: "ryu-node-continuity";
	selection: {
		transcript: RnpTranscriptScopeV0;
		omittedEarlierMessages: boolean;
	};
	source: {
		conversationId: string;
		updatedAt: number;
		checkpointMessageId?: string;
		title?: string;
		agentHint?: string;
	};
	version: 0;
}

export interface RnpExportRequestV0 {
	context?: RnpContextBundleV0;
	ifUpdatedAt?: number;
	includeAgentHint?: boolean;
	transcript: RnpTranscriptScopeV0;
	version: 0;
}

export interface RnpResumeResultV0 {
	conversationId: string;
	imported: {
		messages: number;
		contextItems: number;
	};
	status: "created" | "merged" | "unchanged";
	version: 0;
	warnings: Array<"agent-unavailable" | "earlier-messages-omitted">;
}

export type RnpParseErrorCode =
	| "invalid-json"
	| "unsupported-version"
	| "invalid-shape"
	| "limit-exceeded";

export type RnpParseResult<T> =
	| { ok: true; value: T }
	| {
			ok: false;
			error: {
				code: RnpParseErrorCode;
				path?: string;
				message: string;
			};
	  };

export interface RnpNodeCandidate {
	name: string;
	url: string;
}

export type RnpNodeResolution<T extends RnpNodeCandidate> =
	| { kind: "ready"; node: T }
	| { kind: "blocked"; reason: "node-not-configured" | "invalid-node-url" };

const HTTP_NODE_URL = /^(https?):\/\/([^/?#]+)(\/[^?#]*)?$/i;
const CONTEXT_SOURCES: RnpContextSourceV0[] = [
	"browser-selection",
	"clip-transcript",
	"composer",
	"manual",
	"recent-activity",
	"other",
];

function isContextSource(value: unknown): value is RnpContextSourceV0 {
	return (
		typeof value === "string" && CONTEXT_SOURCES.some((item) => item === value)
	);
}

function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function hasControlCharacters(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (
			codePoint !== undefined &&
			(codePoint <= 31 || (codePoint >= 127 && codePoint <= 159))
		) {
			return true;
		}
	}
	return false;
}

function failure<T>(
	code: RnpParseErrorCode,
	message: string,
	path?: string
): RnpParseResult<T> {
	return { ok: false, error: { code, message, ...(path ? { path } : {}) } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validBoundedString(
	value: unknown,
	maxBytes: number,
	allowEmpty = false
): value is string {
	return (
		typeof value === "string" &&
		(allowEmpty || value.trim().length > 0) &&
		!hasControlCharacters(value) &&
		utf8Bytes(value) <= maxBytes
	);
}

function validTimestamp(value: unknown): value is number {
	return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function parseTranscriptScope(value: unknown): RnpTranscriptScopeV0 | null {
	if (!isRecord(value)) {
		return null;
	}
	if (value.mode === "all") {
		return { mode: "all" };
	}
	if (
		value.mode === "recent" &&
		typeof value.maxMessages === "number" &&
		Number.isInteger(value.maxMessages) &&
		value.maxMessages > 0 &&
		value.maxMessages <= RNP_CONTINUITY_LIMITS.maxMessages
	) {
		return { mode: "recent", maxMessages: value.maxMessages };
	}
	return null;
}

function parseContextItem(
	value: unknown,
	index: number
): RnpParseResult<RnpContextTextV0> {
	const path = `context.items[${index}]`;
	if (!isRecord(value) || value.kind !== "text") {
		return failure("invalid-shape", "Expected a text context item", path);
	}
	if (!validBoundedString(value.id, RNP_CONTINUITY_LIMITS.maxIdBytes)) {
		return failure(
			"limit-exceeded",
			"Context id is missing or too long",
			`${path}.id`
		);
	}
	if (!validBoundedString(value.label, RNP_CONTINUITY_LIMITS.maxLabelBytes)) {
		return failure(
			"limit-exceeded",
			"Context label is missing or too long",
			`${path}.label`
		);
	}
	if (value.mediaType !== "text/plain" && value.mediaType !== "text/markdown") {
		return failure(
			"invalid-shape",
			"Unsupported context media type",
			`${path}.mediaType`
		);
	}
	if (
		typeof value.text !== "string" ||
		utf8Bytes(value.text) > RNP_CONTINUITY_LIMITS.maxContextItemBytes
	) {
		return failure(
			"limit-exceeded",
			"Context text is too large",
			`${path}.text`
		);
	}
	if (!(isRecord(value.source) && isContextSource(value.source.kind))) {
		return failure(
			"invalid-shape",
			"Unsupported context source",
			`${path}.source.kind`
		);
	}
	const sourceLabel = value.source.label;
	if (
		sourceLabel !== undefined &&
		!validBoundedString(sourceLabel, RNP_CONTINUITY_LIMITS.maxLabelBytes)
	) {
		return failure(
			"limit-exceeded",
			"Context source label is too long",
			`${path}.source.label`
		);
	}
	return {
		ok: true,
		value: {
			id: value.id,
			kind: "text",
			label: value.label,
			mediaType: value.mediaType,
			text: value.text,
			source: {
				kind: value.source.kind,
				...(sourceLabel ? { label: sourceLabel } : {}),
			},
		},
	};
}

function parseContextBundle(
	value: unknown
): RnpParseResult<RnpContextBundleV0> {
	if (!(isRecord(value) && value.version === RNP_CONTINUITY_VERSION)) {
		return failure("invalid-shape", "Invalid context bundle", "context");
	}
	if (!Array.isArray(value.items)) {
		return failure(
			"invalid-shape",
			"Context items must be an array",
			"context.items"
		);
	}
	if (value.items.length > RNP_CONTINUITY_LIMITS.maxContextItems) {
		return failure("limit-exceeded", "Too many context items", "context.items");
	}
	const items: RnpContextTextV0[] = [];
	const ids = new Set<string>();
	let totalBytes = 0;
	for (const [index, item] of value.items.entries()) {
		const parsed = parseContextItem(item, index);
		if (!parsed.ok) {
			return parsed;
		}
		if (ids.has(parsed.value.id)) {
			return failure(
				"invalid-shape",
				"Context ids must be unique",
				`context.items[${index}].id`
			);
		}
		ids.add(parsed.value.id);
		totalBytes += utf8Bytes(parsed.value.text);
		if (totalBytes > RNP_CONTINUITY_LIMITS.maxContextBytes) {
			return failure(
				"limit-exceeded",
				"Context bundle is too large",
				"context.items"
			);
		}
		items.push(parsed.value);
	}
	return { ok: true, value: { version: 0, items } };
}

function parseMessage(
	value: unknown,
	index: number
): RnpParseResult<RnpMessageV0> {
	const path = `messages[${index}]`;
	if (!isRecord(value)) {
		return failure("invalid-shape", "Expected a message object", path);
	}
	if (!validBoundedString(value.sourceId, RNP_CONTINUITY_LIMITS.maxIdBytes)) {
		return failure(
			"limit-exceeded",
			"Message id is missing or too long",
			`${path}.sourceId`
		);
	}
	if (value.sourceId.startsWith("rnp-context-")) {
		return failure(
			"invalid-shape",
			"Message id uses the reserved context namespace",
			`${path}.sourceId`
		);
	}
	if (value.role !== "user" && value.role !== "assistant") {
		return failure(
			"invalid-shape",
			"Only user and assistant text can move",
			`${path}.role`
		);
	}
	if (
		typeof value.text !== "string" ||
		utf8Bytes(value.text) > RNP_CONTINUITY_LIMITS.maxMessageBytes
	) {
		return failure(
			"limit-exceeded",
			"Message text is too large",
			`${path}.text`
		);
	}
	if (!validTimestamp(value.createdAt)) {
		return failure(
			"invalid-shape",
			"Message timestamp is invalid",
			`${path}.createdAt`
		);
	}
	return {
		ok: true,
		value: {
			sourceId: value.sourceId,
			role: value.role,
			text: value.text,
			createdAt: value.createdAt,
		},
	};
}

function parseUnknownInput(input: string | unknown): RnpParseResult<unknown> {
	if (typeof input !== "string") {
		return { ok: true, value: input };
	}
	if (utf8Bytes(input) > RNP_CONTINUITY_LIMITS.maxWireBytes) {
		return failure(
			"limit-exceeded",
			"Continuity bundle exceeds the wire limit"
		);
	}
	try {
		return { ok: true, value: JSON.parse(input) };
	} catch {
		return failure("invalid-json", "Continuity bundle is not valid JSON");
	}
}

export function parseRnpContinuityBundle(
	input: string | unknown
): RnpParseResult<RnpContinuityBundleV0> {
	const decoded = parseUnknownInput(input);
	if (!decoded.ok) {
		return decoded;
	}
	const value = decoded.value;
	if (!isRecord(value) || value.protocol !== RNP_CONTINUITY_PROTOCOL) {
		return failure(
			"invalid-shape",
			"Unsupported continuity protocol",
			"protocol"
		);
	}
	if (value.version !== RNP_CONTINUITY_VERSION) {
		return failure(
			"unsupported-version",
			"Unsupported continuity version",
			"version"
		);
	}
	if (!validBoundedString(value.bundleId, RNP_CONTINUITY_LIMITS.maxIdBytes)) {
		return failure(
			"limit-exceeded",
			"Bundle id is missing or too long",
			"bundleId"
		);
	}
	if (!validTimestamp(value.createdAt)) {
		return failure("invalid-shape", "Bundle timestamp is invalid", "createdAt");
	}
	if (!isRecord(value.source)) {
		return failure("invalid-shape", "Bundle source is missing", "source");
	}
	if (
		!validBoundedString(
			value.source.conversationId,
			RNP_CONTINUITY_LIMITS.maxIdBytes
		)
	) {
		return failure(
			"limit-exceeded",
			"Conversation id is missing or too long",
			"source.conversationId"
		);
	}
	if (!validTimestamp(value.source.updatedAt)) {
		return failure(
			"invalid-shape",
			"Source timestamp is invalid",
			"source.updatedAt"
		);
	}
	const checkpointMessageId = value.source.checkpointMessageId;
	const agentHint = value.source.agentHint;
	for (const [field, fieldValue] of [
		["checkpointMessageId", checkpointMessageId],
		["agentHint", agentHint],
	] as const) {
		if (
			fieldValue !== undefined &&
			!validBoundedString(fieldValue, RNP_CONTINUITY_LIMITS.maxIdBytes)
		) {
			return failure(
				"limit-exceeded",
				`Source ${field} is invalid`,
				`source.${field}`
			);
		}
	}
	const title = value.source.title;
	if (
		title !== undefined &&
		!validBoundedString(title, RNP_CONTINUITY_LIMITS.maxLabelBytes)
	) {
		return failure(
			"limit-exceeded",
			"Source title is too long",
			"source.title"
		);
	}
	if (!isRecord(value.selection)) {
		return failure("invalid-shape", "Selection is missing", "selection");
	}
	const transcript = parseTranscriptScope(value.selection.transcript);
	if (
		!transcript ||
		typeof value.selection.omittedEarlierMessages !== "boolean"
	) {
		return failure(
			"invalid-shape",
			"Transcript selection is invalid",
			"selection"
		);
	}
	if (!Array.isArray(value.messages)) {
		return failure("invalid-shape", "Messages must be an array", "messages");
	}
	if (value.messages.length > RNP_CONTINUITY_LIMITS.maxMessages) {
		return failure("limit-exceeded", "Too many messages", "messages");
	}
	const messages: RnpMessageV0[] = [];
	const messageIds = new Set<string>();
	let transcriptBytes = 0;
	for (const [index, message] of value.messages.entries()) {
		const parsed = parseMessage(message, index);
		if (!parsed.ok) {
			return parsed;
		}
		if (messageIds.has(parsed.value.sourceId)) {
			return failure(
				"invalid-shape",
				"Message ids must be unique",
				`messages[${index}].sourceId`
			);
		}
		messageIds.add(parsed.value.sourceId);
		transcriptBytes += utf8Bytes(parsed.value.text);
		if (transcriptBytes > RNP_CONTINUITY_LIMITS.maxTranscriptBytes) {
			return failure("limit-exceeded", "Transcript is too large", "messages");
		}
		messages.push(parsed.value);
	}
	const context = parseContextBundle(value.context);
	if (!context.ok) {
		return context;
	}
	const source = {
		conversationId: value.source.conversationId,
		updatedAt: value.source.updatedAt,
		...(typeof checkpointMessageId === "string" ? { checkpointMessageId } : {}),
		...(title ? { title } : {}),
		...(typeof agentHint === "string" ? { agentHint } : {}),
	};
	const bundle: RnpContinuityBundleV0 = {
		protocol: RNP_CONTINUITY_PROTOCOL,
		version: 0,
		bundleId: value.bundleId,
		createdAt: value.createdAt,
		source,
		selection: {
			transcript,
			omittedEarlierMessages: value.selection.omittedEarlierMessages,
		},
		messages,
		context: context.value,
	};
	const encoded = JSON.stringify(bundle);
	if (utf8Bytes(encoded) > RNP_CONTINUITY_LIMITS.maxWireBytes) {
		return failure(
			"limit-exceeded",
			"Continuity bundle exceeds the wire limit"
		);
	}
	return { ok: true, value: bundle };
}

export function createRnpContextBundle(input: {
	items: RnpContextTextV0[];
}): RnpContextBundleV0 {
	const parsed = parseContextBundle({ version: 0, items: input.items });
	if (!parsed.ok) {
		throw new Error(parsed.error.message);
	}
	return parsed.value;
}

export function serializeRnpContinuityBundle(
	bundle: RnpContinuityBundleV0
): string {
	const parsed = parseRnpContinuityBundle(bundle);
	if (!parsed.ok) {
		throw new Error(parsed.error.message);
	}
	return JSON.stringify(parsed.value);
}

/** Normalize a node URL carried as routing metadata. It is never a credential. */
export function normalizeRnpNodeUrl(raw: string): string | null {
	const value = raw.trim();
	if (
		!validBoundedString(value, RNP_CONTINUITY_LIMITS.maxNodeUrlBytes) ||
		value.includes("?") ||
		value.includes("#")
	) {
		return null;
	}
	const match = HTTP_NODE_URL.exec(value);
	if (!match) {
		return null;
	}
	const authority = match[2];
	if (!authority || authority.includes("@")) {
		return null;
	}
	const closingBracket = authority.indexOf("]");
	if (authority.startsWith("[") && closingBracket <= 1) {
		return null;
	}
	const hostname = authority.startsWith("[")
		? authority.slice(1, closingBracket)
		: authority.split(":")[0];
	const loopback =
		hostname === "localhost" ||
		hostname?.endsWith(".localhost") ||
		hostname === "::1" ||
		hostname?.startsWith("127.");
	if (match[1]?.toLowerCase() === "http" && !loopback) {
		return null;
	}
	return value.replace(/\/+$/, "");
}

/** Resolve routing metadata only against nodes the user already configured. */
export function resolveRnpNode<T extends RnpNodeCandidate>(
	rawUrl: string,
	configuredNodes: readonly T[]
): RnpNodeResolution<T> {
	const normalized = normalizeRnpNodeUrl(rawUrl);
	if (!normalized) {
		return { kind: "blocked", reason: "invalid-node-url" };
	}
	const node = configuredNodes.find(
		(candidate) => normalizeRnpNodeUrl(candidate.url) === normalized
	);
	return node
		? { kind: "ready", node }
		: { kind: "blocked", reason: "node-not-configured" };
}
