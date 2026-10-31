/**
 * Whether the caret sits on the first / last *visual* line of a textarea (soft-wrapped lines count).
 * Measured with a hidden mirror element that copies the textarea's text metrics.
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

export function caretOnFirstVisualLine(ta: HTMLTextAreaElement): boolean {
	const [at, first] = markerTops(ta, [ta.selectionStart, 0]);
	return at === first;
}

export function caretOnLastVisualLine(ta: HTMLTextAreaElement): boolean {
	const [at, last] = markerTops(ta, [ta.selectionStart, ta.value.length]);
	return at === last;
}
