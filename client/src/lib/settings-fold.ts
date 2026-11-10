import type { SettingsTabId } from "./settings-search";

/**
 * Sections whose children start folded when the settings window opens. Their children are a list the user grows over
 * time (MCP servers, installed extensions), so the list of sections stays readable; every other section starts unfolded
 * and any fold the user makes lasts for that window only.
 */
export const FOLDED_AT_START: readonly SettingsTabId[] = ["mcp", "srvext"];

/** The fold state the window opens with: folded sections `true`, the rest absent (unfolded). */
export const initialFolded = (): Record<string, boolean> => Object.fromEntries(FOLDED_AT_START.map((id) => [id, true]));
