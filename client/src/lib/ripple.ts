/**
 * Material ripple for every `.btn` / `.iconbtn`, attached once with event delegation so components do not
 * have to opt in. Pure decoration: skipped for disabled controls, non-primary buttons and reduced motion.
 */
import { reduced } from "./motion";

const TARGET = ".btn, .iconbtn";

/** Diameter that reaches the farthest corner from the press point. */
export function rippleSize(w: number, h: number, x: number, y: number): number {
	return 2 * Math.hypot(Math.max(x, w - x), Math.max(y, h - y));
}

export function installRipple(root: Document = document): () => void {
	const onDown = (e: PointerEvent) => {
		if (e.button !== 0 || reduced()) return;
		const el = (e.target as Element | null)?.closest<HTMLElement>(TARGET);
		if (!el || (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") return;
		const r = el.getBoundingClientRect();
		const x = e.clientX - r.left, y = e.clientY - r.top;
		const dot = document.createElement("span");
		dot.className = "ripple";
		dot.setAttribute("aria-hidden", "true");
		dot.style.setProperty("--d", `${rippleSize(r.width, r.height, x, y)}px`);
		dot.style.setProperty("--x", `${x}px`);
		dot.style.setProperty("--y", `${y}px`);
		el.appendChild(dot);
		const done = () => dot.remove();
		dot.addEventListener("animationend", done, { once: true });
		setTimeout(done, 1200);
	};
	root.addEventListener("pointerdown", onDown, { passive: true });
	return () => root.removeEventListener("pointerdown", onDown);
}
