import { describe, expect, test } from "bun:test";
import { asWorkdir, connectionState, dirKey, edgeOf, groupKey, headMenuEntries, newKey, newMenuEntries, orderServers, parentPath, rowMenuEntries, shortName, targetId, unreachable, type RowActions, type ServerState } from "../src/lib/sidebar-model";

describe("server state", () => {
	test("the app's connection state maps onto the sidebar's", () => {
		expect(connectionState("online")).toBe("online");
		expect(connectionState("unauthorized")).toBe("unauthorized");
		expect(connectionState("incompatible")).toBe("incompatible");
		expect(connectionState("connecting")).toBe("checking");
		expect(connectionState("offline")).toBe("offline");
		expect(connectionState("anything else")).toBe("offline");
	});
	test("only offline, rejected and incompatible servers are unreachable", () => {
		expect(["online", "checking"].some((s) => unreachable(s as never))).toBe(false);
		expect(["offline", "unauthorized", "incompatible"].every((s) => unreachable(s as never))).toBe(true);
	});
	test("the sidebar lists the servers that are up first, then those still checking, then the rest", () => {
		const s = (id: string, state: ServerState) => ({ id, state });
		const saved = [s("a", "offline"), s("b", "checking"), s("c", "online"), s("d", "unauthorized"), s("e", "online"), s("f", "incompatible")];
		expect(orderServers(saved).map((x) => x.id)).toEqual(["c", "e", "b", "a", "d", "f"]);
	});
	test("servers in the same state keep the order they were saved in, and the saved list is left alone", () => {
		const s = (id: string, state: ServerState) => ({ id, state });
		const saved = [s("z", "checking"), s("y", "online"), s("x", "online"), s("w", "checking")];
		expect(orderServers(saved).map((x) => x.id)).toEqual(["y", "x", "z", "w"]);
		expect(saved.map((x) => x.id)).toEqual(["z", "y", "x", "w"]);
	});
});

describe("folder labels", () => {
	test("shows the last two names", () => {
		expect(shortName("/h/a/lib", "/h")).toBe("a/lib");
		expect(shortName("/h/a/b/lib", "/h")).toBe("b/lib");
	});
	test("a folder right under home keeps the ~", () => {
		expect(shortName("/h/work", "/h")).toBe("~/work");
		expect(shortName("/h", "/h")).toBe("~");
	});
	test("Windows paths read the same as Linux ones", () => {
		expect(shortName("C:\\Users\\me\\work\\app", "C:\\Users\\me")).toBe("work/app");
		expect(shortName("c:\\users\\me\\work", "C:\\Users\\me")).toBe("~/work");
		expect(shortName("D:\\proj\\app", "C:\\Users\\me")).toBe("proj/app");
	});
	test("a path with no segments falls back to the path itself", () => {
		expect(shortName("/", undefined)).toBe("/");
	});
	test("the dim path does not repeat the label: the folder's own tail is cut", () => {
		expect(parentPath("/h/work/meet-clone", "/h", shortName("/h/work/meet-clone", "/h"))).toBe("~");
		expect(parentPath("/h/a/b/lib", "/h", "b/lib")).toBe("~/a");
		// a folder right under home has nothing above it: the label (`~/work`) already says where it sits
		expect(parentPath("/h/work", "/h", "~/work")).toBe("");
		expect(parentPath("/h", "/h", "~")).toBe("");
	});
	test("the dim path keeps a name that only looks like the label's tail", () => {
		expect(parentPath("/h/a/meet-clone", "/h", "clone")).toBe("~/a/meet-clone");
		// a renamed folder: its label is nowhere in the path, so the whole path still says where it sits
		expect(parentPath("/h/a/meet-clone", "/h", "내 앱")).toBe("~/a/meet-clone");
	});
	test("the dim path cuts at the OS's own separator", () => {
		expect(parentPath("C:\\Users\\me\\work\\app", "C:\\Users\\me", "work/app")).toBe("C:\\Users\\me");
		expect(parentPath("C:\\Users\\me\\work\\app", "C:\\Users\\me", "me/work/app")).toBe("C:\\Users");
	});
});

describe("drop position", () => {
	const r = { top: 100, bottom: 140, height: 40 };
	test("edges reorder, the middle pairs", () => {
		expect(edgeOf(104, r, false)).toBe("before");
		expect(edgeOf(136, r, false)).toBe("after");
		expect(edgeOf(120, r, false)).toBeNull();
	});
	test("a carried group has no middle", () => {
		expect(edgeOf(119, r, true)).toBe("before");
		expect(edgeOf(121, r, true)).toBe("after");
	});
});

describe("keys", () => {
	test("the server's default folder is '.', others are absolute", () => {
		expect(asWorkdir("/w", "/w")).toBe(".");
		expect(asWorkdir("/w/x", "/w")).toBe("/w/x");
	});
	test("combined keys cannot collide with plain ones", () => {
		expect(dirKey("s", "/p")).toBe("s\u0000/p");
		expect(groupKey("g")).toBe("group\u0000g");
		expect(newKey(dirKey("s", "."))).toBe("new\u0000s\u0000.");
	});
});

