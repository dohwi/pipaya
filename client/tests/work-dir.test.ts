import { describe, expect, it } from "bun:test";
import { pane, splitAt } from "../src/lib/layout";
import { sidebarDirs, workDir } from "../src/lib/nav";
import { projectBlocks } from "../src/lib/projects";
import type { TerminalInfo } from "../src/lib/terminal";
import type { Group, Session } from "../src/lib/types";

const s = (id: string, cwd: string, activeDir?: string | null): Session => ({ id, title: id, cwd, activeDir, createdAt: 1 }) as unknown as Session;

describe("workDir", () => {
	it("is the worktree the agent moved into, else the folder the session was made in", () => {
		expect(workDir(s("a", "/w/app", "/w/app-x"))).toBe("/w/app-x");
		expect(workDir(s("a", "/w/app", null))).toBe("/w/app");
		expect(workDir(s("a", "/w/app"))).toBe("/w/app"); // an older server sends no activeDir
		expect(workDir({ id: "t:1", cwd: "/w/t" } as unknown as TerminalInfo)).toBe("/w/t");
	});
});

describe("sessions that moved into a worktree", () => {
	const sessions = [s("a", "/w/app"), s("b", "/w/app", "/w/app-x"), s("c", "/w/app", "/w/app-y")];

	it("are listed under the worktree, and the repository becomes a project of its worktrees", () => {
		const dirs = sidebarDirs(sessions, [], []);
		expect(dirs.map((d) => [d.path, d.tabs.map((t) => t.id)])).toEqual([["/w/app", ["a"]], ["/w/app-x", ["b"]], ["/w/app-y", ["c"]]]);
		const repo = (top: string, branch: string) => ({ root: "/w/app", top, branch });
		const blocks = projectBlocks(dirs, { "/w/app": repo("/w/app", "main"), "/w/app-x": repo("/w/app-x", "feat/x"), "/w/app-y": repo("/w/app-y", "feat/y") });
		expect(blocks).toHaveLength(1);
		expect(blocks[0]!.kind === "project" && blocks[0]!.dirs.map((d) => d.path)).toEqual(["/w/app", "/w/app-x", "/w/app-y"]);
	});

	it("carry a group to the folder most of its panes work in", () => {
		const g = { id: "g", name: "g", layout: splitAt(splitAt(pane("b"), "b", "c", "right"), "c", "d", "right"), createdAt: 1 } as unknown as Group;
		const dirs = sidebarDirs([...sessions, s("d", "/w/app", "/w/app-x")], [g], []);
		expect(dirs.find((d) => d.tabs.some((t) => t.id === "g"))?.path).toBe("/w/app-x");
	});
});
