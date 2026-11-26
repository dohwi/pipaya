/** Sessions that address each other by `@name`: the label, the `@` completions and the sender of a message. Free of components so it can be unit-tested. */
import { t } from "./i18n";
import { nameInLang } from "./member-names";
import { panesOf } from "./layout";
import type { Group, Session } from "./types";

/** How a group or server is written in a message: its name with whitespace turned into "-" so the tag stays one token. */
export const groupHandle = (name: string): string => name.trim().replace(/\s+/g, "-");

export type MentionTarget =
	| { kind: "session"; id: string; closed?: boolean; server?: string }
	| { kind: "group"; id: string };

export interface PeekTarget {
	server: string;
	session: string;
}

export type MentionAction =
	| { type: "noop" }
	| { type: "openGroup"; id: string }
	| { type: "openSession"; id: string; server?: string; leaveGraph: boolean }
	| { type: "graphPeek"; server: string; id: string }
	| { type: "closeChatPeek"; focusId?: string }
	| { type: "chatPeek"; server: string; id: string };

/**
 * Decide what clicking a `@mention` chip should do given the current view state:
 *  - group mentions open their group tab
 *  - `direct` (`Ctrl`/`⌘`+click) navigates straight to the session (leaving graph/peek; resumes closed sessions)
 *  - in graph view, normal clicks switch the graph quick-look modal without closing the graph
 *  - in chat/group view, clicking an open session on the current server that is already visible behind the modal closes
 *    peek and focuses it (never mounting a duplicate live Pane); clicking any other session (including closed or remote
 *    server sessions) opens/switches the chat quick-look modal.
 */
export function planMentionAction(
	target: MentionTarget,
	state: {
		direct?: boolean;
		graphOpen: boolean;
		serverId: string | null;
		graphPeek: PeekTarget | null;
		chatPeek: PeekTarget | null;
		activeId: string | null;
		baseVisibleIds: readonly string[];
		hasSession: boolean;
		hasGroup: boolean;
	},
): MentionAction {
	if (target.kind === "group") {
		return state.hasGroup ? { type: "openGroup", id: target.id } : { type: "noop" };
	}
	if (!state.hasSession) return { type: "noop" };
	const targetServer = target.server ?? state.serverId;
	if (!targetServer) return { type: "noop" };
	const isSameServer = targetServer === state.serverId;
	if (state.direct) {
		return {
			type: "openSession",
			id: target.id,
			...(!isSameServer ? { server: targetServer } : {}),
			leaveGraph: state.graphOpen,
		};
	}
	if (state.graphOpen) {
		if (state.graphPeek?.server === targetServer && state.graphPeek.session === target.id) return { type: "noop" };
		return { type: "graphPeek", server: targetServer, id: target.id };
	}
	if (state.chatPeek?.server === targetServer && state.chatPeek.session === target.id) return { type: "noop" };
	if (isSameServer && !target.closed && state.baseVisibleIds.includes(target.id)) {
		if (!state.chatPeek && target.id === state.activeId) return { type: "noop" };
		return { type: "closeChatPeek", ...(target.id !== state.activeId ? { focusId: target.id } : {}) };
	}
	return { type: "chatPeek", server: targetServer, id: target.id };
}

export interface MentionIndex {
	/** All known lowercase handle forms (stored session name, localized romanized form, group handles, and `@server/name`). */
	names: string[];
	/** Resolve a handle (with or without leading `@`) to the session or group it names. */
	resolve: (name: string) => MentionTarget | undefined;
}

export interface RemoteMentionSource {
	serverId: string;
	/** Display handle for the server (whitespace normalized via `groupHandle`), e.g. `desktop` or `맥북`. */
	handle: string;
	sessions: readonly Pick<Session, "id" | "name" | "closed">[];
	closedSessions?: readonly Pick<Session, "id" | "name" | "closed">[];
}

/**
 * Lookup table from every known `@name` (active session, group, closed session, or `@server/session`) to the target it
 * opens. Precedence on name clashes: active sessions > groups > closed sessions.
 */
