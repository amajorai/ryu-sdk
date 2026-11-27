/**
 * Pending human approvals for streamed agent runs.
 *
 * When a streamed agent calls a tool marked `needsApproval`, the loop emits an
 * `approval_requested` event and awaits the agent's approval handler. The
 * server's handler parks that wait here, keyed by the approval id the client
 * just received; `POST /approvals/:id` settles it. A decision that never comes
 * is denied after a timeout, and a client that disconnects denies its own
 * pending approvals, so a run never hangs forever.
 */

import type {
	AgentApprovalDecision,
	AgentApprovalHandler,
} from "../agent/tools.ts";

/** Default time an approval may stay pending before it is denied (10 min). */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

interface Pending {
	readonly resolve: (decision: AgentApprovalDecision) => void;
	readonly runId: string;
	readonly timer: ReturnType<typeof setTimeout>;
}

/** Pending approval decisions shared by every run of one server. */
export class ApprovalRegistry {
	readonly #pending = new Map<string, Pending>();
	readonly #timeoutMs: number;

	constructor(timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS) {
		this.#timeoutMs = timeoutMs;
	}

	/** Approval ids currently waiting for a decision. */
	pendingIds(runId?: string): string[] {
		return [...this.#pending.entries()]
			.filter(([, entry]) => runId === undefined || entry.runId === runId)
			.map(([id]) => id);
	}

	/**
	 * An approval handler for one run. Each request waits until
	 * {@link decide} is called with its id, the timeout passes (denied), or
	 * `signal` aborts (denied).
	 */
	handlerFor(runId: string, signal: AbortSignal): AgentApprovalHandler {
		return (request) =>
			new Promise<AgentApprovalDecision>((resolve) => {
				if (signal.aborted) {
					resolve(false);
					return;
				}
				const settle = (decision: AgentApprovalDecision) => {
					const entry = this.#pending.get(request.approvalId);
					if (!entry) {
						return;
					}
					clearTimeout(entry.timer);
					this.#pending.delete(request.approvalId);
					signal.removeEventListener("abort", onAbort);
					resolve(decision);
				};
				const onAbort = () => settle(false);
				const timer = setTimeout(() => settle(false), this.#timeoutMs);
				this.#pending.set(request.approvalId, {
					resolve: settle,
					runId,
					timer,
				});
				signal.addEventListener("abort", onAbort, { once: true });
			});
	}

	/** Settle a pending approval. Returns false when it is not pending. */
	decide(approvalId: string, decision: AgentApprovalDecision): boolean {
		const entry = this.#pending.get(approvalId);
		if (!entry) {
			return false;
		}
		entry.resolve(decision);
		return true;
	}
}
