import { schedule, unschedule } from "./frame";
import { fontSpecOf, measureTextWidth } from "./text-measure";

/** Shared ResizeObserver so mounting many cards does not create hundreds of observer instances. */
const roCallbacks = new WeakMap<Element, Set<() => void>>();
let sharedRo: ResizeObserver | null = null;
function observeResize(el: Element, cb: () => void): () => void {
	if (typeof ResizeObserver !== "function") return () => {};
	if (!sharedRo) {
		sharedRo = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const set = roCallbacks.get(entry.target);
				if (set) for (const fn of set) fn();
			}
		});
	}
	let set = roCallbacks.get(el);
	if (!set) {
		set = new Set();
		roCallbacks.set(el, set);
		sharedRo.observe(el);
	}
	set.add(cb);
	return () => {
		const cur = roCallbacks.get(el);
		if (!cur) return;
		cur.delete(cb);
		if (!cur.size) {
			roCallbacks.delete(el);
			sharedRo?.unobserve(el);
		}
	};
}

/**
 * Svelte actions that fit a line of text into its row: `tail` elides the start of a path, `marquee` lets an overlong
 * title scroll past on hover. Both re-measure when the row is resized.
 */

/** The forms of a path `tail` tries, longest first: the whole path, then `…` plus ever fewer whole folders. Never a piece of a folder name. */
export function tailCandidates(full: string): string[] {
	const out = [full];
	for (const m of full.matchAll(/[\\/]/g)) if (m.index! > 0) out.push(`…${full.slice(m.index!)}`);
	return out;
}

function splitPathSegs(p: string): string[] {
	if (!p) return [];
	if (p === "/") return ["/"];
	return p.split(/[\\/]/).filter(Boolean);
}

function endsWithSegs(segs: readonly string[], suffix: readonly string[]): boolean {
	if (segs.length < suffix.length) return false;
	const off = segs.length - suffix.length;
	for (let i = 0; i < suffix.length; i++) if (segs[off + i] !== suffix[i]) return false;
	return true;
}

/**
 * Candidate display strings for a path that has twin peers, ordered longest-first, excluding any shortened suffix that
 * would collide with a peer. With `compact` (default true, for dim parent paths beside a folder name), shared trailing
 * folders after the distinguishing segment (`~/a/sub` vs `~/b/sub`) can collapse to `a/…` vs `b/…`; with `compact: false`
 * (for primary names like a worktree subpath), it stops at the shortest unique slice (`a/sub`) so CSS ellipsis keeps both ends clear.
 */
