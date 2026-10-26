import { PROTOCOL_QUERY, PROTOCOL_VERSION } from "./protocol";

/**
 * Browser tabs: pages open in a Chromium on the server's own machine, shown in a pane like a conversation and driven by
 * agents too. Its id starts with `web_`, so a layout tells it from sessions (`s…`) and terminals (`term_`) by the id alone.
 */

export const BROWSER_PREFIX = "web_";
export const isBrowserId = (id: string | null | undefined): id is string => !!id && id.startsWith(BROWSER_PREFIX);

export interface BrowserTabInfo {
	id: string;
	title: string;
	url: string;
	/** Absolute folder on the server the tab is filed under in the sidebar */
	cwd: string;
	profile: string;
	createdAt: number;
}

export interface BrowserSupport {
	enabled: boolean;
	/** A Chrome or Chromium was found on the server */
	available: boolean;
	max: number;
}

/** Who is acting on the page right now */
export type BrowserControl = "user" | "agent";

/** URL of a tab's view socket. Browsers cannot set headers on a WebSocket, so the token rides in the query. */
export function browserSocketUrl(baseUrl: string, token: string, id: string): string {
	const base = baseUrl.replace(/^http/i, "ws");
	return `${base}/browsers/${encodeURIComponent(id)}/ws?${PROTOCOL_QUERY}=${PROTOCOL_VERSION}&token=${encodeURIComponent(token)}`;
}

/** What to show for a tab in lists: its title, else its address, else a plain name. */
export function browserLabel(b: Pick<BrowserTabInfo, "title" | "url">, fallback: string): string {
	if (b.title.trim()) return b.title;
	if (b.url && b.url !== "about:blank") return b.url.replace(/^https?:\/\//, "");
	return fallback;
}

/** CDP modifier bits for a keyboard/mouse event: Alt 1, Ctrl 2, Meta 4, Shift 8 */
export const modifiersOf = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number =>
	(e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
