/**
 * Pure DOM helpers for the contenteditable composer: serialising text + atomic inline token chips back to a plain
 * draft string, mapping plain character offsets to and from DOM Selection ranges, and reconciling token chip nodes
 * without touching the DOM during ordinary plain-text typing (preserving native undo and IME composition).
 */
import type { ComposerPart } from "../composer-text";
import { formatFileLine, splitFilePath, splitFileRef } from "../files";
import { ICON_PATHS, type IconName } from "../icons";
import type { EdgeNavTarget } from "./input-keys";

const SVG_NS = "http://www.w3.org/2000/svg";
const ZWS = /\u200b/g;

function cleanText(s: string): string {
	return s.includes("\u200b") ? s.replace(ZWS, "") : s;
}

function isTokenEl(node: Node): node is HTMLElement {
	return node.nodeType === 1 && (node as HTMLElement).dataset?.token !== undefined;
}

function isBr(node: Node): node is HTMLBRElement {
	return node.nodeType === 1 && (node as HTMLElement).tagName === "BR";
}

function isSentinelBr(node: Node): boolean {
	return isBr(node) && (node as HTMLElement).dataset?.sentinel !== undefined;
}

function isBlockWrapper(node: Node): node is HTMLElement {
	if (node.nodeType !== 1) return false;
	const tag = (node as HTMLElement).tagName;
	return tag === "DIV" || tag === "P";
}

/**
 * Walk `root` and reconstruct the plain draft string. Atomic chips contribute their `data-token` verbatim; `<br>`
 * contributes `\n` (except a trailing `data-sentinel` `<br>` used only so the browser renders an empty last line).
 * Handles browser-inserted `<div>`/`<p>` wrappers gracefully in case a paste or Enter creates one before reconciliation.
 */
export function readEditorText(root: HTMLElement): string {
	let out = "";
	const walk = (parent: Node) => {
		const children = parent.childNodes;
		for (let i = 0; i < children.length; i++) {
			const child = children[i]!;
			if (child.nodeType === 3) {
				out += cleanText(child.nodeValue ?? "");
			} else if (isTokenEl(child)) {
				out += child.dataset.token ?? "";
			} else if (isBr(child)) {
				if (isSentinelBr(child)) continue;
				// A single <br> inside an otherwise empty browser-inserted <div><br></div> represents just that line's break.
				if (isBlockWrapper(parent) && children.length === 1 && i === 0) continue;
				out += "\n";
			} else if (isBlockWrapper(child)) {
				if (out.length > 0) out += "\n";
				walk(child);
				// Empty block wrapper like <div><br></div> at the very start still contributes a newline.
				if (child.childNodes.length === 1 && isBr(child.firstChild!)) {
					if (i === 0 && out.length === 0) out += "\n";
				}
			} else if (child.nodeType === 1) {
				walk(child);
			}
		}
	};
	walk(root);
	return out;
}

/** Plain-text length contributed by a single child subtree under `root`. */
function nodeTextLength(node: Node, parent: Node, siblingIndex: number, siblingCount: number): number {
	if (node.nodeType === 3) return cleanText(node.nodeValue ?? "").length;
	if (isTokenEl(node)) return (node.dataset.token ?? "").length;
	if (isBr(node)) {
		if (isSentinelBr(node)) return 0;
		if (isBlockWrapper(parent) && siblingCount === 1 && siblingIndex === 0) return 0;
		return 1;
	}
	if (node.nodeType === 1) {
		let total = 0;
		const kids = node.childNodes;
		for (let i = 0; i < kids.length; i++) total += nodeTextLength(kids[i]!, node, i, kids.length);
		return total;
	}
	return 0;
}

