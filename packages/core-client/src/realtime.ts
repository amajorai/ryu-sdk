// packages/core-client/src/realtime.ts
//
// Shared client for Core's room-keyed realtime gateway (`GET /api/realtime/ws`,
// Phase 1/3 of the multi-user collaboration epic). One transport for every
// surface: desktop (Tauri webview), mobile (React Native), CLI — all reuse this
// verbatim. It speaks the gateway's wire protocol exactly:
//
//   Client -> server (the FIRST frame MUST be `join`):
//     - join:     text `{ type: "join", room_id, kind, app_id? }` (kind: conversation|document|application)
//     - presence: text `{ type: "presence", data }`   (the server stamps member_id)
//     - ping:     text `{ type: "ping" }`             (server replies `{type:"pong"}`)
//     - leave:    text `{ type: "leave" }`
//     - doc-sync: BINARY `<1-byte tag><payload>`       (CRDT, document rooms only)
//
//   Server -> client:
//     - join_ack: text `{ type: "join_ack", room_id, member_id, access, presence }`
//     - ping:     text `{ type: "ping" }` (client replies `{type:"pong"}`)
//     - events:   text `{ channel: "events",   data }` (e.g. a new chat message)
//     - presence: text `{ channel: "presence", data }` (awareness deltas / leaves)
//     - doc-sync: BINARY `<1-byte tag><payload>`
//
// Browsers cannot set headers on a WS upgrade, so the node-admittance token and
// the optional user-identity JWT ride query params (`?token=` / `?jwt=`), exactly
// as the gateway expects. Uses the global `WebSocket` (a web standard present in
// browsers, React Native, and Bun/Node) so this stays platform-agnostic like the
// rest of `core-client`.

import { type ApiTarget, apiUrl } from "./client.ts";

/** Which resource a room maps to. Mirrors the gateway's `RoomKind`. */
export type RealtimeKind = "conversation" | "document" | "application";

/** A named event published by an application room. */
export interface RealtimeNamedEvent {
	data: unknown;
	name: string;
}

/** Encode the application-room event control frame. */
export function encodeRealtimeEvent(event: RealtimeNamedEvent): string {
	return JSON.stringify({ type: "event", event: event.name, data: event.data });
}

/** Decode an application-room event control frame, or `null` for another frame. */
export function decodeRealtimeEvent(raw: string): RealtimeNamedEvent | null {
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null) {
			return null;
		}
		const frame = value as Record<string, unknown>;
		return frame.type === "event" && typeof frame.event === "string"
			? { name: frame.event, data: frame.data }
			: null;
	} catch {
		return null;
	}
}

// ── DocSync wire framing (1-byte tag, mirrors `collab::DocSyncMessage`) ──────

/** `SyncStep1`: "here is my state vector, send me the diff." */
export const DOC_SYNC_STEP1 = 0x00;
/** `SyncStep2`: the diff update answering a peer's `SyncStep1`. */
export const DOC_SYNC_STEP2 = 0x01;
/** `Update`: an incremental Yjs update. */
export const DOC_SYNC_UPDATE = 0x02;
/**
 * `Awareness`: an opaque Yjs awareness update (cursors/selections/presence for a
 * document). Relayed to the room's other members but never applied to the doc or
 * persisted by the gateway.
 */
export const DOC_SYNC_AWARENESS = 0x03;

/** The four DocSync message tags. */
export type DocSyncTag =
	| typeof DOC_SYNC_STEP1
	| typeof DOC_SYNC_STEP2
	| typeof DOC_SYNC_UPDATE
	| typeof DOC_SYNC_AWARENESS;

/** A decoded DocSync frame: a tag plus the opaque Yjs payload bytes. */
export interface DocSyncMessage {
	payload: Uint8Array;
	tag: DocSyncTag;
}

const DOC_SYNC_TAGS: readonly number[] = [
	DOC_SYNC_STEP1,
	DOC_SYNC_STEP2,
	DOC_SYNC_UPDATE,
	DOC_SYNC_AWARENESS,
];

