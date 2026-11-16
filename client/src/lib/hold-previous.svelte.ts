import { HOLD_PREVIOUS_MS, shownChat, type Shown } from "./hold-previous";

/**
 * A pane's transcript with the previous one held during a switch (see hold-previous). Call during component setup.
 * `current`: the pane's conversation; `ready`: whether a transcript has loaded.
 */
export function holdPrevious<C>(current: () => C | null, ready: (c: C) => boolean): { readonly value: Shown<C> } {
	let previous: C | null = null;
	let since = 0;
	let tick = $state(0);
	let timer: ReturnType<typeof setTimeout> | undefined;
	$effect.pre(() => {
		void current();
		since = performance.now();
		clearTimeout(timer);
		timer = setTimeout(() => tick++, HOLD_PREVIOUS_MS); // re-evaluated when the hold runs out
	});
	$effect(() => () => clearTimeout(timer));
	const shown = $derived.by(() => {
		void tick;
		const c = current();
		return shownChat(c, !!c && ready(c), previous, since, performance.now());
	});
	// the last transcript drawn for real (loaded, not held) is the one kept on the next switch
	$effect.pre(() => {
		if (!shown.held && shown.chat && ready(shown.chat)) previous = shown.chat;
	});
	return {
		get value() {
			return shown;
		},
	};
}
