/**
 * The right sidebar's own state: whether it is open (remembered on this device) and how wide it is. It mirrors the left
 * sidebar's `SidebarState` for the two things it needs, so the two edges of the window behave the same way.
 */
import { clampTo } from "./number";
import { ms } from "./motion";
import { K, read, write } from "./persist";

export const RIGHT_W = { min: 260, max: 520, def: 320 };
/** How much of the closing motion passes before the header's open button takes over from the panel's own toggle. */
const CLOSING_SHARE = 0.55;
const clamp = (n: number) => clampTo(Number.isFinite(n) ? Math.round(n) : n, RIGHT_W.min, RIGHT_W.max, RIGHT_W.def);

export class RightSidebarState {
	/** Shown as a column beside the conversation on a wide screen, as a sheet on a narrow one. */
	open = $state(read<boolean>(K.rightSidebar, false));
	width = $state(clamp(read<number>(K.rightSidebarW, RIGHT_W.def)));
	/**
	 * Closed and finished closing. The header's "open" button shows on this, not on `open`: while the panel slides shut its own
	 * toggle is still on screen, and a second button appearing beside it at once is the flicker. Opening clears it at once
	 * (the header button goes the moment the panel starts to open); closing sets it once the panel is most of the way shut
	 * (`CLOSING_SHARE` of the motion token, so the panel's own toggle, clipped by the narrowing column, and the header's
	 * button swap with no long gap in between; 0 for reduced motion). A quick second click cancels the pending timer.
	 */
	shut = $state(!read<boolean>(K.rightSidebar, false));
	#timer: ReturnType<typeof setTimeout> | undefined;

	/** Every change of `open` goes through here (the toggle, the sheet's scrim and swipe, the back button). */
	set(open: boolean) {
		if (open === this.open) return;
		this.open = open;
		clearTimeout(this.#timer);
		if (open) this.shut = false;
		else {
			const wait = Math.round(ms("normal") * CLOSING_SHARE);
			if (wait <= 0) this.shut = true;
			else this.#timer = setTimeout(() => (this.shut = true), wait);
		}
	}

	/** Open or shut it and remember the choice on this device. */
	setOpen(open: boolean) {
		this.set(open);
		write(K.rightSidebar, this.open);
	}

	toggle() {
		this.setOpen(!this.open);
	}

	/** `save` false while dragging the edge: persist once, at the end. */
	setWidth(px: number, save = true) {
		this.width = clamp(px);
		if (save) write(K.rightSidebarW, this.width);
	}
}