/** Convert a DOM `(container, offset)` point inside `root` into a plain-text character offset. */
function pointToOffset(root: HTMLElement, targetNode: Node, targetOffset: number): number {
	// If the point landed inside an atomic token chip, snap to its start or end.
	let cur: Node | null = targetNode;
	while (cur && cur !== root) {
		if (isTokenEl(cur)) {
			const before = pointToOffset(root, cur.parentNode!, Array.prototype.indexOf.call(cur.parentNode!.childNodes, cur));
			return targetOffset === 0 && targetNode === cur ? before : before + (cur.dataset.token ?? "").length;
		}
		cur = cur.parentNode;
	}

	let offset = 0;
	let found = false;

	const walk = (parent: Node) => {
		const children = parent.childNodes;
		if (parent === targetNode) {
			const limit = Math.min(targetOffset, children.length);
			for (let i = 0; i < limit; i++) {
				const child = children[i]!;
				if (isBlockWrapper(child) && offset > 0) offset += 1;
				offset += nodeTextLength(child, parent, i, children.length);
			}
			found = true;
			return;
		}
		for (let i = 0; i < children.length; i++) {
			if (found) return;
			const child = children[i]!;
			if (child === targetNode) {
				if (child.nodeType === 3) {
					const raw = child.nodeValue ?? "";
					offset += cleanText(raw.slice(0, Math.min(targetOffset, raw.length))).length;
				} else if (isTokenEl(child)) {
					offset += targetOffset > 0 ? (child.dataset.token ?? "").length : 0;
				} else if (isBlockWrapper(child)) {
					if (offset > 0) offset += 1;
					const limit = Math.min(targetOffset, child.childNodes.length);
					for (let j = 0; j < limit; j++) offset += nodeTextLength(child.childNodes[j]!, child, j, child.childNodes.length);
				} else if (child.nodeType === 1) {
					const limit = Math.min(targetOffset, child.childNodes.length);
					for (let j = 0; j < limit; j++) offset += nodeTextLength(child.childNodes[j]!, child, j, child.childNodes.length);
				}
				found = true;
				return;
			}
			if (child.nodeType === 3) {
				offset += cleanText(child.nodeValue ?? "").length;
			} else if (isTokenEl(child)) {
				offset += (child.dataset.token ?? "").length;
			} else if (isBr(child)) {
				if (!isSentinelBr(child) && !(isBlockWrapper(parent) && children.length === 1 && i === 0)) offset += 1;
			} else if (isBlockWrapper(child)) {
				if (offset > 0) offset += 1;
				walk(child);
			} else if (child.nodeType === 1) {
				walk(child);
			}
		}
	};

	walk(root);
	return offset;
}

/**
 * Read the current DOM Selection as plain-text `[start, end]` offsets relative to `root`.
 * Returns `null` when the selection is outside `root` (e.g. focus is elsewhere).
 */
export function getEditorSelection(root: HTMLElement): { start: number; end: number } | null {
	const sel = root.ownerDocument.getSelection();
	if (!sel || sel.rangeCount === 0) return null;
	const range = sel.getRangeAt(0);
	if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
	const a = pointToOffset(root, range.startContainer, range.startOffset);
	const b = range.collapsed ? a : pointToOffset(root, range.endContainer, range.endOffset);
	return a <= b ? { start: a, end: b } : { start: b, end: a };
}

/** Resolve a plain-text character offset into a DOM `(node, offset)` inside a normalised flat `root`. */
function offsetToPoint(root: HTMLElement, target: number): { node: Node; offset: number } {
	const kids = root.childNodes;
	let acc = 0;
	let lastNonSentinel = 0;
	for (let i = 0; i < kids.length; i++) {
		const child = kids[i]!;
		if (isSentinelBr(child)) break;
		lastNonSentinel = i + 1;
		if (child.nodeType === 3) {
			const data = child.nodeValue ?? "";
			const len = cleanText(data).length;
			if (target <= acc + len) {
				return { node: child, offset: Math.max(0, Math.min(target - acc, data.length)) };
			}
			acc += len;
		} else if (isTokenEl(child)) {
			const len = (child.dataset.token ?? "").length;
			if (target <= acc) return { node: root, offset: i };
			if (target <= acc + len) {
				const next = kids[i + 1];
				if (next && next.nodeType === 3) return { node: next, offset: 0 };
				return { node: root, offset: i + 1 };
			}
			acc += len;
		} else if (isBr(child)) {
			if (target <= acc) return { node: root, offset: i };
			if (target === acc + 1) {
				const next = kids[i + 1];
				if (next && next.nodeType === 3) return { node: next, offset: 0 };
				return { node: root, offset: i + 1 };
			}
			acc += 1;
		}
	}
	return { node: root, offset: lastNonSentinel };
}

