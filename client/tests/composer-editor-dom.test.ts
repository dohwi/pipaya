import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { tokenizeComposer } from "../src/lib/composer-text";
import { domMatchesParts, getEditorSelection, moveEditorEdge, readEditorText, renderEditorDom, setEditorSelection, tokenBoundaryOffset } from "../src/lib/composer/editor-dom";

let win: Window;
let root: HTMLDivElement;

const known = {
	commands: ["prompt:daily", "snip:fix"],
	skills: [{ name: "orchestrate" }],
	mentions: ["미나", "D1", "D2"],
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

	test("moveEditorEdge leaves plain-text editors without token chips to native browser handling", () => {
		const parts = tokenizeComposer("plain text only", known);
		renderEditorDom(root, parts);
		setEditorSelection(root, 0, 0);
		expect(moveEditorEdge(root, "line-end", false)).toEqual({ handled: false, affinity: null });
	});

	test("moveEditorEdge moves from before a leading @mention chip to end of line and back (with and without Shift)", () => {
		const raw = "@D1 이랑 협업해서 깔끔하게 ㄱ";
		renderEditorDom(root, tokenizeComposer(raw, known));

		// Caret before @D1 (offset 0) -> End goes to raw.length
		setEditorSelection(root, 0, 0);
		expect(moveEditorEdge(root, "line-end", false)).toEqual({ handled: true, affinity: null });
		expect(getEditorSelection(root)).toEqual({ start: raw.length, end: raw.length });

		// Caret at end -> Home returns to offset 0 (before @D1)
		expect(moveEditorEdge(root, "line-start", false)).toEqual({ handled: true, affinity: null });
		expect(getEditorSelection(root)).toEqual({ start: 0, end: 0 });

		// Shift+End from before @D1 selects the whole line
		expect(moveEditorEdge(root, "line-end", true)).toEqual({ handled: true, affinity: null });
		expect(getEditorSelection(root)).toEqual({ start: 0, end: raw.length });

		// Shift+Home collapses back to the anchor at 0
		expect(moveEditorEdge(root, "line-start", true)).toEqual({ handled: true, affinity: null });
		expect(getEditorSelection(root)).toEqual({ start: 0, end: 0 });
	});

	test("moveEditorEdge handles solo chip, adjacent chips, multiline chips, and trailing empty lines", () => {
		// Solo chip
		renderEditorDom(root, tokenizeComposer("@D1", known));
		setEditorSelection(root, 0, 0);
		expect(moveEditorEdge(root, "line-end", false).handled).toBe(true);
		expect(getEditorSelection(root)).toEqual({ start: 3, end: 3 });
		expect(moveEditorEdge(root, "line-start", false).handled).toBe(true);
		expect(getEditorSelection(root)).toEqual({ start: 0, end: 0 });

		// Adjacent chips (no text node between them)
		const adj = "@D1@D2 tail";
		renderEditorDom(root, [
			{ kind: "mention", text: "@D1", name: "D1" },
			{ kind: "mention", text: "@D2", name: "D2" },
			{ kind: "text", text: " tail" },
		]);
		setEditorSelection(root, 0, 0);
		expect(moveEditorEdge(root, "line-end", false).handled).toBe(true);
		expect(getEditorSelection(root)).toEqual({ start: adj.length, end: adj.length });
		setEditorSelection(root, 3, 3); // between @D1 and @D2
		expect(moveEditorEdge(root, "line-start", false).handled).toBe(true);
		expect(getEditorSelection(root)).toEqual({ start: 0, end: 0 });

		// Multiline: leading chip on line 2 and trailing chip on line 3 + trailing newline
		const multi = "line1\n@D1 line2\nfoo @D2\n";
		renderEditorDom(root, tokenizeComposer(multi, known));
		const line2Start = "line1\n".length;
		const line2End = "line1\n@D1 line2".length;
		const line3Start = "line1\n@D1 line2\n".length;
		const line3End = "line1\n@D1 line2\nfoo @D2".length;

		// Before @D1 on line 2 -> End stays on line 2 (must not jump back to line 1)
		setEditorSelection(root, line2Start, line2Start);
		expect(moveEditorEdge(root, "line-end", false).handled).toBe(true);
		expect(getEditorSelection(root)).toEqual({ start: line2End, end: line2End });

		// End of line 2 -> Home returns to start of line 2 (before @D1, not line 1)
		expect(moveEditorEdge(root, "line-start", false).handled).toBe(true);
		expect(getEditorSelection(root)).toEqual({ start: line2Start, end: line2Start });

		// After trailing @D2 on line 3 -> Home goes to start of line 3 (not line 1)
		setEditorSelection(root, line3End, line3End);
		expect(moveEditorEdge(root, "line-start", false).handled).toBe(true);
		expect(getEditorSelection(root)).toEqual({ start: line3Start, end: line3Start });

		// Empty trailing line (before sentinel <br>) stays on the empty line
		setEditorSelection(root, multi.length, multi.length);
		expect(moveEditorEdge(root, "line-start", false).handled).toBe(true);
		expect(getEditorSelection(root)).toEqual({ start: multi.length, end: multi.length });
		expect(moveEditorEdge(root, "line-end", false).handled).toBe(true);
		expect(getEditorSelection(root)).toEqual({ start: multi.length, end: multi.length });

		// Document start / end jump across hard lines and respect Shift extension
		setEditorSelection(root, line2Start, line2Start);
		expect(moveEditorEdge(root, "doc-end", true).handled).toBe(true);
		expect(getEditorSelection(root)).toEqual({ start: line2Start, end: multi.length });
		expect(moveEditorEdge(root, "doc-start", true).handled).toBe(true);
		expect(getEditorSelection(root)).toEqual({ start: 0, end: line2Start });
		expect(moveEditorEdge(root, "doc-start", false).handled).toBe(true);
		expect(getEditorSelection(root)).toEqual({ start: 0, end: 0 });
	});

	test("moveEditorEdge splits soft-wrapped lines by geometry (including surrogate pairs) and preserves wrap affinity", () => {
		const raw = "@D1 aa😀bb ccdd";
		renderEditorDom(root, tokenizeComposer(raw, known));
		const chip = root.childNodes[0] as HTMLElement;
		const textNode = root.childNodes[1] as Text;
		// Visual line 0 (y=30): "@D1" + " aa😀bb " (local 0..8, plain 3..11)
		// Visual line 1 (y=54): "ccdd" (local 8..12, plain 11..15)
		const mkRect = (top: number, height = 20): DOMRect =>
			({ top, bottom: top + height, left: 0, right: 10, width: 10, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
		chip.getBoundingClientRect = () => mkRect(20);
		const origCreateRange = win.document.createRange.bind(win.document);
		win.document.createRange = (() => {
			const r = origCreateRange();
			r.getClientRects = (() => {
				if (r.startContainer === textNode) {
					const s = r.startOffset;
					const e = r.endOffset;
					if (s === e) return [mkRect(s < 8 ? 20 : 44)] as unknown as DOMRectList;
					const rects: DOMRect[] = [];
					if (s < 8) rects.push(mkRect(20));
					if (e > 8) rects.push(mkRect(44));
					return rects as unknown as DOMRectList;
				}
				return [] as unknown as DOMRectList;
			}) as typeof r.getClientRects;
			return r;
		}) as typeof win.document.createRange;

		// From before @D1 (0): End lands at end of visual line 0 (plain 11), with "end" affinity
		setEditorSelection(root, 0, 0);
		const r1 = moveEditorEdge(root, "line-end", false);
		expect(r1).toEqual({ handled: true, affinity: { pos: 11, side: "end" } });
		expect(getEditorSelection(root)).toEqual({ start: 11, end: 11 });

		// Pressing End again at the wrap boundary with "end" affinity stays on visual line 0
		const r2 = moveEditorEdge(root, "line-end", false, r1.affinity);
		expect(r2).toEqual({ handled: true, affinity: { pos: 11, side: "end" } });
		expect(getEditorSelection(root)).toEqual({ start: 11, end: 11 });

		// Pressing Home with "end" affinity returns to 0 (start of visual line 0)
		const r3 = moveEditorEdge(root, "line-start", false, r2.affinity);
		expect(r3).toEqual({ handled: true, affinity: null });
		expect(getEditorSelection(root)).toEqual({ start: 0, end: 0 });

		// From inside visual line 1 (plain 13): Home lands at start of visual line 1 (plain 11) with "start" affinity
		setEditorSelection(root, 13, 13);
		const r4 = moveEditorEdge(root, "line-start", false);
		expect(r4).toEqual({ handled: true, affinity: { pos: 11, side: "start" } });
		expect(getEditorSelection(root)).toEqual({ start: 11, end: 11 });

		// Pressing End with "start" affinity moves to end of visual line 1 (plain 15)
		const r5 = moveEditorEdge(root, "line-end", false, r4.affinity);
		expect(r5).toEqual({ handled: true, affinity: null });
		expect(getEditorSelection(root)).toEqual({ start: raw.length, end: raw.length });
	});

	test("moveEditorEdge skips non-flat wrapper DOM and selections outside the editor", () => {
		root.innerHTML = '<div><span class="tok mention" contenteditable="false" data-token="@D1">@D1</span> hi</div>';
		setEditorSelection(root, 0, 0);
		expect(moveEditorEdge(root, "line-end", false)).toEqual({ handled: false, affinity: null });

		renderEditorDom(root, tokenizeComposer("@D1 hi", known));
		const outside = win.document.createElement("div");
		outside.textContent = "elsewhere";
		win.document.body.appendChild(outside);
		const sel = win.document.getSelection()!;
		const r = win.document.createRange();
		r.setStart(outside.firstChild!, 0);
		r.collapse(true);
		sel.removeAllRanges();
		sel.addRange(r);
		expect(moveEditorEdge(root, "line-end", false)).toEqual({ handled: false, affinity: null });
	});
});
