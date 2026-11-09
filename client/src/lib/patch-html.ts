/**
 * Put sanitized HTML into `node`, touching only the nodes that differ.
 *
 * `{@html}` throws away and rebuilds every child whenever the string changes. While an answer streams that happens
 * every frame, so finished paragraphs and code blocks were re-created (re-laid-out, re-painted, selection lost, the
 * caret animation restarted) although only the last block grows.
 *
 * Keeping the unchanged *top-level* children (the first version of this) still throws away the block being written:
 * a growing list or a long paragraph was destroyed and rebuilt every frame, and WebKit re-laid out and re-painted all
 * of it (measured on a 12k-character list answer: p99 22ms against 17ms, with visible stutter). So same-kind nodes are
 * merged in place all the way down: only the text node that grew, and the list item that appeared, are touched.
 */
export function patchHtml(node: HTMLElement, html: string) {
	apply(node, html);
	return {
		update(next: string) {
			apply(node, next);
		},
	};
}

function apply(node: HTMLElement, html: string) {
	const tpl = document.createElement("template");
	tpl.innerHTML = html;
	merge(node, Array.from(tpl.content.childNodes));
}

/** Element node type (kept numeric: the module is also loaded where the DOM globals are not). */
const ELEMENT = 1;

/** Match `next` against the children of `parent`: same-kind nodes are merged in place, the rest replaced, added or removed. */
function merge(parent: Node, next: readonly Node[]) {
	const cur = Array.from(parent.childNodes);
	const shared = Math.min(cur.length, next.length);
	for (let i = 0; i < shared; i++) {
		const old = cur[i]!;
		const nu = next[i]!;
		if (old.nodeType !== nu.nodeType || old.nodeName !== nu.nodeName) old.replaceWith(nu);
		else if (old.nodeType === ELEMENT) mergeElement(old as Element, nu as Element);
		else if (old.nodeValue !== nu.nodeValue) old.nodeValue = nu.nodeValue;
	}
	for (let i = shared; i < next.length; i++) parent.appendChild(next[i]!);
	for (let i = cur.length - 1; i >= shared; i--) cur[i]!.remove();
}

function mergeElement(old: Element, nu: Element) {
	for (const attr of Array.from(old.attributes)) if (!nu.hasAttribute(attr.name)) old.removeAttribute(attr.name);
	for (const attr of Array.from(nu.attributes)) if (old.getAttribute(attr.name) !== attr.value) old.setAttribute(attr.name, attr.value);
	merge(old, Array.from(nu.childNodes));
}
