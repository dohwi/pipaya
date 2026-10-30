import type { ChatItem, Session } from "./types";

export interface LogoModel {
	provider: string;
	model: string;
}

/**
 * The model whose logo an agent badge shows: the session's own model, so a switch shows the moment it is made —
 * while a run is still going, before the next reply lands, or from another client.
 *
 * The last reply's model only stands in when the session list does not hold the session (a chat made on this
 * server a moment ago), and the caller's own model (the draft) when there is nothing else.
 */
export function logoModelOf(session: Session | undefined, items: readonly ChatItem[] | undefined, fallback: LogoModel): LogoModel {
	if (session?.model) return { provider: session.provider, model: session.model };
	if (items)
		for (let i = items.length - 1; i >= 0; i--) {
			const it = items[i]!;
			if (it.kind === "assistant" && it.model) return { provider: it.provider ?? "", model: it.model };
		}
	return fallback;
}
