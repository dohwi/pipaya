export const MAX_MESSAGE_SCROLL = 500;

/**
 * Where each session's reader left the message list: px between the view's end and the content's end.
 * Absent = parked at the bottom. Memory only; deleted sessions drop their entry via `forgetMessageScroll`.
 */
export const messageScroll = new Map<string, number>();

export function setMessageScroll(sessionId: string, px: number): void {
	if (!sessionId) return;
	messageScroll.delete(sessionId);
	messageScroll.set(sessionId, px);
	while (messageScroll.size > MAX_MESSAGE_SCROLL) {
		const oldest = messageScroll.keys().next().value;
		if (oldest === undefined) break;
		messageScroll.delete(oldest);
	}
}

export function forgetMessageScroll(sessionId: string): void {
	if (!sessionId) return;
	messageScroll.delete(sessionId);
}
