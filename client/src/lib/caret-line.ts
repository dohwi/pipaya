/**
 * Whether the caret sits on the first / last *visual* line of a composer input (soft-wrapped lines count).
 * Supports both a contenteditable element (measured directly from Range client rects) and a plain `<textarea>`.
 */
const COPY = [
	"boxSizing", "width", "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight",
	"textTransform", "textIndent", "whiteSpace", "wordBreak", "overflowWrap", "tabSize",
	"paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
	"borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
] as const;

function markerTops(ta: HTMLTextAreaElement, positions: number[]): number[] {
	const mirror = document.createElement("div");
	const cs = getComputedStyle(ta);
	for (const k of COPY) mirror.style[k] = cs[k];
	mirror.style.position = "absolute";
	mirror.style.visibility = "hidden";
	mirror.style.top = "0";
	mirror.style.left = "-9999px";
	mirror.style.height = "auto";
	mirror.style.overflow = "hidden";
	mirror.style.whiteSpace = "pre-wrap";
	mirror.style.overflowWrap = "break-word";
	document.body.appendChild(mirror);
	try {
		return positions.map((pos) => {
			mirror.textContent = ta.value.slice(0, pos);
			const mark = document.createElement("span");
			mark.textContent = "\u200b";
			mirror.appendChild(mark);
			// the rest of the text keeps the wrapping identical to the real textarea
			mirror.appendChild(document.createTextNode(ta.value.slice(pos)));
			return mark.offsetTop;
		});
	} finally {
		mirror.remove();
	}
}

function caretRectOf(el: HTMLElement): DOMRect | null {
	const sel = el.ownerDocument.getSelection();
	if (!sel || sel.rangeCount === 0) return null;
	const r = sel.getRangeAt(0);
	if (!el.contains(r.startContainer)) return null;
	const rects = r.getClientRects();
	for (let i = 0; i < rects.length; i++) {
		if (rects[i]!.height > 0) return rects[i]!;
	}
	const box = r.getBoundingClientRect();
	if (box.height > 0) return box;
	return null;
}

function contentBounds(el: HTMLElement): { top: number; bottom: number; lineHeight: number } {
	const cs = getComputedStyle(el);
	const lineHeight = parseFloat(cs.lineHeight) || 24;
	const padTop = parseFloat(cs.paddingTop) || 0;
	const padBottom = parseFloat(cs.paddingBottom) || 0;
	const elRect = el.getBoundingClientRect();
	const top = elRect.top + padTop - el.scrollTop;
	const bottom = elRect.top + el.scrollHeight - padBottom - el.scrollTop;
	return { top, bottom, lineHeight };
}

export function caretOnFirstVisualLine(el: HTMLElement): boolean {
	if (el instanceof HTMLTextAreaElement) {
		const [at, first] = markerTops(el, [el.selectionStart, 0]);
		return at === first;
	}
	if (!el.childNodes.length) return true;
	const rect = caretRectOf(el);
	const { top, lineHeight } = contentBounds(el);
	if (!rect) {
		const sel = el.ownerDocument.getSelection();
		if (!sel || sel.rangeCount === 0) return true;
		const r = sel.getRangeAt(0);
		return r.startContainer === el && r.startOffset === 0;
	}
	return rect.top < top + lineHeight * 0.6;
}

export function caretOnLastVisualLine(el: HTMLElement): boolean {
	if (el instanceof HTMLTextAreaElement) {
		const [at, last] = markerTops(el, [el.selectionStart, el.value.length]);
		return at === last;
	}
	if (!el.childNodes.length) return true;
	const rect = caretRectOf(el);
	const { bottom, lineHeight } = contentBounds(el);
	if (!rect) {
		const sel = el.ownerDocument.getSelection();
		if (!sel || sel.rangeCount === 0) return true;
		const r = sel.getRangeAt(0);
		const lastIdx = el.childNodes.length;
		const hasSentinel = lastIdx > 0 && (el.lastChild as HTMLElement)?.dataset?.sentinel !== undefined;
		return r.endContainer === el && r.endOffset >= lastIdx - (hasSentinel ? 1 : 0);
	}
	return rect.bottom > bottom - lineHeight * 0.6;
}
