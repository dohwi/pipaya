/** Same breakpoint as the stylesheet: below it the sidebar is a drawer and a group shows one session at a time. */
const QUERY = "(max-width: 860px)";

class Viewport {
	narrow = $state(typeof matchMedia === "function" && matchMedia(QUERY).matches);
	constructor() {
		if (typeof matchMedia === "function") matchMedia(QUERY).addEventListener("change", (e) => (this.narrow = e.matches));
	}
}

export const viewport = new Viewport();