/** Move the browser Selection inside `root` to plain-text offsets `[start, end]`. */
export function setEditorSelection(root: HTMLElement, start: number, end = start): void {
	const sel = root.ownerDocument.getSelection();
	if (!sel) return;
	const a = offsetToPoint(root, Math.max(0, start));
	const b = end === start ? a : offsetToPoint(root, Math.max(0, end));
	const range = root.ownerDocument.createRange();
	range.setStart(a.node, a.offset);
	range.setEnd(b.node, b.offset);
	sel.removeAllRanges();
	sel.addRange(range);
}

/** Plain-text offset right before or right after a rendered token chip inside `root`. */
export function tokenBoundaryOffset(root: HTMLElement, chip: HTMLElement, side: "before" | "after"): number {
	const idx = Array.prototype.indexOf.call(root.childNodes, chip);
	if (idx < 0) return readEditorText(root).length;
	const before = pointToOffset(root, root, idx);
	return side === "before" ? before : before + (chip.dataset.token ?? "").length;
}

/**
 * Remembers which side of an internal soft-wrap boundary a caret landed on (downstream `"start"` of the lower visual
 * line vs upstream `"end"` of the upper visual line), since programmatic DOM Ranges cannot set Blink's internal affinity.
 */
export interface WrapAffinity {
	pos: number;
	side: "start" | "end";
}

function setDirectionalSelection(root: HTMLElement, anchor: number, focus: number): void {
	const sel = root.ownerDocument.getSelection();
	if (!sel) return;
	const a = offsetToPoint(root, Math.max(0, anchor));
	const b = focus === anchor ? a : offsetToPoint(root, Math.max(0, focus));
	if (focus !== anchor && typeof sel.setBaseAndExtent === "function") {
		sel.setBaseAndExtent(a.node, a.offset, b.node, b.offset);
		return;
	}
	const [lo, hi] = anchor <= focus ? [a, b] : [b, a];
	const range = root.ownerDocument.createRange();
	range.setStart(lo.node, lo.offset);
	range.setEnd(hi.node, hi.offset);
	sel.removeAllRanges();
	sel.addRange(range);
}

type HardLineItem =
	| { kind: "text"; node: Text; start: number; end: number }
	| { kind: "token"; node: HTMLElement; start: number; end: number };

interface HardLine {
	start: number;
	end: number;
	items: HardLineItem[];
}

interface VisualLine {
	start: number;
	end: number;
	y: number;
}

function findHardLine(root: HTMLElement, focusPos: number): HardLine {
	const kids = root.childNodes;
	let acc = 0;
	let lineStart = 0;
	let items: HardLineItem[] = [];
	for (let i = 0; i < kids.length; i++) {
		const child = kids[i]!;
		if (isSentinelBr(child)) break;
		if (isBr(child)) {
			if (focusPos <= acc) return { start: lineStart, end: acc, items };
			acc += 1;
			lineStart = acc;
			items = [];
		} else if (child.nodeType === 3) {
			const len = cleanText(child.nodeValue ?? "").length;
			items.push({ kind: "text", node: child as Text, start: acc, end: acc + len });
			acc += len;
		} else if (isTokenEl(child)) {
			const len = (child.dataset.token ?? "").length;
			items.push({ kind: "token", node: child, start: acc, end: acc + len });
			acc += len;
		}
	}
	return { start: lineStart, end: acc, items };
}

function snapCharStart(raw: string, i: number): number {
	if (i > 0 && i < raw.length) {
		const lo = raw.charCodeAt(i);
		const hi = raw.charCodeAt(i - 1);
		if (lo >= 0xdc00 && lo <= 0xdfff && hi >= 0xd800 && hi <= 0xdbff) return i - 1;
	}
	return i;
}

