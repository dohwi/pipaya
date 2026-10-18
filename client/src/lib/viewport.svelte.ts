/** Same breakpoint as the stylesheet: below it the sidebar is a drawer and a group shows one session at a time. */
const QUERY = "(max-width: 860px)";

class Viewport {
	narrow = $state(typeof matchMedia === "function" && matchMedia(QUERY).matches);
	/** Phones: the group the user stepped back out of (its tab is then shown in the tab bar instead of its sessions). */
	backedOut = $state<string | null>(null);
	/** Phones: the open group's sessions replace the tab bar, with a back button to return to it. */
	inGroup(groupId: string | undefined) {
		return this.narrow && !!groupId && this.backedOut !== groupId;
	}
	constructor() {
		if (typeof matchMedia === "function") matchMedia(QUERY).addEventListener("change", (e) => (this.narrow = e.matches));
	}
}

export const viewport = new Viewport();
