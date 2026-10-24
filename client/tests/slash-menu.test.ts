import { describe, expect, test } from "bun:test";
import { fileRows, folderRows, mentionRows, menuKey, menuKindOf, menuOpen, optionRows, slashRows } from "../src/lib/slash-menu";

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
	test("argument options and mentions keep their own fields", () => {
		expect(optionRows([{ value: "high", desc: "d", current: true }])).toEqual([{ id: "high", text: "high", desc: "d", current: true }]);
		expect(mentionRows([{ insert: "@a", desc: "d", group: "g" }])).toEqual([{ id: "@a", text: "@a", desc: "d", group: "g" }]);
	});
});

describe("which menu the typing asks for", () => {
	const base = { slashQuery: null, hasArgSuggestions: false, cdArg: null, fileMention: false, atMention: false };
	test("nothing special means no menu", () => {
		expect(menuKindOf(base)).toBe("none");
	});
	test("each kind is recognised", () => {
		expect(menuKindOf({ ...base, cdArg: "~/w" })).toBe("cd");
		expect(menuKindOf({ ...base, fileMention: true })).toBe("file");
		expect(menuKindOf({ ...base, atMention: true })).toBe("mention");
		expect(menuKindOf({ ...base, slashQuery: "mo" })).toBe("slash");
		expect(menuKindOf({ ...base, hasArgSuggestions: true })).toBe("slash");
	});
	test("an empty /cd argument still counts (it lists the folders)", () => {
		expect(menuKindOf({ ...base, cdArg: "" })).toBe("cd");
	});
	test("when several apply the order is cd, file, mention, slash", () => {
		const all = { slashQuery: "", hasArgSuggestions: true, cdArg: "x", fileMention: true, atMention: true };
		expect(menuKindOf(all)).toBe("cd");
		expect(menuKindOf({ ...all, cdArg: null })).toBe("file");
		expect(menuKindOf({ ...all, cdArg: null, fileMention: false })).toBe("mention");
		expect(menuKindOf({ ...all, cdArg: null, fileMention: false, atMention: false })).toBe("slash");
	});
});

describe("whether the menu shows", () => {
	const s = { dismissed: false, cdRows: 0, fileLoaded: false, files: 0, images: 0, mentions: 0, attachments: 0 };
	test("no kind, no menu", () => {
		expect(menuOpen("none", s)).toBe(false);
	});
	test("folders show once there are rows", () => {
		expect(menuOpen("cd", s)).toBe(false);
		expect(menuOpen("cd", { ...s, cdRows: 2 })).toBe(true);
	});
	test("files wait for the first answer unless there is already something to show", () => {
		expect(menuOpen("file", s)).toBe(false);
		expect(menuOpen("file", { ...s, fileLoaded: true })).toBe(true);
		expect(menuOpen("file", { ...s, files: 1 })).toBe(true);
		expect(menuOpen("file", { ...s, images: 1 })).toBe(true);
	});
	test("mentions show only when something matches", () => {
		expect(menuOpen("mention", s)).toBe(false);
		expect(menuOpen("mention", { ...s, mentions: 1 })).toBe(true);
	});
	test("a /command menu steps aside once images are attached", () => {
		expect(menuOpen("slash", s)).toBe(true);
		expect(menuOpen("slash", { ...s, attachments: 1 })).toBe(false);
	});
	test("Esc closes any of them", () => {
		expect(menuOpen("slash", { ...s, dismissed: true })).toBe(false);
		expect(menuOpen("cd", { ...s, cdRows: 3, dismissed: true })).toBe(false);
		expect(menuOpen("file", { ...s, files: 3, dismissed: true })).toBe(false);
		expect(menuOpen("mention", { ...s, mentions: 3, dismissed: true })).toBe(false);
	});
});

describe("keys of an open menu", () => {
	const at = (key: string, over = {}) => menuKey(key, { index: 0, count: 3, kind: "slash", shift: false, touch: false, ...over });
	test("arrows move and wrap around", () => {
		expect(at("ArrowDown")).toEqual({ do: "move", to: 1 });
		expect(at("ArrowDown", { index: 2 })).toEqual({ do: "move", to: 0 });
		expect(at("ArrowUp")).toEqual({ do: "move", to: 2 });
	});
	test("with no rows the arrows are left to the input", () => {
		expect(at("ArrowDown", { count: 0 })).toBeNull();
	});
	test("Esc dismisses even with no rows", () => {
		expect(at("Escape", { count: 0 })).toEqual({ do: "dismiss" });
	});
	test("Tab completes only when there is a row", () => {
		expect(at("Tab")).toEqual({ do: "complete" });
		expect(at("Tab", { count: 0 })).toBeNull();
	});
	test("Enter picks on a desktop keyboard, and is a newline on a phone or with Shift", () => {
		expect(at("Enter")).toEqual({ do: "pick" });
		expect(at("Enter", { touch: true })).toBeNull();
		expect(at("Enter", { shift: true })).toBeNull();
		expect(at("Enter", { count: 0 })).toBeNull();
	});
	test("in the folder menu Enter first tries to enter the chosen folder, even with no rows", () => {
		expect(at("Enter", { kind: "cd" })).toEqual({ do: "enter-folder" });
		expect(at("Enter", { kind: "cd", count: 0 })).toEqual({ do: "enter-folder" });
		expect(at("Enter", { kind: "cd", touch: true })).toBeNull();
	});
	test("other keys are not the menu's", () => {
		expect(at("a")).toBeNull();
	});
});
