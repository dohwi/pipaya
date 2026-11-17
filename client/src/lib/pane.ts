import { getContext, setContext } from "svelte";
import { app } from "./store.svelte";

/** The pane a component lives in: which session it shows and whether it has the user's focus. */
export interface PaneCtx {
	/** null = a new chat that has no session yet */
	readonly id: string | null;
	readonly focused: boolean;
}

const KEY = Symbol("pane");

export function setPane(get: () => PaneCtx): void {
	setContext<PaneCtx>(KEY, {
		get id() {
			return get().id;
		},
		get focused() {
			return get().focused;
		},
	});
}

/** Outside any pane this is simply the focused session. */
export function getPane(): PaneCtx {
	return (
		getContext<PaneCtx | undefined>(KEY) ?? {
			get id() {
				return app.activeId;
			},
			focused: true,
		}
	);
}