/** Encode a DocSync message to its wire bytes (`<tag><payload>`). */
export function encodeDocSync(message: DocSyncMessage): Uint8Array {
	const out = new Uint8Array(message.payload.length + 1);
	out[0] = message.tag;
	out.set(message.payload, 1);
	return out;
}

/**
 * Decode DocSync wire bytes. Returns `null` for an empty buffer or an unknown
 * tag (fail-closed, mirroring the gateway's classifier) so the caller drops the
 * frame rather than misinterpreting it.
 */
export function decodeDocSync(bytes: Uint8Array): DocSyncMessage | null {
	if (bytes.length < 1) {
		return null;
	}
	const tag = bytes[0];
	if (tag === undefined || !DOC_SYNC_TAGS.includes(tag)) {
		return null;
	}
	return { tag: tag as DocSyncTag, payload: bytes.slice(1) };
}

// ── Connection ───────────────────────────────────────────────────────────────

/** The gateway's `join_ack`, normalized to camelCase. */
export interface JoinAck {
	/** Whether this connection may mutate the resource, or is a read-only viewer. */
	access: "read" | "write";
	/** Caller-generated correlation id echoed by Core. This is not an auth id. */
	clientId: string;
	/** Authoritative CRDT generation; zero for non-document rooms. */
	documentEpoch: number;
	/** Whether the server granted THIS connection the one-shot right to seed a
	 * brand-new empty room from its local `source`. Exactly one client per empty
	 * room wins this (server-arbitrated), so concurrent first-opens cannot both seed
	 * and duplicate the document body / columns. A read-only or late joiner is
	 * `false`. */
	maySeed: boolean;
	memberId: string;
	/** Current active-room presence roster, included for late joiners. */
	presence: unknown[];
	roomId: string;
}

export interface ResyncRequired {
	/** Number of bounded broadcast frames skipped, when Core can report it. */
	dropped?: number;
	reason: string;
}

/** Callbacks for the lifecycle + each inbound frame kind. All optional. */
export interface RealtimeHandlers {
	onClose?: (event: CloseEvent) => void;
	/** A binary DocSync frame (document rooms). Feed this to the CRDT provider. */
	onDocSync?: (message: DocSyncMessage) => void;
	/** The authoritative document was restored and its old CRDT epoch is fenced. */
	onDocumentReset?: (epoch: number) => void;
	onError?: (event: Event) => void;
	/** A `{ channel: "events" }` payload — e.g. a new chat message `data`. */
	onEvent?: (data: unknown) => void;
	/** The resolved access level for this connection, sent right after join. */
	onJoinAck?: (ack: JoinAck) => void;
	/** A named event from an application room. */
	onNamedEvent?: (event: RealtimeNamedEvent) => void;
	onOpen?: () => void;
	/** A `{ channel: "presence" }` payload — an awareness delta or leave. */
	onPresence?: (data: unknown) => void;
	/** The bounded room feed skipped state. Reload a snapshot or restart CRDT sync. */
	onResyncRequired?: (notice: ResyncRequired) => void;
}

export interface RealtimeOptions {
	/** Required when `kind` is `application`; never sent by the host bridge to the iframe. */
	appId?: string;
	/** Stable for this mounted client and shared with related HTTP mutations. */
	clientId?: string;
	handlers?: RealtimeHandlers;
	/** The user-identity JWT (Better Auth, EdDSA). Omit for an anonymous join. */
	jwt?: string | null;
	kind: RealtimeKind;
	roomId: string;
}

/** Build the `ws(s)://…/api/realtime/ws?token=&jwt=` URL from a node target. */
export function realtimeWsUrl(
	target: ApiTarget,
	options: RealtimeOptions
): string {
	const url = new URL(apiUrl(target, "/api/realtime/ws"));
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	if (target.token) {
		url.searchParams.set("token", target.token);
	}
	if (options.jwt) {
		url.searchParams.set("jwt", options.jwt);
	}
	return url.toString();
}