function stepCharEnd(raw: string, i: number): number {
	if (i + 1 < raw.length) {
		const hi = raw.charCodeAt(i);
		const lo = raw.charCodeAt(i + 1);
		if (hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) return i + 2;
	}
	return i + 1;
}

function charMidY(range: Range, node: Text, raw: string, idx: number): number | null {
	const s = snapCharStart(raw, idx);
	const e = stepCharEnd(raw, s);
	range.setStart(node, s);
	range.setEnd(node, e);
	const rects = range.getClientRects();
	for (let i = 0; i < rects.length; i++) {
		const r = rects[i]!;
		if (r.height > 0) return (r.top + r.bottom) / 2;
	}
	const box = range.getBoundingClientRect();
	return box.height > 0 ? (box.top + box.bottom) / 2 : null;
}

function textNodeYBounds(range: Range, node: Text, rawLen: number): { min: number; max: number } | null {
	if (rawLen <= 0) return null;
	range.setStart(node, 0);
	range.setEnd(node, rawLen);
	const rects = range.getClientRects();
	let min = Infinity;
	let max = -Infinity;
	for (let i = 0; i < rects.length; i++) {
		const r = rects[i]!;
		if (r.height <= 0) continue;
		const y = (r.top + r.bottom) / 2;
		if (y < min) min = y;
		if (y > max) max = y;
	}
	return min <= max ? { min, max } : null;
}

function splitWrappedTextNode(doc: Document, node: Text, baseOffset: number, fallbackY: number, tol: number): VisualLine[] {
	const raw = node.nodeValue ?? "";
	if (!raw.length) return [];
	const hasZws = raw.includes("\u200b");
	const plainAt = (i: number) => (hasZws ? cleanText(raw.slice(0, i)).length : i);
	const range = doc.createRange();
	const runs: VisualLine[] = [];
	let pos = 0;
	let prevY = fallbackY;

	while (pos < raw.length) {
		let lineY = charMidY(range, node, raw, pos);
		if (lineY === null) {
			for (let probe = stepCharEnd(raw, pos); probe < raw.length; probe = stepCharEnd(raw, probe)) {
				lineY = charMidY(range, node, raw, probe);
				if (lineY !== null) break;
			}
			if (lineY === null) lineY = prevY;
		}
		prevY = lineY;

		let lo = pos;
		let hi = raw.length - 1;
		let best = pos;
		while (lo <= hi) {
			const mid = snapCharStart(raw, (lo + hi) >> 1);
			let y = charMidY(range, node, raw, mid);
			if (y === null) {
				for (let p = stepCharEnd(raw, mid); p <= hi; p = stepCharEnd(raw, p)) {
					y = charMidY(range, node, raw, p);
					if (y !== null) break;
				}
			}
			if (y === null || Math.abs(y - lineY) <= tol) {
				best = mid;
				lo = stepCharEnd(raw, mid);
			} else {
				hi = mid - 1;
			}
		}

		const nextPos = stepCharEnd(raw, best);
		runs.push({ start: baseOffset + plainAt(pos), end: baseOffset + plainAt(nextPos), y: lineY });
		pos = nextPos;
	}
	return runs;
}

