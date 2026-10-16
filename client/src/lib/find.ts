/** In-conversation search: locate every case-insensitive occurrence of a query in the text of a DOM subtree. */

/** Text of these elements is never shown (or is not part of the conversation), so it cannot match. */
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

/** Match limit: a one-letter query in a long session would otherwise create tens of thousands of ranges. */
export const MAX_MATCHES = 2000;

/** Ranges of the matches inside one text node. Matching is per node, so a hit never spans an element boundary. */
export function matchesIn(text: string, query: string): [number, number][] {
	const out: [number, number][] = [];
	if (!query) return out;
	const hay = text.toLocaleLowerCase();
	const needle = query.toLocaleLowerCase();
	// Lower-casing can change the length (e.g. "İ"); positions would drift, so fall back to the raw text then.
	const h = hay.length === text.length ? hay : text;
	const n = hay.length === text.length ? needle : query;
	for (let i = h.indexOf(n); i !== -1; i = h.indexOf(n, i + n.length)) out.push([i, i + n.length]);
	return out;
}

export function findRanges(root: Node, query: string, limit = MAX_MATCHES): Range[] {
	const out: Range[] = [];
	if (!query.trim()) return out;
	const doc = root.ownerDocument ?? document;
	const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			const el = node.parentElement;
			if (!el || SKIP.has(el.tagName) || el.closest("[data-find-skip]")) return NodeFilter.FILTER_REJECT;
			return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
		},
	});
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		for (const [from, to] of matchesIn(node.nodeValue!, query)) {
			const r = doc.createRange();
			r.setStart(node, from);
			r.setEnd(node, to);
			out.push(r);
			if (out.length >= limit) return out;
		}
	}
	return out;
}
