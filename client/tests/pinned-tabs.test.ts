import { describe, expect, it } from "bun:test";
import { pane } from "../src/lib/layout";
import { sessionOrder, sidebarDirs } from "../src/lib/nav";
import type { Group, Session } from "../src/lib/types";

const s = (id: string, createdAt: number): Session => ({ id, title: id, cwd: "/p", createdAt }) as unknown as Session;
const sessions = [s("a", 1), s("b", 2), s("c", 3)];
const ids = (pinnedTabs: string[], tabOrder: string[] = []) => sidebarDirs(sessions, [], [], { pinnedTabs, tabOrder })[0]!.tabs.map((t) => t.id);

describe("pinned tabs", () => {
	it("lead their folder", () => expect(ids(["c"])).toEqual(["c", "a", "b"]));
	it("keep their own order, and the rest theirs", () => {
		expect(ids(["c", "b"], ["b", "a", "c"])).toEqual(["b", "c", "a"]);
	});
	it("do not change anything when empty", () => expect(ids([])).toEqual(["a", "b", "c"]));
	it("pin a split tab as a whole", () => {
		const groups = [{ id: "g1", name: "g", layout: pane("b"), createdAt: 5 }] as unknown as Group[];
		const dirs = sidebarDirs(sessions, groups, [], { pinnedTabs: ["g1"] });
		expect(dirs[0]!.tabs.map((t) => t.id)).toEqual(["g1", "a", "c"]);
	});
	it("shape the previous / next order", () => expect(sessionOrder(sessions, [], [], [], [], ["c"])).toEqual(["c", "a", "b"]));
});
