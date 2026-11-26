import { getContext, setContext } from "svelte";
import type { ChatState } from "./chat.svelte";
import { app } from "./store.svelte";

/** The pane a component lives in: which session it shows, whether it holds focus, and whether it is a read-only preview. */
export interface PaneCtx {
	/** null = a new chat that has no session yet */
	readonly id: string | null;
	readonly focused: boolean;
	/** True inside a read-only preview (closed session or another server's session). */
	readonly readonly?: boolean;
	/** Server owning this session when different from `app.serverId`. */
	readonly server?: string | null;
	/** Standalone `ChatState` provided by `ReadonlyPane` when the session is not in `app.chats`. */
	readonly chat?: ChatState | null;
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
		get readonly() {
			return get().readonly ?? false;
		},
		get server() {
			return get().server ?? app.serverId;
		},
		get chat() {
			return get().chat ?? null;
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
			readonly: false,
			get server() {
				return app.serverId;
			},
			chat: null,
		}
	);
}