export function buildMentionIndex(
	sessions: readonly Pick<Session, "id" | "name" | "closed">[],
	groups: readonly Pick<Group, "id" | "name">[],
	opts?: {
		closedSessions?: readonly Pick<Session, "id" | "name" | "closed">[];
		remotes?: readonly RemoteMentionSource[];
	},
): MentionIndex {
	const map = new Map<string, MentionTarget>();
	for (const s of sessions) {
		if (s.closed || !s.name) continue;
		const target: MentionTarget = { kind: "session", id: s.id };
		map.set(s.name.toLowerCase(), target);
		map.set(nameInLang(s.name).toLowerCase(), target);
	}
	for (const g of groups) {
		const handle = groupHandle(g.name);
		if (!handle) continue;
		const key = handle.toLowerCase();
		if (!map.has(key)) map.set(key, { kind: "group", id: g.id });
	}
	for (const s of opts?.closedSessions ?? []) {
		if (!s.name) continue;
		const target: MentionTarget = { kind: "session", id: s.id, closed: true };
		const rawKey = s.name.toLowerCase();
		const langKey = nameInLang(s.name).toLowerCase();
		if (!map.has(rawKey)) map.set(rawKey, target);
		if (!map.has(langKey)) map.set(langKey, target);
	}
	for (const remote of opts?.remotes ?? []) {
		const prefix = groupHandle(remote.handle).toLowerCase();
		if (!prefix) continue;
		for (const s of remote.sessions) {
			if (s.closed || !s.name) continue;
			const target: MentionTarget = { kind: "session", id: s.id, server: remote.serverId };
			const rawKey = `${prefix}/${s.name.toLowerCase()}`;
			const langKey = `${prefix}/${nameInLang(s.name).toLowerCase()}`;
			if (!map.has(rawKey)) map.set(rawKey, target);
			if (!map.has(langKey)) map.set(langKey, target);
		}
		for (const s of remote.closedSessions ?? []) {
			if (!s.name) continue;
			const target: MentionTarget = { kind: "session", id: s.id, server: remote.serverId, closed: true };
			const rawKey = `${prefix}/${s.name.toLowerCase()}`;
			const langKey = `${prefix}/${nameInLang(s.name).toLowerCase()}`;
			if (!map.has(rawKey)) map.set(rawKey, target);
			if (!map.has(langKey)) map.set(langKey, target);
		}
	}
	return {
		names: [...map.keys()],
		resolve: (name: string) => map.get(name.replace(/^@/, "").toLowerCase()),
	};
}

/** The label shown before a session's title in the sidebar and the pane header. */
export function peerLabel(s: Pick<Session, "name" | "purpose"> | undefined): { text: string; title: string } | undefined {
	if (!s?.name) return undefined;
	const shown = `@${nameInLang(s.name)}`;
	return { text: shown, title: s.purpose ? `${shown} · ${s.purpose}` : shown };
}

/**
 * Who made a session, when it is another active session (an agent's `peer create`, or a fork): the parent mark on its tab
 * and sidebar row (a `fork` icon, then this text). Undefined for one the user started, or whose parent is gone or closed.
 */
export function parentLabel(s: Pick<Session, "parentId"> | undefined, byId: (id: string) => Pick<Session, "name" | "title"> | undefined): { text: string; title: string } | undefined {
	const p = s?.parentId ? byId(s.parentId) : undefined;
	if (!p) return undefined;
	const who = p.name ? `@${nameInLang(p.name)}` : p.title;
	return { text: who, title: t("{who}가 만든 대화", { who }) };
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
		items.push({ insert: `@${handle}`, desc: t("대화 {n}개", { n }), group: t("그룹"), keywords: g.name, except: "" });
	}
	for (const s of live) {
		if (s.id === self) continue;
		const dir = s.cwd.split("/").slice(-2).join("/");
		items.push({ insert: `@${nameInLang(s.name)}`, desc: [s.purpose || s.title, dir].filter(Boolean).join(" · "), group: t("대화"), keywords: `${s.title} ${s.purpose}`, except: "" });
	}
	return items;
}

/** A message another session sent with peer(action=send): `[from @name, another session on this server; ...]\nbody`. */
export function parsePeer(text: string): { from: string; body: string; server?: boolean } | null {
	const m = /^\[from (@[^,\]\n]+), another session on this server;[^\]\n]*\]\n?([\s\S]*)$/.exec(text);
	if (m) return { from: m[1]!.trim(), body: m[2]! };
	// a report from the server itself (`[from the server: @name finished its run. ...]\nmore`): the first line stays in the body
	const s = /^\[from the server: ([^\n]*)\]\n?([\s\S]*)$/.exec(text);
	return s ? { from: t("서버 알림"), body: s[2] ? `${s[1]}\n${s[2]}` : s[1]!, server: true } : null;
}
