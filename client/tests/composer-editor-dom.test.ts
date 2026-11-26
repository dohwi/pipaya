import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { tokenizeComposer } from "../src/lib/composer-text";
import { domMatchesParts, getEditorSelection, readEditorText, renderEditorDom, setEditorSelection, tokenBoundaryOffset } from "../src/lib/composer/editor-dom";

let win: Window;
let root: HTMLDivElement;

const known = {
	commands: ["prompt:daily", "snip:fix"],
	skills: [{ name: "orchestrate" }],
	mentions: ["미나"],
	images: 2,
	paths: ["LICENSE", "src/a.ts"],
};

beforeEach(() => {
	win = new Window();
	root = win.document.createElement("div") as unknown as HTMLDivElement;
	root.contentEditable = "true";
	win.document.body.appendChild(root as unknown as Node);
});

afterEach(() => {
	win.close();
});

describe("composer editor-dom", () => {
	test("renders empty state cleanly without leftover nodes", () => {
		renderEditorDom(root, []);
		expect(root.childNodes.length).toBe(0);
		expect(readEditorText(root)).toBe("");
		expect(domMatchesParts(root, [])).toBe(true);
	});

	test("renders all token kinds with matching classes, icons, and labels, and round-trips raw text", () => {
		const raw = "#image1 #src/a.ts:12 #LICENSE @미나랑 /skill:orchestrate /prompt:daily";
		const parts = tokenizeComposer(raw, known);
		renderEditorDom(root, parts);

		expect(readEditorText(root)).toBe(raw);
		expect(domMatchesParts(root, parts)).toBe(true);

		const chips = [...root.querySelectorAll<HTMLElement>("[data-token]")];
		expect(chips.map((c) => c.dataset.token)).toEqual(["#image1", "#src/a.ts:12", "#LICENSE", "@미나", "/skill:orchestrate", "/prompt:daily"]);
		expect(chips.every((c) => c.contentEditable === "false")).toBe(true);

		// image chip drops # and carries an icon
		expect(chips[0]!.className).toBe("tok image");
		expect(chips[0]!.querySelector("svg.ic")).not.toBeNull();
		expect(chips[0]!.querySelector(".tlabel")?.textContent).toBe("image1");

		// file chip splits dir/base and carries an icon
		expect(chips[1]!.className).toBe("tok file");
		expect(chips[1]!.querySelector("svg.ic")).not.toBeNull();
		expect(chips[1]!.querySelector(".dir")?.textContent).toBe("src/");
		expect(chips[1]!.querySelector(".base")?.textContent).toBe("a.ts:12");

		// extensionless file chip drops # and falls back to .tlabel
		expect(chips[2]!.className).toBe("tok file");
		expect(chips[2]!.querySelector(".tlabel")?.textContent).toBe("LICENSE");

		// mention chip has no icon
		expect(chips[3]!.className).toBe("tok mention");
		expect(chips[3]!.querySelector("svg.ic")).toBeNull();
		expect(chips[3]!.textContent).toBe("@미나");

		// skill & prompt chips share .skill class with their respective icons
		expect(chips[4]!.className).toBe("tok skill");
		expect(chips[4]!.querySelector("svg.ic")).not.toBeNull();
		expect(chips[5]!.className).toBe("tok skill");
		expect(chips[5]!.querySelector("svg.ic")).not.toBeNull();
	});

	test("handles multiline text and trailing newline sentinel without leaking extra newlines", () => {
		const raw = "#image1\n두 번째 줄\n";
		const parts = tokenizeComposer(raw, known);
		renderEditorDom(root, parts);

		expect(readEditorText(root)).toBe(raw);
		expect(domMatchesParts(root, parts)).toBe(true);
		const brs = root.querySelectorAll("br");
		expect(brs.length).toBe(3); // 2 real \n + 1 trailing sentinel
		expect((brs[2] as HTMLElement).dataset.sentinel).toBe("");
	});

	test("reads browser-inserted <div> and <div><br></div> wrappers back to plain newlines", () => {
		root.innerHTML = 'first<div>second</div><div><br></div><div>third</div>';
		expect(readEditorText(root)).toBe("first\nsecond\n\nthird");
	});

	test("maps plain offsets to and from DOM selection around chips and newlines", () => {
		const raw = "hi #image1\n/skill:orchestrate end";
		const parts = tokenizeComposer(raw, known);
		renderEditorDom(root, parts);

		// Caret inside plain text, before chip, after chip, after newline, end
		for (const pos of [0, 2, 3, 10, 11, 29, 30, raw.length]) {
			setEditorSelection(root, pos, pos);
			expect(getEditorSelection(root)).toEqual({ start: pos, end: pos });
		}

		// Range spanning across chips
		setEditorSelection(root, 3, 29);
		expect(getEditorSelection(root)).toEqual({ start: 3, end: 29 });
	});

	test("computes exact before/after offsets for clicking a chip", () => {
		const raw = "see #image1 and #LICENSE";
		const parts = tokenizeComposer(raw, known);
		renderEditorDom(root, parts);
		const chips = [...root.querySelectorAll<HTMLElement>("[data-token]")];
		expect(tokenBoundaryOffset(root, chips[0]!, "before")).toBe(4);
		expect(tokenBoundaryOffset(root, chips[0]!, "after")).toBe(11);
		expect(tokenBoundaryOffset(root, chips[1]!, "before")).toBe(16);
		expect(tokenBoundaryOffset(root, chips[1]!, "after")).toBe(24);
	});
});
