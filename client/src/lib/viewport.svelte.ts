/** Same breakpoint as the stylesheet: below it the sidebar is a drawer and a group shows one session at a time. */
const QUERY = "(max-width: 860px)";
/** A phone: the settings window is a list, then one section (see settings-phone.ts). */
const PHONE = "(max-width: 600px)";

class Viewport {
	narrow = $state(typeof matchMedia === "function" && matchMedia(QUERY).matches);
	phone = $state(typeof matchMedia === "function" && matchMedia(PHONE).matches);
	constructor() {
		if (typeof matchMedia === "function") {
			matchMedia(QUERY).addEventListener("change", (e) => (this.narrow = e.matches));
			matchMedia(PHONE).addEventListener("change", (e) => (this.phone = e.matches));
		}
	}
}

export const viewport = new Viewport();
