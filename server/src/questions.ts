import type { EventBus } from "./events.ts";

export interface QuestionRequest {
	sessionId: string;
	toolCallId: string;
	question: string;
	options?: string[];
	allowFreeText: boolean;
	requestedAt: number;
}

export interface QuestionAnswer {
	answer: string;
}

export type QuestionOutcome =
	| { status: "answered"; answer: string }
	| { status: "abort" };

interface Pending {
	request: QuestionRequest;
	options: string[] | undefined;
	allowFreeText: boolean;
	resolve: (o: QuestionOutcome, source: "user" | "abort") => void;
	cleanup: () => void;
}

export type DecideResult = "ok" | "not_found" | "invalid";

/**
 * Holds `ask_user` tool calls that are waiting for a human answer. A question waits until it is answered or the run is
 * aborted: nothing is spent while it waits, so there is no time limit.
 */
export class QuestionManager {
	private pending = new Map<string, Pending>();

	constructor(private bus: EventBus) {}

	private key = (sessionId: string, toolCallId: string) => `${sessionId}:${toolCallId}`;

	ask(req: Omit<QuestionRequest, "requestedAt">, signal?: AbortSignal): Promise<QuestionOutcome> {
		const request: QuestionRequest = { ...req, requestedAt: Date.now() };
		const key = this.key(req.sessionId, req.toolCallId);

		return new Promise<QuestionOutcome>((resolve) => {
			const finish = (outcome: QuestionOutcome, source: "user" | "abort") => {
				const entry = this.pending.get(key);
				if (!entry) return;
				entry.cleanup();
				this.pending.delete(key);
				this.bus.publish(req.sessionId, "question_resolved", {
					toolCallId: req.toolCallId,
					toolName: "ask_user",
					answered: outcome.status === "answered",
					source,
				});
				resolve(outcome);
			};
			const onAbort = () => finish({ status: "abort" }, "abort");
			signal?.addEventListener("abort", onAbort, { once: true });

			this.pending.set(key, {
				request,
				options: req.options,
				allowFreeText: req.allowFreeText,
				resolve: finish,
				cleanup: () => signal?.removeEventListener("abort", onAbort),
			});
			this.bus.publish(req.sessionId, "question_requested", request);
			if (signal?.aborted) onAbort();
		});
	}

	/**
	 * "not_found": nothing is waiting (already answered or the run was aborted).
	 * "invalid": the answer is empty, or is not one of the options when free text is not allowed.
	 */
	answer(sessionId: string, toolCallId: string, a: QuestionAnswer): DecideResult {
		const entry = this.pending.get(this.key(sessionId, toolCallId));
		if (!entry) return "not_found";
		const answer = a.answer.trim();
		if (!answer) return "invalid";
		if (!entry.allowFreeText && entry.options?.length && !entry.options.includes(answer)) return "invalid";
		entry.resolve({ status: "answered", answer }, "user");
		return "ok";
	}

	list(sessionId?: string): QuestionRequest[] {
		return [...this.pending.values()].map((p) => p.request).filter((r) => !sessionId || r.sessionId === sessionId);
	}
}
