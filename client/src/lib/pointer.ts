/**
 * A mouse or pen move with no button held: the press it belongs to already ended, but its `pointerup` never came
 * (let go outside the window, over a native menu or dialog, or while the window lost focus). A drag still waiting
 * for that `pointerup` would otherwise follow the bare pointer, as if the click had turned into a drag.
 * Touch is left alone: a finger's moves always come with its contact.
 */
export const released = (e: Pick<PointerEvent, "pointerType" | "buttons">): boolean => e.pointerType !== "touch" && e.buttons === 0;
