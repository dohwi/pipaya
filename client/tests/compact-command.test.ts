import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { argumentSuggestions, COMMANDS, commandQuery, commandText, isCommandInput, isSkillCall, matchCommands, matchSkills, parseSlash } from "../src/lib/commands";

let dir: string;
let commands: {
	argumentSuggestions: typeof argumentSuggestions;
	parseSlash: typeof parseSlash;
	matchSkills: typeof matchSkills;
	isSkillCall: typeof isSkillCall;
	matchCommands: typeof matchCommands;
	commandQuery: typeof commandQuery;
	commandText: typeof commandText;
	isCommandInput: typeof isCommandInput;
	COMMANDS: typeof COMMANDS;
	app: { activeId: string | null; calls: string[] };
};

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "pipaya-compact-command-"));
	// Bundle the real command registry with a local store double; no global module mocks.
	const build = await Bun.build({
		entrypoints: [resolve("src/lib/commands.ts")], target: "bun",
		plugins: [{ name: "command-store", setup(builder) {
			builder.onLoad({ filter: /extensions\/host\.svelte\.ts$/ }, () => ({
				contents: `export const extensions = { commands: [] };`, loader: "js",
			}));
			builder.onLoad({ filter: /store\.svelte\.ts$/ }, () => ({
				contents: `export const app = { activeId: "session", calls: [], async compact(arg) { this.calls.push(arg); } };`,
				loader: "js",
			}));
			builder.onLoad({ filter: /\/commands\.ts$/ }, async ({ path }) => ({
				contents: `${await Bun.file(path).text()}\nexport { app };`, loader: "ts",
			}));
		} }],
	});
	if (!build.success) throw new Error(build.logs.join("\n"));
	const file = join(dir, "commands.mjs");
	await writeFile(file, await build.outputs[0]!.text());
	commands = await import(file);
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe("default commands", () => {
	test("supports /compact with optional summary instructions", async () => {
		for (const [input, arg] of [
			["/compact", ""],
			["/compact API 계약과 수정 파일 보존", "API 계약과 수정 파일 보존"],
			["  /COMPACT 결정 사항 보존  ", "결정 사항 보존"],
		]) {
			const parsed = commands.parseSlash(input)!;
			expect(parsed.cmd.name).toBe("compact");
			expect(parsed.arg).toBe(arg);
			await parsed.cmd.run(parsed.arg);
			expect(commands.app.calls.at(-1)).toBe(arg);
		}
	});

	test("appears in slash autocomplete only with an open conversation", () => {
		for (const query of ["", "comp", "compact"]) {
			expect(commands.matchCommands(query).some((c) => c.name === "compact")).toBe(true);
		}
		commands.app.activeId = null;
		try {
			expect(commands.matchCommands("comp").some((c) => c.name === "compact")).toBe(false);
		} finally { commands.app.activeId = "session"; }
	});

	test("removed UI commands are absent from the registry, autocomplete, and argument suggestions", () => {
		for (const name of ["sidebar", "model", "thinking", "help"]) {
			expect(commands.COMMANDS.some((cmd) => cmd.name === name)).toBe(false);
			expect(commands.matchCommands("").some((cmd) => cmd.name === name)).toBe(false);
			expect(commands.matchCommands(name)).toEqual([]);
			expect(commands.parseSlash(`/${name}`)).toBeNull();
			expect(commands.parseSlash(`/${name} high`)).toBeNull();
			expect(commands.argumentSuggestions(`/${name} `)).toBeNull();
		}
	});

	test("suggestion lookup does not hijack command names, free text, or multiline input", () => {
		for (const input of ["/compact", "/compact instructions", "/rename title", "/unknown ", "ordinary message", "/thinking high\nlow"]) {
			expect(commands.argumentSuggestions(input)).toBeNull();
		}
	});

	test("uses one English name per command with a stable default order", () => {
		const names = commands.COMMANDS.map((c) => c.name);
		expect(names).toEqual(["new", "resume", "rename", "close", "cd", "compact", "retry", "stop", "cancel", "fork", "tree", "copy", "delete"]);
		expect(new Set(names).size).toBe(names.length);
		for (const cmd of commands.COMMANDS) {
			expect(cmd.name).toMatch(/^[a-z]+$/);
			expect("aliases" in cmd).toBe(false);
			expect(commands.commandText(cmd)).toBe(`/${cmd.name}`);
			expect(commands.parseSlash(commands.commandText(cmd))?.cmd.name).toBe(cmd.name);
		}
	});

	test("there is no /skills command: skills are managed from the footer badge", () => {
		expect(commands.COMMANDS.some((c) => c.name === "skills")).toBe(false);
		expect(commands.parseSlash("/skills")).toBeNull();
	});

	test("does not parse translated, duplicate, or legacy command names", () => {
		for (const name of ["압축", "새대화", "재개", "모델", "추론", "도움말", "open", "think", "abort", "branch", "rm", "?"]) {
			expect(commands.parseSlash(`/${name}`)).toBeNull();
		}
		expect(commands.parseSlash("./compact")).toBeNull();
		expect(commands.matchCommands("압축")).toEqual([]);
		expect(commands.matchCommands("요약")).toEqual([]);
	});

	test("autocomplete uses / without matching paths or command arguments", () => {
		for (const [input, query] of [["/", ""], ["/comp", "comp"], ["/compact", "compact"]]) {
			expect(commands.commandQuery(input!)).toBe(query);
		}
		for (const input of ["./", "/compact instructions", "/src/file.ts", "/README.md", "message"]) {
			expect(commands.commandQuery(input)).toBeNull();
		}
	});

	test("unknown command-shaped input is blocked without reserving file paths", () => {
		for (const input of ["/compcat", "/압축", "/unknown instructions"]) {
			expect(commands.isCommandInput(input)).toBe(true);
			expect(commands.parseSlash(input)).toBeNull();
		}
		for (const input of ["./compact", "./src/file.ts", "./README.md", "/tmp/file", "/README.md", "normal message"]) {
			expect(commands.isCommandInput(input)).toBe(false);
			expect(commands.parseSlash(input)).toBeNull();
		}
	});
});

describe("/skill:name calls", () => {
	const skills = [{ name: "pipaya-usage" }, { name: "release-notes" }];

	test("are not client commands and are never rejected as unknown", () => {
		expect(commands.parseSlash("/skill:pipaya-usage check")).toBeNull();
		expect(commands.isSkillCall("  /skill:pipaya-usage check")).toBe(true);
		expect(commands.isCommandInput("/skill:pipaya-usage check")).toBe(false);
		expect(commands.isCommandInput("/nope check")).toBe(true);
	});

	test("the menu query accepts the skill: prefix", () => {
		expect(commands.commandQuery("/skill:rel")).toBe("skill:rel");
		expect(commands.matchCommands("skill:rel")).toEqual([]);
	});

	test("matches by full name, prefix and part of the name", () => {
		expect(commands.matchSkills(skills, "").map((k) => k.name)).toEqual(["pipaya-usage", "release-notes"]);
		expect(commands.matchSkills(skills, "skill:rel").map((k) => k.name)).toEqual(["release-notes"]);
		expect(commands.matchSkills(skills, "usage").map((k) => k.name)).toEqual(["pipaya-usage"]);
		expect(commands.matchSkills(skills, "zzz")).toEqual([]);
	});
});
