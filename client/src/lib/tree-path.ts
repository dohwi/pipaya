/**
 * The darker path of a tree line (sidebar split tabs, settings extensions): one element that runs from the top of the
 * tree down to the open row's branch. Its height is the only thing that moves, with the same time and curve as the
 * sliding selection (`.slide-ind`), so the two travel together.
 *
 *   <div class="members" use:treePath={{ row: ".item.active", trunk: 0 }}>
 *
 * The action prepends one absolutely positioned `.tree-path` and keeps `--path-h` (px from the path's top to the open
 * row's branch). No open row: the path collapses to nothing. A first placement or a reflow snaps (no transition),
 * exactly like the marker; only a change of the open row glides. The look (rule, elbow) is `.tree-path` in app.css.
 */

export type PathOptions = {
	/** Selector of the open row inside the container. */
	row: string;
	/** Where in the open row its branch meets the trunk, as a fraction of the row's height (0.5 = the row's middle). */
	at?: number;
	/** The path starts this many px above the container (the gap under the header row it hangs from). */
	lead?: number;
};

/** Length of the path in layout px: from the container's top to `at` of the row's height; 0 when there is no row. */
export function pathLength(container: { top: number; scaleY?: number }, row: { top: number; height: number } | undefined, at = 0.5, lead = 0): number {
	if (!row || !row.height) return 0;
	const sy = container.scaleY || 1;
	return Math.max(0, (row.top - container.top + row.height * at) / sy + lead);
}

export function treePath(container: HTMLElement, options: PathOptions) {
	const view = container.ownerDocument.defaultView;
	if (!view) return {};
	let { row } = options;
	const at = options.at ?? 0.5;
	const lead = options.lead ?? 0;
	const el = container.ownerDocument.createElement("span");
	el.className = "tree-path";
	el.setAttribute("aria-hidden", "true");
	container.prepend(el);

	let last: HTMLElement | null = null;
	let lastLen = -1;
	let placed = false;
	let frame = 0;
	let disposed = false;

	function measure() {
		if (disposed) return;
		const selected = container.querySelector<HTMLElement>(row);
		const cr = container.getBoundingClientRect();
		const sr = selected?.getBoundingClientRect();
		const len = pathLength(
			{ top: cr.top, scaleY: container.offsetHeight ? cr.height / container.offsetHeight : 1 },
			sr && container.isConnected ? { top: sr.top, height: sr.height } : undefined,
			at,
			lead,
		);
		if (selected === last && len === lastLen && placed) return;
		// Glide only when the open row changed (to another row, or to none); the first placement and a reflow of the same row snap.
		const glide = placed && selected !== last;
		if (!glide) el.style.transition = "none";
		el.toggleAttribute("data-empty", len === 0);
		el.style.setProperty("--path-h", `${len}px`);
		if (!glide) {
			void el.offsetWidth;
			el.style.transition = "";
		}
		last = selected;
		lastLen = len;
		placed = true;
	}

	function schedule() {
		if (disposed || frame) return;
		frame = view!.requestAnimationFrame(() => {
			frame = 0;
			measure();
		});
	}

	const mutations = new MutationObserver((records) => {
		if (records.every((r) => r.target === el || (r.type === "childList" && [...r.addedNodes, ...r.removedNodes].every((n) => n === el)))) return;
		schedule();
	});
	mutations.observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "aria-selected", "hidden"] });
	const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
	resize?.observe(container);
	view.addEventListener("resize", schedule);

	measure();
	schedule();

	return {
		update(next: PathOptions) {
			if (next.row !== row) {
				row = next.row;
				last = null;
				lastLen = -1;
				placed = false;
				schedule();
			}
		},
		destroy() {
			disposed = true;
			view.cancelAnimationFrame(frame);
			mutations.disconnect();
			resize?.disconnect();
			view.removeEventListener("resize", schedule);
			el.remove();
		},
	};
}