describe("row menu", () => {
	const calls: string[] = [];
	const act: RowActions = {
		renameTab: (id, title) => calls.push(`rename ${id} ${title}`),
		renameGroup: (g) => calls.push(`renameGroup ${g.id}`),
		groupWith: (x) => calls.push(`groupWith ${x.id}`),
		closeSession: (id) => calls.push(`close ${id}`),
		closeTerminal: (id) => calls.push(`closeTerminal ${id}`),
		dissolveGroup: (id) => calls.push(`dissolve ${id}`),
	};
	const run = (target: Parameters<typeof rowMenuEntries>[0]) => {
		calls.length = 0;
		const entries = rowMenuEntries(target, act);
		entries.forEach((e) => e.run());
		return { icons: entries.map((e) => e.icon), calls: [...calls] };
	};
	test("a conversation can be renamed, grouped and closed, in that order", () => {
		expect(run({ kind: "session", x: { id: "s1", title: "Chat" } })).toEqual({ icons: ["pencil", "columns", "x"], calls: ["rename s1 Chat", "groupWith s1", "close s1"] });
	});
	test("a terminal closes as a terminal, not as a conversation", () => {
		expect(run({ kind: "terminal", x: { id: "t1", title: "sh" } })).toEqual({ icons: ["pencil", "columns", "x"], calls: ["rename t1 sh", "groupWith t1", "closeTerminal t1"] });
	});
	test("a pane of a split tab can also be taken out of it, before closing", () => {
		calls.length = 0;
		const entries = rowMenuEntries({ kind: "session", x: { id: "s1", title: "Chat" } }, { ...act, leaveGroup: (id) => calls.push(`leave ${id}`) }, true);
		expect(entries.map((e) => e.icon)).toEqual(["pencil", "columns", "unlink", "x"]);
		entries[2]!.run();
		expect(calls).toEqual(["leave s1"]);
	});
	test("a lone tab has nothing to leave", () => {
		expect(rowMenuEntries({ kind: "session", x: { id: "s1", title: "" } }, { ...act, leaveGroup: () => {} }).map((e) => e.icon)).not.toContain("unlink");
	});
	test("a conversation's menu ends with closing it; nothing offers an archive", () => {
		const entries = rowMenuEntries({ kind: "session", x: { id: "s1", title: "Chat" } }, act);
		expect(entries.map((e) => e.icon)).toEqual(["pencil", "columns", "x"]);
		calls.length = 0;
		entries[2]!.run();
		expect(calls).toEqual(["close s1"]);
	});
	test("a split tab can be renamed or dissolved", () => {
		expect(run({ kind: "group", g: { id: "g1", name: "Work" } })).toEqual({ icons: ["pencil", "unlink"], calls: ["renameGroup g1", "dissolve g1"] });
	});
	test("a menu that cannot dissolve (the tab bar, chips, pane bars) never offers it", () => {
		const { dissolveGroup: _, ...plain } = act;
		expect(rowMenuEntries({ kind: "group", g: { id: "g1", name: "Work" } }, plain).map((e) => e.icon)).toEqual(["pencil"]);
	});
	test("only the split tab's own row dissolves it: its panes never do, even in the sidebar", () => {
		const entries = rowMenuEntries({ kind: "session", x: { id: "s1", title: "Chat" } }, { ...act, leaveGroup: () => {} }, true);
		expect(entries.map((e) => e.icon)).toEqual(["pencil", "columns", "unlink", "x"]);
		expect(entries.map((e) => e.label)).not.toContain("그룹 해제");
	});
	test("the target id is the group's own, else the tab's", () => {
		expect(targetId({ kind: "group", g: { id: "g1", name: "" } })).toBe("g1");
		expect(targetId({ kind: "session", x: { id: "s1", title: "" } })).toBe("s1");
		expect(targetId({ kind: "terminal", x: { id: "t1", title: "" } })).toBe("t1");
	});
});

describe("the + menu", () => {
	const calls: string[] = [];
	const act = { chat: () => calls.push("chat"), terminal: () => calls.push("terminal") };
	test("a conversation and a terminal, in that order", () => {
		calls.length = 0;
		const entries = newMenuEntries(undefined, act);
		expect(entries.map((e) => e.icon)).toEqual(["chat", "terminal"]);
		entries.forEach((e) => e.run());
		expect(calls).toEqual(["chat", "terminal"]);
	});
	test("the terminal names the server's OS when it is known", () => {
		expect(newMenuEntries("Linux", act)[1]!.label).toContain("Linux");
		expect(newMenuEntries(undefined, act)[1]!.label).not.toContain("(");
	});
});

describe("the header context menu", () => {
	const calls: string[] = [];
	const act = { chat: () => calls.push("chat"), terminal: () => calls.push("terminal"), toggle: () => calls.push("toggle") };
	test("a folder: new chat, new terminal, copy path, fold", () => {
		calls.length = 0;
		const entries = headMenuEntries(undefined, false, { ...act, copyPath: () => calls.push("copy") });
		expect(entries.map((e) => e.icon)).toEqual(["chat", "terminal", "copy", "chevron-right"]);
		entries.forEach((e) => e.run());
		expect(calls).toEqual(["chat", "terminal", "copy", "toggle"]);
	});
	test("a server has no path to copy, and a folded one offers to unfold", () => {
		expect(headMenuEntries(undefined, true, act).map((e) => e.icon)).toEqual(["chat", "terminal", "chevron-down"]);
	});
});

describe("pinning a folder", () => {
	const act = { chat: () => {}, terminal: () => {}, toggle: () => {} };
	test("the entry is offered for folders only and says which way it goes", () => {
		expect(headMenuEntries(undefined, false, act).some((e) => e.icon === "pin")).toBe(false);
		expect(headMenuEntries(undefined, false, { ...act, togglePin: () => {} }).some((e) => e.icon === "pin")).toBe(true);
	});
});

describe("the pin entry's lean", () => {
	const act = { chat: () => {}, terminal: () => {}, toggle: () => {}, togglePin: () => {} };
	const pin = (pinned: boolean) => headMenuEntries(undefined, false, { ...act, pinned }).find((e) => e.icon === "pin")!;
	test("pinning leans like the pinned folder's icon; unpinning stands upright", () => {
		expect(pin(false).tilt).toBe(35);
		expect(pin(true).tilt).toBe(0);
	});
});
