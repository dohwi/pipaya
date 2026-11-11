/**
 * The settings window on a phone is two steps, not a row of tabs: the list of every section, then one section with a back
 * arrow. Pure so the transitions can be tested; `Settings.svelte` holds the state.
 */
import { SETTINGS_TABS } from "./settings-search";

export type PhoneStep = "list" | "detail";
export interface PhoneNav {
	step: PhoneStep;
	/** The open extension / MCP server inside the section, if any */
	extId: string | null;
}

/** Opened for a section (a "set the model" link, an extension's `openSettings(tab)`) lands on it; a plain open shows the list. */
export const phoneStart = (direct: boolean): PhoneStep => (direct ? "detail" : "list");

/** Back from a section: first out of an open extension page, then to the list. From the list the window itself closes (not our step). */
export function phoneBack(s: PhoneNav): PhoneNav {
	if (s.step === "detail" && s.extId) return { step: "detail", extId: null };
	return { step: "list", extId: null };
}

/** Whether the pointing device is a finger only (no mouse to hover with): shortcuts are then not what you reach for. */
export const touchOnly = (m: { coarse: boolean; hover: boolean }): boolean => m.coarse && !m.hover;

type Tab = (typeof SETTINGS_TABS)[number];

/**
 * The nav's three runs. The common sections, the chosen server's sections, and `last`: on a touch-only device the
 * shortcut list goes to the very bottom (it stays reachable for an external keyboard), elsewhere it keeps its place.
 */
export function navGroups(tabs: readonly Tab[], touch: boolean): { common: Tab[]; server: Tab[]; last: Tab[] } {
	const demoted = (x: Tab) => touch && x.id === "keys";
	return {
		common: tabs.filter((x) => !x.server && !demoted(x)),
		server: tabs.filter((x) => x.server),
		last: tabs.filter(demoted),
	};
}
