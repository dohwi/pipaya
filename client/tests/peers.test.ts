import { describe, expect, test } from "bun:test";
import { buildMentionIndex, groupHandle, parentLabel, parsePeer, peerLabel, peerMentions, planMentionAction } from "../src/lib/peers";
import type { Group, Session } from "../src/lib/types";

const s = (id: string, name: string, extra: Partial<Session> = {}) => ({ id, name, title: `t-${id}`, purpose: "", cwd: "/home/u/proj/app", closed: false, ...extra }) as Session;
const pane = (sessionId: string) => ({ type: "pane", sessionId });
const group = (name: string, ...ids: string[]) => ({ id: name, name, layout: ids.reduce((a: any, id) => (a ? { type: "split", dir: "row", ratio: 0.5, a, b: pane(id) } : pane(id)), null) }) as unknown as Group;

describe("peers", () => {
	test("a session label is its @name, with the role in the tooltip", () => {
		expect(peerLabel(s("a", "미나"))).toEqual({ text: "@미나", title: "@미나" });
		expect(peerLabel(s("a", "미나", { purpose: "docs" }))?.title).toBe("@미나 · docs");
		expect(peerLabel(s("a", ""))).toBeUndefined();
		expect(peerLabel(undefined)).toBeUndefined();
	});

	test("completions list groups first, then the other active sessions", () => {
		const list = [s("a", "미나"), s("b", "철수"), s("c", "가온", { closed: true }), s("d", "")];
		const items = peerMentions(list, [group("결제 개편", "a", "b"), group("solo", "a")], "a");
		expect(items.map((i) => i.insert)).toEqual(["@결제-개편", "@철수"]);
		expect(items[1]!.desc).toContain("proj/app");
	});

	test("groupHandle joins words with dashes", () => {
		expect(groupHandle("  결제   개편 ")).toBe("결제-개편");
	});

	test("parsePeer reads the sender and the body", () => {
		expect(parsePeer("[from @지우, another session on this server; answer with peer_send to @지우 only if a reply is needed]\n안녕")).toEqual({ from: "@지우", body: "안녕" });
		expect(parsePeer("hello")).toBeNull();
		const r = parsePeer("[from the server: @도하 finished its run. This is a report you asked for; no reply needed.]\nlast words: \"끝\"\nUse peer(action=read).");
		expect(r?.server).toBe(true);
		expect(r?.body).toBe("@도하 finished its run. This is a report you asked for; no reply needed.\nlast words: \"끝\"\nUse peer(action=read).");
	});

	test("buildMentionIndex resolves active sessions and groups, with sessions taking precedence", () => {
		const idx = buildMentionIndex(
			[s("a", "서아"), s("b", "닫힘", { closed: true }), s("c", "")],
			[group("결제 개편", "a"), group("서아", "a")],
		);
		expect(idx.resolve("서아")).toEqual({ kind: "session", id: "a" });
		expect(idx.resolve("@서아")).toEqual({ kind: "session", id: "a" });
		expect(idx.resolve("@결제-개편")).toEqual({ kind: "group", id: "결제 개편" });
		expect(idx.resolve("닫힘")).toBeUndefined();
		expect(idx.names).toContain("서아");
		expect(idx.names).toContain("결제-개편");
	});
});

import { nameInLang, romanize } from "../src/lib/member-names";
import { describe as d2, expect as e2, test as t2 } from "bun:test";
d2("member names follow the UI language at display time", () => {
	t2("Korean shows the stored name, English its romanization, numbers kept", () => {
		e2(nameInLang("민수", "ko")).toBe("민수");
		e2(nameInLang("민수", "ko-KR")).toBe("민수");
		e2(nameInLang("민수", "en")).toBe("Minsu");
		e2(nameInLang("철수2", "en")).toBe("Cheolsu2");
		e2(nameInLang("custom", "en")).toBe("custom");
		e2(romanize("영희")).toBe("Yeonghui");
	});
});

describe("parentLabel", () => {
	const by = (m: Record<string, { name: string; title: string }>) => (id: string) => m[id];
	test("names the open session that made this one; nothing for one the user started or whose parent is gone", () => {
		expect(parentLabel({ parentId: "p" }, by({ p: { name: "minji", title: "x" } }))?.text).toBe("@minji");
		expect(parentLabel({ parentId: "p" }, by({ p: { name: "", title: "Fork source" } }))?.text).toBe("Fork source");
		expect(parentLabel({ parentId: null }, by({}))).toBeUndefined();
		expect(parentLabel({ parentId: "gone" }, by({}))).toBeUndefined();
	});
});

describe("buildMentionIndex (closed & remote sessions)", () => {
	test("indexes closed sessions without overriding active sessions or groups, and indexes @server/name remotes", () => {
		const idx = buildMentionIndex(
			[s("s1", "서아")],
			[{ id: "g1", name: "팀" }],
			{
				closedSessions: [
					s("c1", "서아", { closed: true }), // clashes with active -> active wins
					s("c2", "팀", { closed: true }), // clashes with group -> group wins
					s("c3", "소민", { closed: true }), // closed -> resolved with closed: true
				],
				remotes: [
					{
						serverId: "srv-desktop",
						handle: "desktop",
						sessions: [s("r1", "민석")],
						closedSessions: [
							s("r2", "민석", { closed: true }), // active remote wins
							s("r3", "예서", { closed: true }),
						],
					},
				],
			},
		);
		expect(idx.resolve("@서아")).toEqual({ kind: "session", id: "s1" });
		expect(idx.resolve("@팀")).toEqual({ kind: "group", id: "g1" });
		expect(idx.resolve("@소민")).toEqual({ kind: "session", id: "c3", closed: true });
		expect(idx.resolve("@desktop/민석")).toEqual({ kind: "session", id: "r1", server: "srv-desktop" });
		expect(idx.resolve("@desktop/예서")).toEqual({ kind: "session", id: "r3", server: "srv-desktop", closed: true });
	});
});

