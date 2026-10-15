/**
 * A single selection marker that slides to the active item (Tabs, `useSlidingIndicator`).
 *
 *   <nav use:slidingIndicator={{ selector: ".item.active" }}>
 *
 * The action prepends one absolutely positioned `.slide-ind` to the container and keeps it on top of the
 * element matching `selector`. Only a change of target slides it; the same target moving (a group opens
 * above it, the sidebar resizes, fonts load) is placed immediately, exactly like that. While a target
 * exists the container carries `data-indicator-ready`, so the active item can drop its own background.
 * Easing and duration are CSS (`.slide-ind` in app.css), which also covers reduced motion and theme flips.
 */

export type Box = { x: number; y: number; width: number; height: number };
type Rect = { left: number; top: number; width: number; height: number };
type ContainerRect = Rect & {
	scrollLeft: number;
	scrollTop: number;
	clientLeft: number;
	clientTop: number;
	/** Ancestor transforms (a dialog scaling in): screen px per layout px. */
	scaleX?: number;
	scaleY?: number;
};

/**
 * Position of `selected` inside the container's scrollable content box, or null when it cannot be measured.
 * Screen rects are divided by the ancestor scale so the result is in layout pixels, which is what the marker
 * (a child of the same transformed tree) is positioned in. Without this a marker mounted while its dialog is
 * still scaling in would be placed at .94 of the right spot and stay there.
 */
export function indicatorBox(container: ContainerRect, selected: Rect | undefined): Box | null {
	if (!selected || !container.width || !container.height || !selected.width || !selected.height) return null;
	const sx = container.scaleX || 1, sy = container.scaleY || 1;
	return {
		x: (selected.left - container.left) / sx + container.scrollLeft - container.clientLeft,
		y: (selected.top - container.top) / sy + container.scrollTop - container.clientTop,
		width: selected.width / sx,
		height: selected.height / sy,
	};
}

/** A bar along the bottom edge of `box` (underline tabs). */
export const edgeBox = (box: Box, thickness: number): Box => ({ x: box.x, y: box.y + box.height - thickness, width: box.width, height: thickness });

/** Slide only when the selection moved to a different element; everything else snaps. */
export const shouldSlide = (previous: unknown, next: unknown) => previous != null && previous !== next;

/**
 * fill: sits under the item (sidebar rows, segmented controls) · ring: fill + hairline (rail)
 * outline / accent: transparent ring drawn over the item (cards, chips) · level: reasoning colour
 * underline: bottom bar for tabs, tinted by --ind-color.
 */
export type Variant = "fill" | "ring" | "outline" | "accent" | "level" | "underline";
export type SlidingOptions = {
	selector: string;
	variant?: Variant;
	radius?: string;
	/** `bottom`: collapse the marker to a bar of `thickness` px on the item's bottom edge. */
	edge?: "bottom";
	thickness?: number;
	/** Attributes copied from the selected item to the marker, so it can pick up e.g. data-level colours. */
	mirror?: string[];
};

