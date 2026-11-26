import type { MentionTarget } from "./peers";
import { cleanPreviewText, extractPreviewSnippet } from "./mention-preview";
import { app } from "./store.svelte";

export interface HoverAnchorRect {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

export interface MentionHoverState {
	target: MentionTarget;
	label: string;
	rect: HoverAnchorRect;
}

const SHOW_DELAY_MS = 320;
const HIDE_DELAY_MS = 100;
const SNIPPET_TTL_MS = 15_000;
const MAX_CACHE = 80;

/** Extract a snippet synchronously from an already-loaded local ChatState when available. */
function snippetFromLoadedChat(sessionId: string): string {
	const chat = app.chatOf(sessionId);
	if (!chat || !chat.ready) return "";
	for (let i = chat.items.length - 1; i >= 0; i--) {
		const item = chat.items[i]!;
		if (item.kind === "assistant") {
			const raw = item.blocks
				.filter((b): b is { type: "text"; text: string } => b.type === "text")
				.map((b) => b.text)
				.join(" ");
			const text = cleanPreviewText(raw);
			if (text) return text;
		} else if (item.kind === "user") {
			const text = cleanPreviewText(item.text);
			if (text) return text;
		}
	}
	return "";
}

class MentionHoverStore {
	active = $state<MentionHoverState | null>(null);
	snippet = $state("");

	private showTimer: ReturnType<typeof setTimeout> | undefined;
	private hideTimer: ReturnType<typeof setTimeout> | undefined;
	private anchorEl: HTMLElement | null = null;
	private fetchCtrl: AbortController | null = null;
	private cache = new Map<string, { at: number; text: string }>();

	private clearTimers() {
		if (this.showTimer !== undefined) {
			clearTimeout(this.showTimer);
			this.showTimer = undefined;
		}
		if (this.hideTimer !== undefined) {
			clearTimeout(this.hideTimer);
			this.hideTimer = undefined;
		}
	}

	private abortFetch() {
		this.fetchCtrl?.abort();
		this.fetchCtrl = null;
	}

	show(el: HTMLElement, target: MentionTarget, label: string) {
		if (typeof window === "undefined") return;
		if (window.matchMedia && !window.matchMedia("(hover: hover)").matches) return;
		if (this.hideTimer !== undefined) {
			clearTimeout(this.hideTimer);
			this.hideTimer = undefined;
		}
		if (this.anchorEl === el && this.active) return;
		if (this.showTimer !== undefined) clearTimeout(this.showTimer);
		this.anchorEl = el;
		this.showTimer = setTimeout(() => {
			this.showTimer = undefined;
			if (!el.isConnected) return;
			const r = el.getBoundingClientRect();
			if (r.width === 0 && r.height === 0) return;
			this.active = {
				target,
				label,
				rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
			};
			this.loadSnippet(target);
		}, SHOW_DELAY_MS);
	}

	scheduleHide() {
		if (this.showTimer !== undefined) {
			clearTimeout(this.showTimer);
			this.showTimer = undefined;
		}
		if (this.hideTimer !== undefined) clearTimeout(this.hideTimer);
		this.hideTimer = setTimeout(() => this.hide(), HIDE_DELAY_MS);
	}

	hide() {
		this.clearTimers();
		this.abortFetch();
		this.anchorEl = null;
		this.active = null;
		this.snippet = "";
	}

	private loadSnippet(target: MentionTarget) {
		this.abortFetch();
		this.snippet = "";
		if (target.kind !== "session") return;
		const serverId = target.server ?? app.serverId;
		if (!serverId) return;
		const link = app.links[serverId];
		if (!link) return;
		const s = app.sessionAny(target.id, serverId);
		if (!s) return;

		if (serverId === app.serverId) {
			const local = snippetFromLoadedChat(target.id);
			if (local) {
				this.snippet = local;
				return;
			}
		}

		const cacheKey = `${serverId}:${target.id}:${s.updatedAt}`;
		const hit = this.cache.get(cacheKey);
		const now = Date.now();
		if (hit && (s.closed || now - hit.at < SNIPPET_TTL_MS)) {
			this.snippet = hit.text;
			return;
		}

		const ctrl = new AbortController();
		this.fetchCtrl = ctrl;
		void link.api
			.recentMessages(target.id, 4, ctrl.signal)
			.then((msgs) => {
				if (ctrl.signal.aborted) return;
				const text = extractPreviewSnippet(msgs);
				if (this.cache.size >= MAX_CACHE) {
					const oldest = this.cache.keys().next().value;
					if (oldest !== undefined) this.cache.delete(oldest);
				}
				this.cache.set(cacheKey, { at: Date.now(), text });
				if (
					this.active?.target.kind === "session" &&
					this.active.target.id === target.id &&
					(this.active.target.server ?? app.serverId) === serverId
				) {
					this.snippet = text;
				}
			})
			.catch(() => {
				/* ignore hover preview network errors or aborts */
			});
	}
}

export const mentionHover = new MentionHoverStore();

export const showMentionHover = (el: HTMLElement, target: MentionTarget, label: string) => mentionHover.show(el, target, label);
export const scheduleMentionHoverHide = () => mentionHover.scheduleHide();
export const hideMentionHover = () => mentionHover.hide();
