/**
 * Bounded Server-Sent Events decoder for A2A streaming responses.
 *
 * Mirrors Core's decoder (`crates/core/a2a/src/client.rs`): `data:` lines are
 * joined with `\n` into one event, a blank line dispatches it, comment lines
 * are ignored, and both a single line and a single event are size-bounded so
 * a hostile peer cannot grow memory without limit.
 */

import { A2AError } from "./errors.ts";

const LF = 0x0a;
const CR = 0x0d;
const LINE_SLACK_BYTES = 1024;
const SPACE = 0x20;
/** The bytes of `data:`. */
const DATA_PREFIX = [0x64, 0x61, 0x74, 0x61, 0x3a];

/** Incremental decoder: feed byte chunks, receive complete event payloads. */
export class SseDecoder {
	private pending: Uint8Array = new Uint8Array(0);
	private dataLines: string[] = [];
	private eventBytes = 0;
	private readonly maxEventBytes: number;
	private readonly decoder = new TextDecoder("utf-8", { fatal: true });

	constructor(maxEventBytes: number) {
		this.maxEventBytes = maxEventBytes;
	}

	/** Consume one chunk and return every event it completed. */
	push(chunk: Uint8Array): string[] {
		const events: string[] = [];
		let start = 0;
		for (let index = 0; index < chunk.length; index++) {
			if (chunk[index] !== LF) {
				continue;
			}
			const line = this.append(chunk.subarray(start, index));
			this.pending = new Uint8Array(0);
			this.processLine(
				line.at(-1) === CR ? line.subarray(0, -1) : line,
				events
			);
			start = index + 1;
		}
		this.pending = this.append(chunk.subarray(start));
		return events;
	}

	/** Flush the final line and any undispatched event at end of stream. */
	finish(): string[] {
		const events: string[] = [];
		if (this.pending.length > 0) {
			const line = this.pending;
			this.pending = new Uint8Array(0);
			this.processLine(line, events);
		}
		this.dispatch(events);
		return events;
	}

	private append(bytes: Uint8Array): Uint8Array {
		const next = new Uint8Array(this.pending.length + bytes.length);
		next.set(this.pending);
		next.set(bytes, this.pending.length);
		if (next.length > this.maxEventBytes + LINE_SLACK_BYTES) {
			throw new A2AError(
				"event_too_large",
				"A2A stream event exceeded the configured size limit"
			);
		}
		return next;
	}

	private processLine(line: Uint8Array, events: string[]) {
		if (line.length === 0) {
			this.dispatch(events);
			return;
		}
		if (!DATA_PREFIX.every((byte, index) => line[index] === byte)) {
			// Comments (`:`) and other fields (`event:`, `id:`) carry no data.
			return;
		}
		let content = line.subarray(DATA_PREFIX.length);
		if (content[0] === SPACE) {
			content = content.subarray(1);
		}
		this.eventBytes += content.length;
		if (this.eventBytes > this.maxEventBytes) {
			throw new A2AError(
				"event_too_large",
				"A2A stream event exceeded the configured size limit"
			);
		}
		let data: string;
		try {
			data = this.decoder.decode(content);
		} catch {
			throw new A2AError("invalid_protocol", "SSE data is not UTF-8");
		}
		this.dataLines.push(data);
	}

	private dispatch(events: string[]) {
		if (this.dataLines.length > 0) {
			events.push(this.dataLines.join("\n"));
			this.dataLines = [];
		}
		this.eventBytes = 0;
	}
}