describe("planMentionAction", () => {
	const base = {
		graphOpen: false,
		serverId: "srv1",
		graphPeek: null,
		chatPeek: null,
		activeId: "s1",
		baseVisibleIds: ["s1"],
		hasSession: true,
		hasGroup: true,
	};

	test("opens another session in the chat quick-look modal on normal click, and navigates directly on Ctrl/Cmd+click", () => {
		expect(planMentionAction({ kind: "session", id: "s2" }, base)).toEqual({ type: "chatPeek", server: "srv1", id: "s2" });
		expect(planMentionAction({ kind: "session", id: "s2" }, { ...base, direct: true })).toEqual({
			type: "openSession",
			id: "s2",
			leaveGraph: false,
		});
	});

	test("switches modal target in place and closes peek when clicking a session already visible behind the modal", () => {
		expect(planMentionAction({ kind: "session", id: "s3" }, { ...base, chatPeek: { server: "srv1", session: "s2" } })).toEqual({
			type: "chatPeek",
			server: "srv1",
			id: "s3",
		});
		expect(planMentionAction({ kind: "session", id: "s2" }, { ...base, chatPeek: { server: "srv1", session: "s2" } })).toEqual({ type: "noop" });
		expect(planMentionAction({ kind: "session", id: "s1" }, { ...base, chatPeek: { server: "srv1", session: "s2" } })).toEqual({ type: "closeChatPeek" });
		// Clicking a sibling pane in a split group focuses it instead of opening a duplicate modal
		expect(planMentionAction({ kind: "session", id: "s2" }, { ...base, baseVisibleIds: ["s1", "s2"] })).toEqual({
			type: "closeChatPeek",
			focusId: "s2",
		});
		expect(planMentionAction({ kind: "session", id: "s2" }, { ...base, chatPeek: { server: "srv1", session: "s3" }, baseVisibleIds: ["s1", "s2"] })).toEqual({
			type: "closeChatPeek",
			focusId: "s2",
		});
		// Clicking the currently active pane itself without peek is a no-op
		expect(planMentionAction({ kind: "session", id: "s1" }, base)).toEqual({ type: "noop" });
	});

	test("handles closed and remote-server sessions in chat peek and direct navigation", () => {
		expect(planMentionAction({ kind: "session", id: "c1", closed: true }, base)).toEqual({ type: "chatPeek", server: "srv1", id: "c1" });
		expect(planMentionAction({ kind: "session", id: "r1", server: "srv2" }, base)).toEqual({ type: "chatPeek", server: "srv2", id: "r1" });
		expect(planMentionAction({ kind: "session", id: "r1", server: "srv2" }, { ...base, direct: true })).toEqual({
			type: "openSession",
			id: "r1",
			server: "srv2",
			leaveGraph: false,
		});
		// Same session id on a DIFFERENT server is never treated as the locally visible pane
		expect(planMentionAction({ kind: "session", id: "s1", server: "srv2" }, base)).toEqual({ type: "chatPeek", server: "srv2", id: "s1" });
	});

	test("switches graph quick-look without closing graph, and leaves graph on direct click", () => {
		expect(planMentionAction({ kind: "session", id: "s2" }, { ...base, graphOpen: true, graphPeek: { server: "srv1", session: "s1" } })).toEqual({
			type: "graphPeek",
			server: "srv1",
			id: "s2",
		});
		expect(planMentionAction({ kind: "session", id: "s1" }, { ...base, graphOpen: true, graphPeek: { server: "srv1", session: "s1" } })).toEqual({
			type: "noop",
		});
		expect(planMentionAction({ kind: "session", id: "r1", server: "srv2" }, { ...base, graphOpen: true, graphPeek: { server: "srv1", session: "s1" } })).toEqual({
			type: "graphPeek",
			server: "srv2",
			id: "r1",
		});
		expect(planMentionAction({ kind: "session", id: "s2" }, { ...base, graphOpen: true, direct: true })).toEqual({
			type: "openSession",
			id: "s2",
			leaveGraph: true,
		});
		expect(planMentionAction({ kind: "session", id: "s2" }, { ...base, graphOpen: true, serverId: null })).toEqual({ type: "noop" });
	});

	test("opens groups directly and ignores missing sessions or groups", () => {
		expect(planMentionAction({ kind: "group", id: "g1" }, base)).toEqual({ type: "openGroup", id: "g1" });
		expect(planMentionAction({ kind: "group", id: "g1" }, { ...base, hasGroup: false })).toEqual({ type: "noop" });
		expect(planMentionAction({ kind: "session", id: "s2" }, { ...base, hasSession: false })).toEqual({ type: "noop" });
	});
});
