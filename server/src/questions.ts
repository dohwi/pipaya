import type { EventBus } from "./events.ts";

/** One question. A request holds several when the agent asks them together (the client shows them as tabs). */
export interface QuestionItem {
	question: string;
	options?: string[];
	/** The option the agent recommends (one of `options`). */
	recommended?: string;
	allowFreeText: boolean;
}

export interface QuestionRequest {
	sessionId: string;
	toolCallId: string;
	/** The first question, or the only one. */
	question: string;
	options?: string[];
	recommended?: string;
	allowFreeText: boolean;
	/** Set when several questions were asked at once; one entry per question, in order. */
	items?: QuestionItem[];
	requestedAt: number;
}

export interface QuestionAnswer {
	answer?: string;
	/** One answer per entry of `items`, in order. */
	answers?: string[];
}

export type QuestionOutcome =
	| { status: "answered"; answer: string }
	| { status: "abort" };

interface Pending {
	request: QuestionRequest;
	resolve: (o: QuestionOutcome, source: "user" | "abort") => void;
	cleanup: () => void;
}

export type DecideResult = "ok" | "not_found" | "invalid";

const valid = (item: QuestionItem, answer: string) =>
	!!answer && (item.allowFreeText || !item.options?.length || item.options.includes(answer));

/**
 * Holds tool calls (any tool using ctx.ask) that are waiting for a human answer. A question waits until it is answered or the run is
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
					answered: outcome.status === "answered",
					source,
				});
				resolve(outcome);
			};
			const onAbort = () => finish({ status: "abort" }, "abort");
			signal?.addEventListener("abort", onAbort, { once: true });

			this.pending.set(key, {
				request,
				resolve: finish,
				cleanup: () => signal?.removeEventListener("abort", onAbort),
			});
			this.bus.publish(req.sessionId, "question_requested", request);
			if (signal?.aborted) onAbort();
		});
	}

	/**
	 * "not_found": nothing is waiting (already answered or the run was aborted).
	 * "invalid": an answer is empty, is not one of the options when free text is not allowed, or the count does not match.
	 */
	answer(sessionId: string, toolCallId: string, a: QuestionAnswer): DecideResult {
		const entry = this.pending.get(this.key(sessionId, toolCallId));
		if (!entry) return "not_found";
		const { request } = entry;

		if (request.items?.length) {
			const answers = a.answers?.map((x) => x.trim());
			if (!answers || answers.length !== request.items.length) return "invalid";
			if (!request.items.every((item, i) => valid(item, answers[i]!))) return "invalid";
			const text = request.items.map((item, i) => `${i + 1}. ${item.question}\n→ ${answers[i]}`).join("\n\n");
			entry.resolve({ status: "answered", answer: text }, "user");
			return "ok";
		}

		const answer = (a.answer ?? "").trim();
		if (!valid(request, answer)) return "invalid";
		entry.resolve({ status: "answered", answer }, "user");
		return "ok";
	}

	list(sessionId?: string): QuestionRequest[] {
		return [...this.pending.values()].map((p) => p.request).filter((r) => !sessionId || r.sessionId === sessionId);
	}
}
