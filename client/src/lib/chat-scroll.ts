/**
 * Where each session's reader left the message list: px between the view's end and the content's end.
 * Absent = parked at the bottom. Memory only; deleted sessions drop their entry via `forgetMessageScroll`.
 */
export const messageScroll = new Map<string, number>();

export function forgetMessageScroll(sessionId: string): void {
	if (!sessionId) return;
	messageScroll.delete(sessionId);
}
