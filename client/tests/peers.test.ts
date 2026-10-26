import { describe, expect, test } from "bun:test";
import { groupHandle, parsePeer, peerLabel, peerMentions } from "../src/lib/peers";
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
	});
});
