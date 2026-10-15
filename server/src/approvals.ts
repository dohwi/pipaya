import type { EventBus } from "./events.ts";

export interface ApprovalRequest {
	sessionId: string;
	toolCallId: string;
	toolName: string;
	args: unknown;
	requestedAt: number;
}

export interface ApprovalDecision {
	approved: boolean;
	reason?: string;
}

interface Pending {
	request: ApprovalRequest;
	resolve: (d: ApprovalDecision) => void;
	cleanup: () => void;
}

/** Holds tool calls that are waiting for a human decision. */
export class ApprovalManager {
	private pending = new Map<string, Pending>();

	constructor(
		private bus: EventBus,
		private timeoutMs: number,
	) {}

	private key = (sessionId: string, toolCallId: string) => `${sessionId}:${toolCallId}`;

	request(req: Omit<ApprovalRequest, "requestedAt">, signal?: AbortSignal): Promise<ApprovalDecision> {
		const request: ApprovalRequest = { ...req, requestedAt: Date.now() };
		const key = this.key(req.sessionId, req.toolCallId);

		return new Promise<ApprovalDecision>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (decision: ApprovalDecision, source: string) => {
				if (!this.pending.has(key)) return;
				this.pending.get(key)?.cleanup();
				this.pending.delete(key);
				this.bus.publish(req.sessionId, "approval_resolved", {
					toolCallId: req.toolCallId,
					toolName: req.toolName,
					approved: decision.approved,
					reason: decision.reason,
					source,
				});
				resolve(decision);
			};
			const onAbort = () => finish({ approved: false, reason: "Run aborted" }, "abort");
			if (this.timeoutMs > 0) {
				timer = setTimeout(() => finish({ approved: false, reason: "Approval timed out" }, "timeout"), this.timeoutMs);
			}
			signal?.addEventListener("abort", onAbort, { once: true });

			this.pending.set(key, {
				request,
				resolve: (d) => finish(d, "user"),
				cleanup: () => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
				},
			});
			this.bus.publish(req.sessionId, "approval_requested", request);
			if (signal?.aborted) onAbort();
		});
	}

	/** Returns false when there is no such pending approval (already resolved or expired). */
	decide(sessionId: string, toolCallId: string, decision: ApprovalDecision): boolean {
		const entry = this.pending.get(this.key(sessionId, toolCallId));
		if (!entry) return false;
		entry.resolve(decision);
		return true;
	}

	list(sessionId?: string): ApprovalRequest[] {
		return [...this.pending.values()].map((p) => p.request).filter((r) => !sessionId || r.sessionId === sessionId);
	}
}