function measureVisualLines(root: HTMLElement, line: HardLine): VisualLine[] {
	if (line.items.length === 0) return [{ start: line.start, end: line.end, y: 0 }];
	const doc = root.ownerDocument;
	const view = doc.defaultView;
	const lh = (view ? Number.parseFloat(view.getComputedStyle(root).lineHeight) : Number.NaN) || 24;
	const tol = lh * 0.5;
	const probeRange = doc.createRange();

	// Fast check: if all items on this hard line share one visual line (or layout is unmeasured, e.g. happy-dom), skip splitting.
	let minY = Infinity;
	let maxY = -Infinity;
	const bounds: Array<{ min: number; max: number } | null> = [];
	for (const item of line.items) {
		let b: { min: number; max: number } | null = null;
		if (item.kind === "token") {
			const r = item.node.getBoundingClientRect();
			if (r.height > 0) {
				const y = (r.top + r.bottom) / 2;
				b = { min: y, max: y };
			}
		} else {
			b = textNodeYBounds(probeRange, item.node, (item.node.nodeValue ?? "").length);
		}
		bounds.push(b);
		if (b) {
			if (b.min < minY) minY = b.min;
			if (b.max > maxY) maxY = b.max;
		}
	}
	if (minY > maxY || maxY - minY <= tol) {
		return [{ start: line.start, end: line.end, y: minY <= maxY ? (minY + maxY) / 2 : 0 }];
	}

	// Hard line soft-wraps: build per-visual-line runs and merge adjacent runs sharing the same visual row.
	const runs: VisualLine[] = [];
	let lastY = minY;
	for (let i = 0; i < line.items.length; i++) {
		const item = line.items[i]!;
		const b = bounds[i];
		if (item.kind === "token") {
			const y = b ? b.min : lastY;
			lastY = y;
			runs.push({ start: item.start, end: item.end, y });
		} else {
			if (item.start === item.end) continue;
			if (!b || b.max - b.min <= tol) {
				const y = b ? (b.min + b.max) / 2 : lastY;
				lastY = y;
				runs.push({ start: item.start, end: item.end, y });
			} else {
				const split = splitWrappedTextNode(doc, item.node, item.start, lastY, tol);
				for (const r of split) {
					lastY = r.y;
					runs.push(r);
				}
			}
		}
	}
	if (runs.length === 0) return [{ start: line.start, end: line.end, y: minY }];

	const merged: VisualLine[] = [runs[0]!];
	for (let i = 1; i < runs.length; i++) {
		const cur = runs[i]!;
		const prev = merged[merged.length - 1]!;
		if (Math.abs(cur.y - prev.y) <= tol) {
			prev.end = cur.end;
		} else {
			merged.push({ ...cur });
		}
	}
	return merged;
}

function pickVisualLineIndex(
	root: HTMLElement,
	sel: Selection,
	visualLines: readonly VisualLine[],
	focusPos: number,
	wrapHint: WrapAffinity | null,
): number {
	const last = visualLines.length - 1;
	if (last <= 0) return 0;
	if (focusPos <= visualLines[0]!.start) return 0;
	if (focusPos >= visualLines[last]!.end) return last;

	for (let i = 0; i <= last; i++) {
		const v = visualLines[i]!;
		if (focusPos > v.start && focusPos < v.end) return i;
		if (focusPos === v.end && i < last && focusPos === visualLines[i + 1]!.start) {
			if (wrapHint && wrapHint.pos === focusPos) {
				return wrapHint.side === "start" ? i + 1 : i;
			}
			if (sel.focusNode && root.contains(sel.focusNode)) {
				const r = root.ownerDocument.createRange();
				r.setStart(sel.focusNode, sel.focusOffset);
				r.collapse(true);
				const cr = r.getClientRects()[0] ?? r.getBoundingClientRect();
				if (cr && cr.height > 0) {
					const cy = (cr.top + cr.bottom) / 2;
					return Math.abs(cy - visualLines[i + 1]!.y) < Math.abs(cy - v.y) ? i + 1 : i;
				}
				if (sel.focusNode === root) {
					const nextChild = root.childNodes[sel.focusOffset];
					if (nextChild && isTokenEl(nextChild)) {
						const chipRect = nextChild.getBoundingClientRect();
						if (chipRect.height > 0) {
							const cy = (chipRect.top + chipRect.bottom) / 2;
							return Math.abs(cy - visualLines[i + 1]!.y) < Math.abs(cy - v.y) ? i + 1 : i;
						}
					}
				}
			}
			return i;
		}
	}
	return last;
}