/**
 * A single room connection. Construct, then call {@link connect}. The first frame
 * sent on open is always the `join` control frame; thereafter the caller pushes
 * presence / doc-sync and receives frames via the handlers.
 *
 * Reconnection is intentionally left to the caller (a surface knows when a node
 * is reachable and how to resync a CRDT doc), so this class stays a thin, honest
 * mapping over one socket.
 */
export class RealtimeConnection {
	private socket: WebSocket | null = null;
	private hasPresence = false;
	private lastPresence: unknown;
	private keepalive: ReturnType<typeof setInterval> | null = null;
	private presenceHeartbeat: ReturnType<typeof setInterval> | null = null;
	private readonly url: string;
	private readonly options: RealtimeOptions;
	readonly clientId: string;

	constructor(target: ApiTarget, options: RealtimeOptions) {
		this.options = options;
		this.clientId = options.clientId ?? createRealtimeClientId();
		this.url = realtimeWsUrl(target, options);
	}

	/** Open the socket and send the `join` frame on connect. Idempotent-ish: a
	 * second call while already open is a no-op. */
	connect(): void {
		if (this.socket) {
			return;
		}
		const socket = new WebSocket(this.url);
		socket.binaryType = "arraybuffer";
		this.socket = socket;
		const { handlers } = this.options;

		socket.onopen = () => {
			// The gateway REQUIRES the join frame first, and it must carry
			// `type: "join"` (the handshake in `realtime_ws.rs` gates on it, like
			// every other control frame). Anything else closes the socket (1003).
			this.sendText({
				type: "join",
				room_id: this.options.roomId,
				kind: this.options.kind,
				client_id: this.clientId,
				...(this.options.kind === "application" && this.options.appId
					? { app_id: this.options.appId }
					: {}),
			});
			this.startKeepalive();
			handlers?.onOpen?.();
		};
		socket.onmessage = (event) => this.dispatch(event);
		socket.onclose = (event) => {
			this.clearKeepalive();
			this.clearPresenceHeartbeat();
			if (this.socket === socket) {
				this.socket = null;
			}
			handlers?.onClose?.(event);
		};
		socket.onerror = (event) => handlers?.onError?.(event);
	}

	/** Publish this client's awareness payload (cursor/typing/name/etc.). The
	 * server stamps the member id before broadcasting. */
	publishPresence(data: unknown): void {
		this.hasPresence = true;
		this.lastPresence = data;
		this.sendText({ type: "presence", data });
		if (this.presenceHeartbeat === null) {
			this.presenceHeartbeat = setInterval(() => {
				if (this.hasPresence) {
					this.sendText({ type: "presence", data: this.lastPresence });
				}
			}, 10_000);
		}
	}

	/** Send a DocSync frame (CRDT sync/update) for a document room. */
	sendDocSync(message: DocSyncMessage): void {
		this.sendBinary(encodeDocSync(message));
	}

	/** Publish a named event to an application room. */
	sendEvent(name: string, data: unknown): void {
		this.sendText(encodeRealtimeEvent({ name, data }));
	}

	/** Liveness ping; the server replies with a `pong` (ignored by the dispatcher). */
	ping(): void {
		this.sendText({ type: "ping" });
	}

	/** Send an explicit `leave` (if still open) and close the socket. */
	close(): void {
		this.clearKeepalive();
		this.clearPresenceHeartbeat();
		if (this.socket?.readyState === WEBSOCKET_OPEN) {
			this.sendText({ type: "leave" });
		}
		this.socket?.close();
		this.socket = null;
	}

	private startKeepalive(): void {
		if (this.keepalive !== null) {
			return;
		}
		this.keepalive = setInterval(() => {
			this.ping();
		}, 10_000);
	}

	private clearKeepalive(): void {
		if (this.keepalive !== null) {
			clearInterval(this.keepalive);
			this.keepalive = null;
		}
	}

