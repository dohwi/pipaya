import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentsPrompt, buildSystemPrompt } from "../src/context.ts";
import { loadAgentFiles, parseAgentFile } from "../src/subagent-files.ts";

const root = mkdtempSync(join(tmpdir(), "pipaya-agentfiles-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const put = (rel: string, text: string) => {
	const p = join(root, rel);
	mkdirSync(join(p, ".."), { recursive: true });
	writeFileSync(p, text);
};

describe("agent files", () => {
	test("frontmatter is the settings and the body is the extra prompt", () => {
		const r = parseAgentFile("---\nname: fixer\ndescription: Fixes small bugs\nmodel: p/m\nthinking: low\ntools: [read, edit, bash]\nmaxTurns: 20\n---\nRun the tests after editing.\n", "fixer.md");
		expect(r as any).toEqual({ agent: { name: "fixer", description: "Fixes small bugs", enabled: true, model: { provider: "p", model: "m", thinkingLevel: "low" }, tools: ["read", "edit", "bash"], maxTurns: 20, prompt: "Run the tests after editing." } });
	});

	test("defaults: file name, read-only tools, inherited model", () => {
		const r = parseAgentFile("---\ndescription: d\n---\n", "/x/finder.md") as any;
		expect(r.agent).toMatchObject({ name: "finder", model: null, tools: ["read", "grep", "ls"], enabled: true });
	});

	test("bad files are refused with a reason", () => {
		for (const t of ["no frontmatter", "---\ndescription: d\ntools: [delegate]\n---\n", "---\nname: Bad Name\ndescription: d\n---\n", "---\nname: a\n---\n", "---\ndescription: d\nmodel: nonsense\n---\n", "---\ndescription: d\nthinking: low\nmodel: p/m\nmaxTurns: 1\n---\n"]) {
			expect("error" in parseAgentFile(t, "a.md")).toBe(true);
		}
	});

	test("global files load, project files add to them, and the nearest one wins", () => {
		put("home/.agents/subagents/g.md", "---\ndescription: global one\n---\n");
		put("home/.agents/subagents/same.md", "---\ndescription: from global\n---\n");
		put("home/.agents/subagents/broken.md", "nothing");
		put("proj/.agents/subagents/same.md", "---\ndescription: from project\n---\n");
		put("proj/sub/.agents/subagents/same.md", "---\ndescription: from subdir\n---\n");
		const home = join(root, "home");
		const top = loadAgentFiles(join(root, "proj"), home);
		expect(top.agents.map((a) => `${a.name}:${a.description}`).sort()).toEqual(["g:global one", "same:from project"]);
		expect(top.warnings.map((w) => w.path)).toEqual([join(home, ".agents/subagents/broken.md")]);
		expect(loadAgentFiles(join(root, "proj/sub"), home).agents.find((a) => a.name === "same")!.description).toBe("from subdir");
	});
});

describe("nothing to advertise, nothing injected", () => {
	test("an empty list adds no sub-agent or skill text to the system prompt", () => {
		const p = buildSystemPrompt("base", [], [], []);
		expect(p).toBe("base");
		expect(buildSystemPrompt("base", [], [], [{ name: "a", description: "d" }])).toContain(agentsPrompt([{ name: "a", description: "d" }]));
	});
});
