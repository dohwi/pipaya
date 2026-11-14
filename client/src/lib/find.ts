/** In-conversation search: locate every case-insensitive occurrence of a query in the text of a DOM subtree. */

/** Text of these elements is never shown (or is not part of the conversation), so it cannot match. */
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

/** Match limit: a one-letter query in a long session would otherwise create tens of thousands of ranges. */
export const MAX_MATCHES = 2000;

/** Ranges of the matches inside one string (a text node, or the joined text of one code block: see findRanges). */
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

/** NodeFilter values, kept numeric: the module is also loaded where the DOM globals are not (tests). */
const SHOW_TEXT = 4;
const ACCEPT = 1;
const REJECT = 2;

export function findRanges(root: Node, query: string, limit = MAX_MATCHES): Range[] {
	const out: Range[] = [];
	if (!query.trim()) return out;
	const doc = root.ownerDocument ?? document;
	const walker = doc.createTreeWalker(root, SHOW_TEXT, {
		acceptNode(node) {
			const el = node.parentElement;
			if (!el || SKIP.has(el.tagName) || el.closest("[data-find-skip]")) return REJECT;
			return node.nodeValue ? ACCEPT : REJECT;
		},
	});
	// Text inside a code block is split into many nodes by its syntax colours (`hljs-*` spans): a search for `res.ok` must
	// still find it there, so the nodes of one <pre> are searched as one string and a match may span several of them.
	// Everywhere else matching stays per node.
	const runs: Text[][] = [];
	let runPre: Element | null = null;
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const pre = node.parentElement!.closest("pre");
		if (pre && pre === runPre) runs[runs.length - 1]!.push(node as Text);
		else runs.push([node as Text]);
		runPre = pre;
	}
	for (const run of runs) {
		const text = run.map((n) => n.nodeValue!).join("");
		const starts: number[] = [];
		let at = 0;
		for (const n of run) {
			starts.push(at);
			at += n.nodeValue!.length;
		}
		/** The node holding character `pos` of the joined text (an end position belongs to the node it closes). */
		const locate = (pos: number, end: boolean): [Text, number] => {
			let i = run.length - 1;
			while (i > 0 && (end ? starts[i]! >= pos : starts[i]! > pos)) i--;
			return [run[i]!, pos - starts[i]!];
		};
		for (const [from, to] of matchesIn(text, query)) {
			const r = doc.createRange();
			r.setStart(...locate(from, false));
			r.setEnd(...locate(to, true));
			out.push(r);
			if (out.length >= limit) return out;
		}
	}
	return out;
}