	private clearPresenceHeartbeat(): void {
		if (this.presenceHeartbeat !== null) {
			clearInterval(this.presenceHeartbeat);
			this.presenceHeartbeat = null;
		}
	}

	private dispatch(event: MessageEvent): void {
		const handlers = this.options.handlers;
		if (typeof event.data === "string") {
			this.dispatchText(event.data, handlers);
			return;
		}
		if (event.data instanceof ArrayBuffer) {
			const message = decodeDocSync(new Uint8Array(event.data));
			if (message) {
				handlers?.onDocSync?.(message);
			}
		}
	}

	private dispatchText(
		raw: string,
		handlers: RealtimeHandlers | undefined
	): void {
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			// Malformed frame; the next one self-heals the feed.
			return;
		}
		if (typeof value !== "object" || value === null) {
			return;
		}
		const frame = value as Record<string, unknown>;
		if (frame.type === "ping") {
			this.sendText({ type: "pong" });
			return;
		}
		if (frame.type === "join_ack") {
			handlers?.onJoinAck?.({
				access: frame.access === "write" ? "write" : "read",
				maySeed: frame.may_seed === true,
				clientId: String(frame.client_id ?? this.clientId),
				documentEpoch:
					typeof frame.document_epoch === "number" ? frame.document_epoch : 0,
				memberId: String(frame.member_id ?? ""),
				presence: Array.isArray(frame.presence) ? frame.presence : [],
				roomId: String(frame.room_id ?? ""),
			});
			return;
		}
		if (frame.type === "resync_required") {
			handlers?.onResyncRequired?.({
				dropped:
					typeof frame.dropped === "number" &&
					Number.isSafeInteger(frame.dropped)
						? frame.dropped
						: undefined,
				reason:
					typeof frame.reason === "string" ? frame.reason : "room-state-gap",
			});
			return;
		}
		if (frame.type === "document_reset") {
			if (
				typeof frame.epoch === "number" &&
				Number.isSafeInteger(frame.epoch)
			) {
				handlers?.onDocumentReset?.(frame.epoch);
			}
			return;
		}
		if (frame.channel === "events") {
			handlers?.onEvent?.(frame.data);
			if (typeof frame.event === "string") {
				handlers?.onNamedEvent?.({ name: frame.event, data: frame.data });
			}
			return;
		}
		if (frame.channel === "presence") {
			handlers?.onPresence?.(frame.data);
		}
		// `pong` and any unknown control frame are ignored (forward-compatible).
	}

	private sendText(payload: unknown): void {
		if (this.socket?.readyState === WEBSOCKET_OPEN) {
			this.socket.send(JSON.stringify(payload));
		}
	}

	private sendBinary(bytes: Uint8Array): void {
		if (this.socket?.readyState === WEBSOCKET_OPEN) {
			this.socket.send(bytes);
		}
	}
}

/** `WebSocket.OPEN` as a free constant so the class needs no instance to read it. */
const WEBSOCKET_OPEN = 1;

/** Create an opaque per-client correlation id without making it an auth input. */
export function createRealtimeClientId(): string {
	const randomUuid = globalThis.crypto?.randomUUID?.();
	if (randomUuid) {
		return randomUuid;
	}
	// Older React Native runtimes may not expose randomUUID. The server accepts
	// only UUIDs, so format 16 random bytes when getRandomValues is available.
	const bytes = new Uint8Array(16);
	globalThis.crypto?.getRandomValues?.(bytes);
	if (bytes.some((value) => value !== 0)) {
		bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
		bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
		const hex = Array.from(bytes, (value) =>
			value.toString(16).padStart(2, "0")
		);
		return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
	}
	// This value is correlation metadata, never an auth input. A UUID-shaped
	// Math.random fallback keeps older React Native runtimes on the same echo-
	// suppression contract while the signed user JWT continues to own identity.
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Math.floor(Math.random() * 256);
	}
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
