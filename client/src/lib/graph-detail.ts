/**
 * What the graph view's detail dialog shows for a server, provider, model or subagent card. Pure: it reads the graph and
 * the server's delegate calls; `GraphDetail.svelte` only draws it.
 */
import type { Card, CardKind, DelegateRun, Graph } from "./graph";
import type { SettingsFocus } from "./settings-focus";
import type { SettingsTabId } from "./settings-search";
import type { CustomProvider, ProviderInfo } from "./types";

/** The cards of `kind` under `id`, in the order the graph shows them (its columns are sorted by urgency, then size). */
export function under(g: Graph, id: string, kind: CardKind): Card[] {
	const out: Card[] = [];
	const walk = (x: string) => {
		for (const k of g.cards.get(x)?.children ?? []) {
			const c = g.cards.get(k);
			if (!c) continue;
			if (c.kind === kind) out.push(c);
			walk(k);
		}
	};
	walk(id);
	return out;
}

/** How one call of a role ended: still running, an error, cut off before a result (a restart), or done. */
export type CallState = "running" | "failed" | "cut" | "done";
export const callState = (r: DelegateRun): CallState => (r.running ? "running" : r.error ? "failed" : r.doneAt === null ? "cut" : "done");

export interface RoleStats {
	calls: number;
	running: number;
	failed: number;
	/** Tokens and turns of the calls that report them. */
	tokens: number;
	turns: number;
	/** Mean time of the finished calls; null when none finished. */
	avgMs: number | null;
	/** The chats that called it, the most recent caller first. */
	callers: { sessionId: string; n: number; last: number }[];
	/** Its calls running now, newest first (all of them: they are what the dialog leads with). */
	active: DelegateRun[];
	/** Its other calls, newest first, at most `limit`. */
	recent: DelegateRun[];
}

/** A card's chats split the way the dialog lists them: the ones at work (or waiting on the user) first, then the rest. */
export function splitLive(chats: Card[]): { live: Card[]; rest: Card[] } {
	const live = chats.filter((c) => c.activity === "working" || c.activity === "asking");
	return { live, rest: chats.filter((c) => !live.includes(c)) };
}

/** One role's calls on one server, counted the way its card counts them: only calls made from open chats. */
export function roleStats(runs: DelegateRun[], role: string, open: (sessionId: string) => boolean, limit = 20): RoleStats {
	const mine = runs.filter((r) => r.role === role && open(r.sessionId));
	const callers = new Map<string, { sessionId: string; n: number; last: number }>();
	let tokens = 0, turns = 0, ms = 0, finished = 0;
	for (const r of mine) {
		const c = callers.get(r.sessionId) ?? { sessionId: r.sessionId, n: 0, last: 0 };
		c.n++;
		c.last = Math.max(c.last, r.at);
		callers.set(r.sessionId, c);
		tokens += r.tokens ?? 0;
		turns += r.turns ?? 0;
		if (r.doneAt !== null && !r.running) { ms += Math.max(0, r.doneAt - r.at); finished++; }
	}
	return {
		calls: mine.length,
		running: mine.filter((r) => r.running).length,
		failed: mine.filter((r) => callState(r) === "failed").length,
		tokens,
		turns,
		avgMs: finished ? ms / finished : null,
		callers: [...callers.values()].sort((a, b) => b.last - a.last),
		active: mine.filter((r) => r.running).sort((a, b) => b.at - a.at),
		recent: mine.filter((r) => !r.running).sort((a, b) => b.at - a.at).slice(0, limit),
	};
}

/** What the detail dialog's "설정 열기" opens for a card: the section, and the row in it to bring into view. */
export interface SettingsTarget {
	tab: SettingsTabId;
	focus: SettingsFocus | null;
}

/**
 * The settings place of a card. A server opens its "정보"; a provider its row under "모델" (a connection the owner added,
 * or a built-in one with a stored sign-in; one signed in from the server's environment has none, so the list); a model
 * the row in its connection's model list (only added connections list their models: else the connection's row); a role
 * its row under "에이전트 도구" (only global roles are listed there: a project role lands on the list, a made-up one on
 * the delegate settings that allow it).
 */
export function settingsTarget(
	card: Pick<Card, "kind" | "label" | "provider" | "free">,
	ctx: { custom?: Pick<CustomProvider, "id" | "models">; builtin?: Pick<ProviderInfo, "storedCredential"> | null; roleScope?: "global" | "project" | null },
): SettingsTarget {
	const hasRow = (id: string) => ctx.custom?.id === id || Boolean(ctx.builtin?.storedCredential);
	switch (card.kind) {
		case "server":
		case "session":
			return { tab: "info", focus: null };
		case "provider":
			return { tab: "models", focus: hasRow(card.label) ? { kind: "provider", provider: card.label } : { kind: "connections" } };
		case "model": {
			const provider = card.provider ?? "";
			if (ctx.custom?.id === provider && ctx.custom.models.some((m) => m.id === card.label)) return { tab: "models", focus: { kind: "model", provider, model: card.label } };
			return { tab: "models", focus: hasRow(provider) ? { kind: "provider", provider } : { kind: "connections" } };
		}
		case "subagent":
			if (card.free) return { tab: "tools", focus: { kind: "delegate" } };
			return { tab: "tools", focus: ctx.roleScope === "project" ? { kind: "roles" } : { kind: "role", name: card.label } };
	}
}
