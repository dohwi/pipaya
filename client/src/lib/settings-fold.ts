import { K, read, write } from "./persist";
import type { SettingsTabId } from "./settings-search";

/**
 * Sections whose children start folded until the user opens them. Their children are a list the user grows over time
 * (MCP servers, installed extensions), so the list of sections stays readable; every other section starts unfolded.
 * Once the user folds or unfolds a section, that choice is kept on this device and the next window opens the same way.
 */
export const FOLDED_AT_START: readonly SettingsTabId[] = ["mcp", "srvext"];

/** Only `{ id: boolean }` entries survive; anything else in storage is dropped. */
const clean = (raw: unknown): Record<string, boolean> =>
	raw && typeof raw === "object" && !Array.isArray(raw)
		? Object.fromEntries(Object.entries(raw).filter((e): e is [string, boolean] => typeof e[1] === "boolean"))
		: {};

/** The fold state the window opens with: the defaults, overridden by what the user last chose. `true` = folded. */
export const initialFolded = (stored: unknown = read<unknown>(K.settingsFold, {})): Record<string, boolean> => ({
	...Object.fromEntries(FOLDED_AT_START.map((id) => [id, true])),
	...clean(stored),
});

/** Remember the user's fold choices so the next settings window opens with them. */
export const saveFolded = (state: Record<string, boolean>) => write(K.settingsFold, clean(state));