export function twinParentCandidates(full: string, peers: readonly string[], options?: { compact?: boolean }): string[] {
	if (!full) return [""];
	const other = peers.filter(Boolean);
	if (!other.length) return tailCandidates(full);
	const compactMode = options?.compact ?? true;
	const sep = full.includes("\\") ? "\\" : "/";
	const segs = splitPathSegs(full);
	const peerSegs = other.map(splitPathSegs);
	const peerTails = new Set<string>();
	for (const p of other) for (const c of tailCandidates(p)) peerTails.add(c);
	const unique = tailCandidates(full).filter((c) => {
		if (peerTails.has(c)) return false;
		if (c.startsWith("…/") || c.startsWith("…\\")) {
			const tailSegs = splitPathSegs(c.slice(2));
			if (tailSegs.length && peerSegs.some((ps) => endsWithSegs(ps, tailSegs))) return false;
		}
		return true;
	});
	if (!unique.length) return [full];
	const out = [...unique];
	const push = (s: string) => {
		if (s && !out.includes(s)) out.push(s);
	};
	// Find the shortest trailing segment slice unique among peers.
	let start = -1;
	for (let i = segs.length - 1; i >= 0; i--) {
		const slice = segs.slice(i);
		if (!peerSegs.some((ps) => endsWithSegs(ps, slice))) {
			start = i;
			break;
		}
	}
	if (start >= 0) {
		// When the distinguishing segment is the very first segment, `full` is already in `out` (with its leading `/` or `\\`).
		if (start > 0) {
			const bare = segs.slice(start).join(sep);
			if (!other.includes(bare)) push(bare);
		}
		// If peers share trailing folders after the distinguishing segment (`~/a/sub` vs `~/b/sub`), elide that shared tail.
		// Never emit `seg/…` if any peer also contains `seg` before its last segment (e.g. `~/a/y/x` vs `~/a/x`, or `~/a/b` vs `~/b`).
		if (compactMode && start < segs.length - 1) {
			const seg = segs[start]!;
			const compact = `${seg}${sep}…`;
			const collides = peerSegs.some((ps) => ps.slice(0, -1).includes(seg)) || other.includes(compact);
			if (!collides) push(compact);
		}
	}
	return out;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/**
 * A path too long for its row keeps its end and drops whole folders from the start: `…/pipaya`. When not even the last folder
 * fits, the row shows nothing: half a folder name (`…rkspace`) says less than no name (the full path stays in the tooltip).
 */
export function tail(node: HTMLElement, text: string) {
	return fitTail(node, text, false);
}

/** Like `tail`, but the last folder always shows: when even it is too wide the row ends it with the CSS ellipsis instead of going blank. */
export function tailKeepLast(node: HTMLElement, text: string | readonly string[]) {
	return fitTail(node, text, true);
}

function fitTail(node: HTMLElement, input: string | readonly string[], keepLast: boolean) {
	const toList = (v: string | readonly string[]) => (typeof v === "string" ? tailCandidates(v) : v.length ? [...v] : [""]);
	let candidates = toList(input);
	const fit = () => {
		for (const c of candidates) {
			node.textContent = c;
			if (node.scrollWidth <= node.clientWidth) return;
		}
		node.textContent = keepLast ? candidates[candidates.length - 1]! : "";
	};
	const unobserve = observeResize(node, () => schedule(node, fit));
	fit();
	return {
		update(next: string | readonly string[]) {
			const list = toList(next);
			if (sameList(candidates, list)) return;
			candidates = list;
			schedule(node, fit);
		},
		destroy: () => (unobserve(), unschedule(node)),
	};
}

/**
 * A title too long for its row flows past (hover/focus), looping back to its start, so the whole name can be read.
 * Idle rows keep the plain ellipsis. Only measures; the animation itself is CSS (see `.title:global([data-over])`).
 */
export function marquee(node: HTMLElement, _text: string) {
	/** Reads in the frame's read phase, writes in its write phase (lib/frame.ts), so a row that mounts or changes does not force a layout of its own. */
	const measure = (): (() => void) | void => {
		const mq = node.querySelector<HTMLElement>(".mq");
		if (!mq) return;
		// measured idle (inline, clipped): the text overflows its box only when it really does not fit
		// (or the whole text waits unseen beside a shortened one: the graph's ids, `.cut` + an absolute `.track`)
		const over = node.scrollWidth > node.clientWidth + 1 || mq.offsetWidth > node.clientWidth + 1;
		const duration = over ? `${Math.max(6, (mq.offsetWidth + 32) / 40)}s` : "";
		return () => {
			if (over) {
				node.dataset.over = "";
				// ~40px per second, never frantic for a title that only just overflows
				node.style.setProperty("--mq-d", duration);
			} else delete node.dataset.over;
		};
	};
	const later = () => schedule(node, measure);
	// Rows mount in bulk when a conversation appears (a send, a list reload): each measured at once, every one of them forced
	// a layout of the page. The first fit lands in the next frame instead, together with the other rows'.
	const stop = observeResize(node, later);
	later();
	return { update: later, destroy: () => (stop(), unschedule(node)) };
}

/** `text` cut to `keep` characters with "…" in the middle: the start (a family, a host) and the end (a size, a port) stay. */
export function middleCut(text: string, keep: number): string {
	const chars = [...text];
	if (keep >= chars.length) return text;
	if (keep <= 1) return "…";
	const head = Math.ceil((keep - 1) / 2);
	const tail = keep - 1 - head;
	return `${chars.slice(0, head).join("")}…${tail ? chars.slice(-tail).join("") : ""}`;
}

/**
 * An id too long for its row (a model id, a host, a role name) loses its middle, not its end: `qwen3-coder…fp8-instruct`
 * still tells two variants apart where `qwen3-coder-480b-a…` does not. The whole id belongs in the row's tooltip.
 */
export function middle(node: HTMLElement, text: string) {
	let full = text;
	const fitRead = (): (() => void) | void => {
		// Restore full text before reading `clientWidth` when previously truncated, so a shrink-to-fit box
		// (like a host in `.meta > .give`) expands again when its parent widens. On mount it is already `full`.
		if (node.textContent !== full) node.textContent = full;
		const maxW = node.clientWidth;
		if (maxW <= 0) return;
		const spec = fontSpecOf(node);
		const fullW = measureTextWidth(full, spec);
		if (fullW !== null) {
			if (fullW <= maxW + 0.5) return () => { if (node.textContent !== full) node.textContent = full; };
			let lo = 1, hi = [...full].length - 1;
			while (lo < hi) {
				const mid = Math.ceil((lo + hi) / 2);
				const mw = measureTextWidth(middleCut(full, mid), spec)!;
				if (mw <= maxW) lo = mid;
				else hi = mid - 1;
			}
			const out = middleCut(full, lo);
			return () => { if (node.textContent !== out) node.textContent = out; };
		}
		// Fallback when Canvas 2D is unavailable (e.g. happy-dom tests).
		node.textContent = full;
		if (node.scrollWidth <= node.clientWidth) return;
		let lo = 1, hi = [...full].length - 1;
		while (lo < hi) {
			const mid = Math.ceil((lo + hi) / 2);
			node.textContent = middleCut(full, mid);
			if (node.scrollWidth <= node.clientWidth) lo = mid;
			else hi = mid - 1;
		}
		node.textContent = middleCut(full, lo);
	};
	const later = () => schedule(node, fitRead);
	const stopSelf = observeResize(node, later);
	// a box sized by its own text (a host in a facts line) does not grow back by itself: watch the line it sits in too
	const stopParent = node.parentElement ? observeResize(node.parentElement, later) : () => {};
	node.textContent = full;
	later();
	return {
		update(next: string) {
			if (next === full) return;
			full = next;
			node.textContent = full;
			later();
		},
		destroy: () => (stopSelf(), stopParent(), unschedule(node)),
	};
}
