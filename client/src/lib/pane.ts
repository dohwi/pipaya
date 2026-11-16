import { getContext, setContext } from "svelte";
import { app } from "./store.svelte";
import type { ChatState } from "./chat.svelte";

/** The pane a component lives in: which session it shows and whether it has the user's focus. */
export interface PaneCtx {
	/** null = a new chat that has no session yet */
	readonly id: string | null;
	readonly focused: boolean;
	/**
	 * A transcript shown outside the open server's panes (the graph view's quick look at a chat on any server): the
	 * components read it instead of `app.chatOf(id)`, and leave out what acts through the open server (reply into the
	 * composer, retry, branch, answer).
	 */
	readonly peek?: ChatState;
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
		get peek() {
			return get().peek;
		},
	});
}

/** The transcript a component in this pane shows. */
export const paneChat = (pane: PaneCtx): ChatState | null => pane.peek ?? app.chatOf(pane.id);

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