function scrollCaretIntoView(root: HTMLElement, focusPos: number): void {
	if (root.scrollHeight <= root.clientHeight) return;
	const rootRect = root.getBoundingClientRect();
	if (rootRect.height <= 0) return;
	const pt = offsetToPoint(root, Math.max(0, focusPos));
	let caretRect: DOMRect | null = null;
	if (pt.node === root) {
		const adj = root.childNodes[pt.offset] ?? root.childNodes[pt.offset - 1];
		if (adj && adj.nodeType === 1) {
			const r = (adj as HTMLElement).getBoundingClientRect();
			if (r.height > 0) caretRect = r;
		}
	}
	if (!caretRect) {
		const r = root.ownerDocument.createRange();
		r.setStart(pt.node, pt.offset);
		r.collapse(true);
		const cr = r.getClientRects()[0] ?? r.getBoundingClientRect();
		if (cr && cr.height > 0) caretRect = cr;
	}
	if (!caretRect) return;
	if (caretRect.top < rootRect.top) {
		root.scrollTop -= rootRect.top - caretRect.top;
	} else if (caretRect.bottom > rootRect.bottom) {
		root.scrollTop += caretRect.bottom - rootRect.bottom;
	}
}

/**
 * Move (or Shift-extend) the selection to a visual line or document edge inside `root`.
 * Runs only when `root` has a flat normalised child list containing at least one `[data-token]` chip; returns
 * `{ handled: false, affinity: null }` otherwise so plain-text editors keep native browser behaviour.
 */
export function moveEditorEdge(
	root: HTMLElement,
	target: EdgeNavTarget,
	extend: boolean,
	wrapHint: WrapAffinity | null = null,
): { handled: boolean; affinity: WrapAffinity | null } {
	if (!root.querySelector("[data-token]")) return { handled: false, affinity: null };
	const sel = root.ownerDocument.getSelection();
	if (!sel || sel.rangeCount === 0 || !sel.focusNode || !sel.anchorNode) return { handled: false, affinity: null };
	if (!root.contains(sel.focusNode) || !root.contains(sel.anchorNode)) return { handled: false, affinity: null };
	for (let i = 0; i < root.childNodes.length; i++) {
		const child = root.childNodes[i]!;
		if (child.nodeType !== 3 && !isTokenEl(child) && !isBr(child)) return { handled: false, affinity: null };
	}

	const anchorPos = pointToOffset(root, sel.anchorNode, sel.anchorOffset);
	const focusPos = sel.isCollapsed ? anchorPos : pointToOffset(root, sel.focusNode, sel.focusOffset);

	if (target === "doc-start" || target === "doc-end") {
		const nextPos = target === "doc-start" ? 0 : readEditorText(root).length;
		setDirectionalSelection(root, extend ? anchorPos : nextPos, nextPos);
		root.scrollTop = target === "doc-start" ? 0 : root.scrollHeight;
		return { handled: true, affinity: null };
	}

	const hardLine = findHardLine(root, focusPos);
	const visualLines = measureVisualLines(root, hardLine);
	const idx = pickVisualLineIndex(root, sel, visualLines, focusPos, wrapHint);
	const cur = visualLines[idx]!;
	const nextPos = target === "line-start" ? cur.start : cur.end;
	setDirectionalSelection(root, extend ? anchorPos : nextPos, nextPos);
	scrollCaretIntoView(root, nextPos);

	const affinity: WrapAffinity | null =
		target === "line-start" && idx > 0
			? { pos: nextPos, side: "start" }
			: target === "line-end" && idx < visualLines.length - 1
				? { pos: nextPos, side: "end" }
				: null;
	return { handled: true, affinity };
}

type ExpectedNode =
	| { type: "text"; value: string }
	| { type: "br"; sentinel: boolean }
	| { type: "token"; kind: Exclude<ComposerPart["kind"], "text">; token: string };

function expectedNodes(parts: readonly ComposerPart[]): ExpectedNode[] {
	const out: ExpectedNode[] = [];
	for (const p of parts) {
		if (p.kind === "text") {
			const lines = p.text.split("\n");
			for (let i = 0; i < lines.length; i++) {
				if (i > 0) out.push({ type: "br", sentinel: false });
				if (lines[i]!) out.push({ type: "text", value: lines[i]! });
			}
		} else {
			out.push({ type: "token", kind: p.kind, token: p.text });
		}
	}
	// A trailing newline needs a sentinel <br> so the browser renders the empty last line and lets the caret sit there.
	if (out.length > 0 && out[out.length - 1]!.type === "br") {
		out.push({ type: "br", sentinel: true });
	}
	return out;
}

