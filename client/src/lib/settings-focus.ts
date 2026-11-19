/**
 * Opening the settings on one thing (the graph view's "설정 열기" on a provider, model or subagent card): which row of
 * which section to bring into view. `app.openSettings(tab, server, focus)` hands it over once; the settings window takes
 * it as it opens, waits for the row (its list loads after the window), scrolls it to the middle and outlines it for a
 * moment (`.flash` in app.css). The rows carry `data-provider`, `data-model`, `data-role` or `data-focus` for this.
 */
import { reduced } from "./motion";

export type SettingsFocus =
	/** A connection: a custom connection's card or a signed-in built-in provider's row. */
	| { kind: "provider"; provider: string }
	/** A model in its connection's model list (folded open), else its connection. */
	| { kind: "model"; provider: string; model: string }
	/** A global role file's row in the subagent list. */
	| { kind: "role"; name: string }
	/** The subagent role list itself (a project's role is not listed in the settings). */
	| { kind: "roles" }
	/** The "서브에이전트 위임" block (a role the agent made up has no row of its own). */
	| { kind: "delegate" }
	/** The connection list (a built-in provider signed in from the server's environment has no row of its own). */
	| { kind: "connections" };

/** `[data-<name>="value"]`, with the value quoted for CSS (ids hold dots, slashes and colons). */
export const byData = (name: string, value: string) => `[data-${name}="${value.replace(/["\\]/g, "\\$&")}"]`;

/**
 * Where to land, best first: the first of `want` that shows up wins; when none does in time, `fallback` (the section that
 * would hold it, e.g. a built-in connection signed in from the environment has no row of its own).
 */
export function focusTargets(f: SettingsFocus): { want: string[]; fallback: string | null } {
	const connections = byData("focus", "connections");
	switch (f.kind) {
		case "provider":
			return { want: [byData("provider", f.provider)], fallback: connections };
		case "model":
			// a built-in provider's models are not listed in the settings: its row is the nearest place
			return { want: [byData("model", `${f.provider}/${f.model}`), byData("provider", f.provider)], fallback: connections };
		case "role":
			return { want: [byData("role", f.name)], fallback: byData("focus", "roles") };
		case "roles":
			return { want: [byData("focus", "roles")], fallback: null };
		case "delegate":
			return { want: [byData("focus", "delegate")], fallback: null };
		case "connections":
			return { want: [connections], fallback: null };
	}
}

/** The first of `selectors` under `root`, in that order of preference. */
const first = (root: Element, selectors: string[]) => {
	for (const s of selectors) {
		const el = root.querySelector<HTMLElement>(s);
		if (el) return el;
	}
	return null;
};

/**
 * Calls `found` with the element `f` points at under `root` as soon as it is there (lists load after the window opens),
 * else with its fallback (or null) after `timeoutMs`. Returns a cancel.
 */
export function watchTarget(root: Element, f: SettingsFocus, found: (el: HTMLElement | null) => void, timeoutMs = 3000): () => void {
	const { want, fallback } = focusTargets(f);
	let observer: MutationObserver | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const stop = () => {
		observer?.disconnect();
		clearTimeout(timer);
	};
	const now = first(root, want);
	if (now) {
		found(now);
		return stop;
	}
	observer = new MutationObserver(() => {
		const el = first(root, want);
		if (el) {
			stop();
			found(el);
		}
	});
	observer.observe(root, { childList: true, subtree: true });
	timer = setTimeout(() => {
		stop();
		found(fallback ? root.querySelector<HTMLElement>(fallback) : null);
	}, timeoutMs);
	return stop;
}

/**
 * After what is moving under `root` settles (a list sliding in, a fold opening): a row measured mid-slide would scroll
 * to where it was, not to where it ends up. Endless animations (a spinner) are not waited for.
 */
export function afterMotion(root: Element): Promise<void> {
	const moving = root.getAnimations({ subtree: true }).filter((a) => a.effect?.getComputedTiming().endTime !== Infinity);
	return Promise.all(moving.map((a) => a.finished.catch(() => undefined))).then(() => undefined);
}

/** Bring `el` to the middle of its scroller and outline it for a moment so the eye lands on it after the jump. */
export function flash(el: HTMLElement) {
	el.scrollIntoView({ block: "center", behavior: reduced() ? "auto" : "smooth" });
	el.classList.remove("flash");
	void el.offsetWidth; // restart the animation when the same row is picked twice
	el.classList.add("flash");
	setTimeout(() => el.classList.remove("flash"), 1600);
}
