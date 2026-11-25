import type { EventBus } from "./events.ts";

/** One question. A request holds several when the agent asks them together (the client shows them as tabs). */
export interface QuestionItem {
	question: string;
	options?: string[];
	/** The option the agent recommends (one of `options`). */
	recommended?: string;
	/** The options are steps of one ordered scale (low → high): drawn as a ladder instead of buttons. */
	scale?: boolean;
	/** Any number of the options may be picked (at least one); the answer holds them one per line. */
	multiple?: boolean;
	/** One short line per option, same order as `options`, shown under its label. */
	descriptions?: string[];
	allowFreeText: boolean;
}

export interface QuestionRequest {
	sessionId: string;
	toolCallId: string;
	/** The first question, or the only one. */
	question: string;
	options?: string[];
	recommended?: string;
	scale?: boolean;
	multiple?: boolean;
	descriptions?: string[];
	allowFreeText: boolean;
	/** Set when several questions were asked at once; one entry per question, in order. */
	items?: QuestionItem[];
	requestedAt: number;
}

export interface QuestionAnswer {
	/** null: the user left this question to the agent ("알아서 정해 줘"). */
	answer?: string | null;
	/** One answer per entry of `items`, in order; null for a question left to the agent. */
	answers?: (string | null)[];
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

export interface AskQuestionInput {
	question: string;
	options?: string[];
	recommended?: string;
	scale?: boolean;
	multiple?: boolean;
	descriptions?: string[];
	allowFreeText?: boolean;
	items?: (Omit<QuestionItem, "allowFreeText"> & { allowFreeText?: boolean })[];
}

/** Normalizes optional fields on a question request, asks the user, and throws if the wait was aborted. */
export async function askQuestion(
	questions: QuestionManager,
	sessionId: string,
	toolCallId: string,
	req: AskQuestionInput,
	signal?: AbortSignal,
): Promise<string> {
	const items = req.items?.map((q) => ({ ...q, allowFreeText: q.allowFreeText ?? true }));
	const outcome = await questions.ask(
		{
			sessionId,
			toolCallId,
			question: req.question,
			options: req.options,
			...(req.recommended ? { recommended: req.recommended } : {}),
			...(req.scale ? { scale: true } : {}),
			...(req.multiple ? { multiple: true } : {}),
			...(req.descriptions ? { descriptions: req.descriptions } : {}),
			allowFreeText: req.allowFreeText ?? true,
			...(items?.length ? { items } : {}),
		},
		signal,
	);
	if (outcome.status === "abort") throw new Error("Run aborted while waiting for the user");
	return outcome.answer;
}

/**
 * Options without repeats (an agent sometimes offers the same answer twice). The client keys its answer buttons by their
 * text, so a repeated option used to crash the whole screen; it is also a choice the user cannot tell apart.
 */
const cleanItem = <T extends { options?: string[]; descriptions?: string[] }>(item: T): T => {
	if (!item.options) return item;
	const keep = item.options.map((o, i) => item.options!.indexOf(o) === i);
	const options = item.options.filter((_, i) => keep[i]);
	// a description belongs to its option: kept only when there is one per option, and thinned out with the repeats
	const descriptions = item.descriptions?.length === item.options.length ? item.descriptions.filter((_, i) => keep[i]) : undefined;
	const { descriptions: _d, ...rest } = item;
	return { ...rest, options, ...(descriptions?.some((d) => d.trim()) ? { descriptions } : {}) } as T;
};

/** The told-the-agent text of a question the user left to it. Exported so the tool can tell it from a typed answer. */
export const LEFT_TO_AGENT = "The user left this to you: decide with your best judgment (the recommended option if you gave one) and continue.";
const LEFT_SHORT = "(left to you: decide)";

/** The picks of a multiple-choice answer: one per line, trimmed, without repeats. */
export const picksOf = (answer: string): string[] => [...new Set(answer.split("\n").map((x) => x.trim()).filter(Boolean))];

const valid = (item: QuestionItem, answer: string | null) => {
	if (answer === null) return true;
	if (!answer) return false;
	const allowed = (x: string) => item.allowFreeText || !item.options?.length || item.options.includes(x);
	return item.multiple ? picksOf(answer).length > 0 && picksOf(answer).every(allowed) : allowed(answer);
};
/** An answer as the agent reads it: picks of a multiple-choice question joined, a left question said so. */
const shown = (item: QuestionItem, answer: string | null, short: boolean) =>
	answer === null ? (short ? LEFT_SHORT : LEFT_TO_AGENT) : item.multiple ? picksOf(answer).join(short ? " | " : "\n") : answer;

/**
 * Holds tool calls (any tool using ctx.ask) that are waiting for a human answer. A question waits until it is answered or the run is
 * aborted: nothing is spent while it waits, so there is no time limit.
 */
export class QuestionManager {
	private pending = new Map<string, Pending>();

	constructor(private bus: EventBus) {}

	private key = (sessionId: string, toolCallId: string) => `${sessionId}:${toolCallId}`;

	ask(req: Omit<QuestionRequest, "requestedAt">, signal?: AbortSignal): Promise<QuestionOutcome> {
		const request: QuestionRequest = { ...cleanItem(req), ...(req.items ? { items: req.items.map(cleanItem) } : {}), requestedAt: Date.now() };
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
			if (!Array.isArray(a.answers) || a.answers.length !== request.items.length) return "invalid";
			const answers: (string | null)[] = [];
			for (const x of a.answers) {
				if (x === null) answers.push(null);
				else if (typeof x === "string") answers.push(x.trim());
				else return "invalid";
			}
			if (!request.items.every((item, i) => valid(item, answers[i]!))) return "invalid";
			const text = request.items.map((item, i) => `${i + 1}. ${item.question}\n→ ${shown(item, answers[i]!, true)}`).join("\n\n");
			entry.resolve({ status: "answered", answer: text }, "user");
			return "ok";
		}

		if (a.answer !== null && a.answer !== undefined && typeof a.answer !== "string") return "invalid";
		const answer = a.answer === null ? null : (a.answer ?? "").trim();
		if (!valid(request, answer)) return "invalid";
		entry.resolve({ status: "answered", answer: shown(request, answer, false) }, "user");
		return "ok";
	}

	list(sessionId?: string): QuestionRequest[] {
		return [...this.pending.values()].map((p) => p.request).filter((r) => !sessionId || r.sessionId === sessionId);
	}
}
