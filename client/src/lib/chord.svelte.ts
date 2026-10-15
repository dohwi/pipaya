import type { Recording } from "./keys";

/** A shortcut that has been started but not finished (Ctrl+B pressed, waiting for the next key). null = nothing pending. */
class Chord {
	prefix = $state<Recording | null>(null);
}
export const chord = new Chord();