/** True when `root`'s current children already match the flat node sequence for `parts` (no DOM write needed). */
export function domMatchesParts(root: HTMLElement, parts: readonly ComposerPart[]): boolean {
	const expected = expectedNodes(parts);
	const kids = root.childNodes;
	if (kids.length !== expected.length) return false;
	for (let i = 0; i < expected.length; i++) {
		const exp = expected[i]!;
		const node = kids[i]!;
		if (exp.type === "text") {
			if (node.nodeType !== 3 || node.nodeValue !== exp.value) return false;
		} else if (exp.type === "br") {
			if (!isBr(node) || isSentinelBr(node) !== exp.sentinel) return false;
		} else {
			if (!isTokenEl(node) || node.dataset.token !== exp.token || node.dataset.kind !== exp.kind) return false;
		}
	}
	return true;
}

function makeIconSvg(doc: Document, name: IconName): SVGSVGElement {
	const svg = doc.createElementNS(SVG_NS, "svg");
	svg.setAttribute("class", "ic");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("aria-hidden", "true");
	const path = doc.createElementNS(SVG_NS, "path");
	path.setAttribute("d", ICON_PATHS[name]);
	svg.appendChild(path);
	return svg;
}

function makeChip(doc: Document, kind: Exclude<ComposerPart["kind"], "text">, token: string): HTMLSpanElement {
	const chip = doc.createElement("span");
	const variant = kind === "prompt" ? "skill" : kind;
	chip.className = `tok ${variant}`;
	chip.contentEditable = "false";
	chip.dataset.token = token;
	chip.dataset.kind = kind;

	if (kind === "image") {
		chip.appendChild(makeIconSvg(doc, "image"));
		const label = doc.createElement("span");
		label.className = "tlabel";
		label.textContent = token.slice(1);
		chip.appendChild(label);
	} else if (kind === "file") {
		chip.appendChild(makeIconSvg(doc, "file"));
		const raw = token.slice(1);
		const ref = splitFileRef(raw);
		const suffix = formatFileLine(ref.line, ref.endLine);
		const fp = splitFilePath(ref.path);
		if (fp) {
			const wrap = doc.createElement("span");
			wrap.className = "path";
			const dir = doc.createElement("span");
			dir.className = "dir";
			dir.textContent = fp.dir;
			const base = doc.createElement("span");
			base.className = "base";
			base.textContent = `${fp.base}${suffix}`;
			wrap.appendChild(dir);
			wrap.appendChild(base);
			chip.appendChild(wrap);
		} else {
			const label = doc.createElement("span");
			label.className = "tlabel";
			label.textContent = raw;
			chip.appendChild(label);
		}
	} else if (kind === "skill" || kind === "prompt") {
		chip.appendChild(makeIconSvg(doc, kind === "prompt" ? "prompt" : "skill"));
		const label = doc.createElement("span");
		label.className = "tlabel";
		label.textContent = token;
		chip.appendChild(label);
	} else {
		const label = doc.createElement("span");
		label.className = "tlabel";
		label.textContent = token;
		chip.appendChild(label);
	}
	return chip;
}

/** Reconcile `root`'s child nodes to match `parts` as a flat list of Text, `<br>`, and atomic `.tok` chips. */
export function renderEditorDom(root: HTMLElement, parts: readonly ComposerPart[]): void {
	if (domMatchesParts(root, parts)) return;
	const doc = root.ownerDocument;
	const expected = expectedNodes(parts);
	const frag = doc.createDocumentFragment();
	for (const exp of expected) {
		if (exp.type === "text") {
			frag.appendChild(doc.createTextNode(exp.value));
		} else if (exp.type === "br") {
			const br = doc.createElement("br");
			if (exp.sentinel) br.dataset.sentinel = "";
			frag.appendChild(br);
		} else {
			frag.appendChild(makeChip(doc, exp.kind, exp.token));
		}
	}
	root.replaceChildren(frag);
}
