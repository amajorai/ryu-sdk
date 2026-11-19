/** Error categories, matching Core's A2A `ClientError` variants. */
export type A2AErrorCode =
	| "cross_origin_redirect"
	| "event_too_large"
	| "http_status"
	| "invalid_agent_card"
	| "invalid_content_type"
	| "invalid_credential"
	| "invalid_protocol"
	| "json_rpc"
	| "no_compatible_interface"
	| "response_too_large"
	| "too_many_redirects"
	| "transport";

/** Details attached to some error categories. */
export interface A2AErrorDetails {
	/** JSON-RPC error code (`json_rpc`). */
	rpcCode?: number;
	/** HTTP status (`http_status`). */
	status?: number;
}

/** An A2A request, response, or Agent Card failed. */
export class A2AError extends Error {
	readonly code: A2AErrorCode;
	readonly rpcCode?: number;
	readonly status?: number;

	constructor(code: A2AErrorCode, message: string, details?: A2AErrorDetails) {
		super(`[ryu-sdk] ${message}`);
		this.name = "A2AError";
		this.code = code;
		this.rpcCode = details?.rpcCode;
		this.status = details?.status;
	}
}

/** Truncate peer-supplied detail text to 500 characters, like Core. */
export function truncateDetail(value: string): string {
	const characters = [...value];
	return characters.length > 500
		? `${characters.slice(0, 500).join("")}…`
		: value;
}
