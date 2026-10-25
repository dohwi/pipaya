import { describe, expect, test } from "bun:test";
import { asWorkdir, connectionState, dirKey, edgeOf, groupKey, headMenuEntries, newKey, newMenuEntries, rowMenuEntries, shortName, targetId, unreachable, type RowActions } from "../src/lib/sidebar-model";

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
});

describe("folder labels", () => {
	const dirs = [{ path: "/h/a/app" }, { path: "/h/b/app" }, { path: "/h/a/lib" }];
	test("a unique name stands alone", () => {
		expect(shortName("/h/a/lib", dirs, "/h")).toBe("lib");
	});
	test("clashing names borrow parents until they differ", () => {
		expect(shortName("/h/a/app", dirs, "/h")).toBe("a/app");
		expect(shortName("/h/b/app", dirs, "/h")).toBe("b/app");
	});
	test("a path with no segments falls back to the path itself", () => {
		expect(shortName("/", [{ path: "/" }], undefined)).toBe("/");
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
	test("a conversation can be grouped, renamed and closed, in that order", () => {
		expect(run({ kind: "session", x: { id: "s1", title: "Chat" } })).toEqual({ icons: ["columns", "pencil", "x"], calls: ["groupWith s1", "rename s1 Chat", "close s1"] });
	});
	test("a terminal closes as a terminal, not as a conversation", () => {
		expect(run({ kind: "terminal", x: { id: "t1", title: "sh" } })).toEqual({ icons: ["columns", "pencil", "x"], calls: ["groupWith t1", "rename t1 sh", "closeTerminal t1"] });
	});
	test("a pane of a split tab can also be taken out of it, before closing", () => {
		calls.length = 0;
		const entries = rowMenuEntries({ kind: "session", x: { id: "s1", title: "Chat" } }, { ...act, leaveGroup: (id) => calls.push(`leave ${id}`) }, true);
		expect(entries.map((e) => e.icon)).toEqual(["columns", "pencil", "unlink", "x"]);
		entries[2]!.run();
		expect(calls).toEqual(["leave s1"]);
	});
	test("a lone tab has nothing to leave", () => {
		expect(rowMenuEntries({ kind: "session", x: { id: "s1", title: "" } }, { ...act, leaveGroup: () => {} }).map((e) => e.icon)).not.toContain("unlink");
	});
	test("a split tab can be renamed or dissolved", () => {
		expect(run({ kind: "group", g: { id: "g1", name: "Work" } })).toEqual({ icons: ["pencil", "unlink"], calls: ["renameGroup g1", "dissolve g1"] });
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
