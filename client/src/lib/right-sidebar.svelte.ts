/**
 * The right sidebar's own state: whether it is open (remembered on this device) and how wide it is. It mirrors the left
 * sidebar's `SidebarState` for the two things it needs, so the two edges of the window behave the same way.
 */
import { clampTo } from "./number";
import { K, read, write } from "./persist";

export const RIGHT_W = { min: 260, max: 520, def: 320 };
const clamp = (n: number) => clampTo(Number.isFinite(n) ? Math.round(n) : n, RIGHT_W.min, RIGHT_W.max, RIGHT_W.def);

export class RightSidebarState {
	/** Shown as a column beside the conversation on a wide screen, as a sheet on a narrow one. */
	open = $state(read<boolean>(K.rightSidebar, false));
	width = $state(clamp(read<number>(K.rightSidebarW, RIGHT_W.def)));

	toggle() {
		this.open = !this.open;
		write(K.rightSidebar, this.open);
	}

	/** `save` false while dragging the edge: persist once, at the end. */
	setWidth(px: number, save = true) {
		this.width = clamp(px);
		if (save) write(K.rightSidebarW, this.width);
	}
}