export function slidingIndicator(container: HTMLElement, options: SlidingOptions) {
	const view = container.ownerDocument.defaultView;
	if (!view) return {};
	let { selector } = options;
	const { mirror = [], edge, thickness = 2 } = options;

	const el = container.ownerDocument.createElement("span");
	el.className = "slide-ind";
	el.setAttribute("aria-hidden", "true");
	el.style.display = "none";
	if (options.radius) el.style.borderRadius = options.radius;
	if (options.variant) el.dataset.variant = options.variant;
	container.prepend(el);

	let last: HTMLElement | null = null;
	let lastBox: Box | null = null;
	/** A slide is in flight: re-measuring the same target must retarget it, not cut it short. */
	let sliding = false;
	let slideTimer: ReturnType<typeof setTimeout> | undefined;
	let frame = 0;
	let disposed = false;
	const observed = new Set<Element>();

	const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => schedule());

	function observeChildren(selected: HTMLElement | null) {
		const next = new Set<Element>([container, ...Array.from(container.children).filter((c) => c !== el)]);
		if (selected) next.add(selected);
		for (const old of observed)
			if (!next.has(old)) {
				resize?.unobserve(old);
				observed.delete(old);
			}
		for (const add of next)
			if (!observed.has(add)) {
				resize?.observe(add);
				observed.add(add);
			}
	}

	const endSlide = () => {
		sliding = false;
		clearTimeout(slideTimer);
	};
	el.addEventListener("transitionend", (e) => {
		if (e.target === el && e.propertyName === "transform") endSlide();
	});

	function hide() {
		endSlide();
		last = null;
		lastBox = null;
		el.style.display = "none";
		container.removeAttribute("data-indicator-ready");
	}

	function measure() {
		if (disposed) return;
		const selected = container.querySelector<HTMLElement>(selector);
		observeChildren(selected);
		const cr = container.getBoundingClientRect();
		const full = selected && container.isConnected ? indicatorBox(
			{
				left: cr.left,
				top: cr.top,
				width: cr.width,
				height: cr.height,
				scrollLeft: container.scrollLeft,
				scrollTop: container.scrollTop,
				clientLeft: container.clientLeft,
				clientTop: container.clientTop,
				scaleX: container.offsetWidth ? cr.width / container.offsetWidth : 1,
				scaleY: container.offsetHeight ? cr.height / container.offsetHeight : 1,
			},
			selected.getBoundingClientRect(),
		) : null;
		if (!selected || !full) return hide();
		const box = edge === "bottom" ? edgeBox(full, thickness) : full;
		for (const name of mirror) {
			const v = selected.getAttribute(name);
			if (v == null) el.removeAttribute(name);
			else if (el.getAttribute(name) !== v) el.setAttribute(name, v);
		}

		// Same target, same place: nothing to do. (Badge animations and observers re-measure constantly.)
		const unchanged = last === selected && lastBox && lastBox.x === box.x && lastBox.y === box.y && lastBox.width === box.width && lastBox.height === box.height;
		if (unchanged && el.style.display !== "none") return;

		const newTarget = shouldSlide(last, selected) && el.style.display !== "none";
		// A moved-but-same target snaps (reflow), unless it is mid-slide, where it just keeps gliding.
		const slide = newTarget || (sliding && last === selected);
		if (newTarget) {
			sliding = true;
			clearTimeout(slideTimer);
			slideTimer = setTimeout(endSlide, 1000); // transitionend does not fire when motion is reduced
		}
		if (!slide) el.style.transition = "none";
		el.style.display = "";
		el.style.width = `${box.width}px`;
		el.style.height = `${box.height}px`;
		el.style.transform = `translate(${box.x}px, ${box.y}px)`;
		container.setAttribute("data-indicator-ready", "");
		if (!slide) {
			void el.offsetWidth; // commit the snapped position before transitions come back
			el.style.transition = "";
		}
		last = selected;
		lastBox = box;
	}

	function schedule() {
		if (disposed || frame) return;
		frame = view!.requestAnimationFrame(() => {
			frame = 0;
			measure();
		});
	}

	const mutations = new MutationObserver((records) => {
		// our own style writes are not interesting; everything else may move the target
		if (records.every((r) => r.target === el || (r.type === "childList" && [...r.addedNodes, ...r.removedNodes].every((n) => n === el)))) return;
		schedule();
	});
	mutations.observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "aria-current", "aria-selected", "aria-checked", "aria-pressed", "data-state", "hidden"] });
	view.addEventListener("resize", schedule);
	void container.ownerDocument.fonts?.ready.then(schedule);

	measure(); // first placement before paint
	schedule(); // and once more after children/styles have settled

	return {
		update(next: SlidingOptions) {
			if (next.selector !== selector) {
				selector = next.selector;
				last = null;
				lastBox = null;
				schedule();
			}
		},
		destroy() {
			disposed = true;
			clearTimeout(slideTimer);
			view.cancelAnimationFrame(frame);
			resize?.disconnect();
			mutations.disconnect();
			view.removeEventListener("resize", schedule);
			el.remove();
			container.removeAttribute("data-indicator-ready");
		},
	};
}
