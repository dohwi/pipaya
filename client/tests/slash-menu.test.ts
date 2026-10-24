import { describe, expect, test } from "bun:test";
import { fileRows, folderRows, memberRows, optionRows, slashRows } from "../src/lib/slash-menu";

describe("recommendation menu rows", () => {
	test("commands, skills and extension commands each get their own heading and text", () => {
		const rows = slashRows([
			{ command: { name: "model", args: "[name]", desc: "pick a model" } },
			{ skill: { name: "review", description: "review code" } },
			{ family: { prefix: "prompt", label: "Prompts", name: "fix", description: "fix it", args: "<what>" } },
		]);
		expect(rows).toEqual([
			{ id: "model", text: "/model", args: "[name]", desc: "pick a model", group: "명령" },
			{ id: "skill:review", text: "/skill:review", desc: "review code", tag: "스킬", group: "스킬" },
			{ id: "prompt:fix", text: "/prompt:fix", args: "<what>", desc: "fix it", tag: "Prompts", group: "Prompts" },
		]);
	});
	test("images come before files, and a folder is labelled", () => {
		const rows = fileRows([{ n: 2, name: "a.png" }], [{ path: "src", dir: true }, { path: "a.ts", dir: false }]);
		expect(rows.map((r) => [r.id, r.text, r.group, r.desc])).toEqual([
			["image2", "#image2", "이미지", "a.png"],
			["src", "#src", "파일", "폴더"],
			["a.ts", "#a.ts", "파일", ""],
		]);
	});
	test("folders insert the typed prefix plus the name", () => {
		expect(folderRows([{ name: "docs", path: "/w/docs" }], (n) => `~/${n}/`)).toEqual([{ id: "/w/docs", text: "~/docs/", desc: "", group: "폴더" }]);
	});
	test("argument options and members keep their own fields", () => {
		expect(optionRows([{ value: "high", desc: "d", current: true }])).toEqual([{ id: "high", text: "high", desc: "d", current: true }]);
		expect(memberRows([{ insert: "@a", desc: "d", group: "g" }])).toEqual([{ id: "@a", text: "@a", desc: "d", group: "g" }]);
	});
});
