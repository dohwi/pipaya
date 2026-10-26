/** Sessions that address each other by `@name`: the label, the `@` completions and the sender of a message. Free of components so it can be unit-tested. */
import { t } from "./i18n";
import { panesOf } from "./layout";
import type { Group, Session } from "./types";

/** How a group is written in a message: its name with whitespace turned into "-" so the tag stays one token (same rule as the server). */
export const groupHandle = (name: string): string => name.trim().replace(/\s+/g, "-");

/** The label shown before a session's title in the sidebar and the pane header. */
export function peerLabel(s: Pick<Session, "name" | "purpose"> | undefined): { text: string; title: string } | undefined {
	if (!s?.name) return undefined;
	return { text: `@${s.name}`, title: s.purpose ? `@${s.name} · ${s.purpose}` : `@${s.name}` };
}

export interface PeerMention { insert: string; desc: string; group: string; keywords: string; except: string }

/** The `@` completions: every group with sessions in it, then every other active session. */
export function peerMentions(sessions: readonly Session[], groups: readonly Group[], self: string | null | undefined): PeerMention[] {
	const live = sessions.filter((s) => !s.closed && s.name);
	const known = new Set(live.map((s) => s.id));
	const items: PeerMention[] = [];
	for (const g of groups) {
		const n = panesOf(g.layout).filter((id) => id !== self && known.has(id)).length;
		const handle = groupHandle(g.name);
		if (!n || !handle) continue;
		items.push({ insert: `@${handle}`, desc: t("{n}개 세션", { n }), group: t("그룹"), keywords: g.name, except: "" });
	}
	for (const s of live) {
		if (s.id === self) continue;
		const dir = s.cwd.split("/").slice(-2).join("/");
		items.push({ insert: `@${s.name}`, desc: [s.purpose || s.title, dir].filter(Boolean).join(" · "), group: t("세션"), keywords: `${s.title} ${s.purpose}`, except: "" });
	}
	return items;
}

/** A message another session sent with peer_send: `[from @name, another session on this server; ...]\nbody`. */
export function parsePeer(text: string): { from: string; body: string } | null {
	const m = /^\[from (@[^,\]\n]+), another session on this server;[^\]\n]*\]\n?([\s\S]*)$/.exec(text);
	return m ? { from: m[1]!.trim(), body: m[2]! } : null;
}
