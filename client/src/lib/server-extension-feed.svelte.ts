/**
 * What the server extension pages of every saved server need to follow live. A server tells its devices when an
 * extension's settings are saved (`extension_settings_updated`), when it changes the page it shows
 * (`extension_panel_updated`) and when its extensions are reloaded (`extensions_updated`). The settings window can show a
 * server that is not the open one, so this is fed from every server's event stream (the store calls `onEvent` for each),
 * and a page reads `versions(serverId)` to know when to read again. Nothing here is specific to an extension.
 */
export interface PanelChange { extension: string; panel: unknown }

export class ServerExtensionFeed {
	/** Per server: bumped on a settings change / a reload. A page reads these in an effect and fetches again. */
	private settings = $state<Record<string, { tick: number; ids: Record<string, number> }>>({});
	private reloads = $state<Record<string, number>>({});
	/** The newest page an event carried, per server and extension (`null`: the extension removed its page). */
	private panels = $state.raw<Record<string, Record<string, unknown>>>({});

	/** Bumped whenever settings of any extension of this server changed (saved by anyone, deleted). */
	settingsTick(serverId: string): number { return this.settings[serverId]?.tick ?? 0; }
	/** Bumped when the server reloaded its extensions: the list (and every page in it) must be read again. */
	reloadTick(serverId: string): number { return this.reloads[serverId] ?? 0; }
	/** The page last pushed for an extension, or `undefined` when none was pushed since the list was read. */
	panelFor(serverId: string, extension: string): { panel: unknown } | undefined {
		const byExt = this.panels[serverId];
		return byExt && Object.hasOwn(byExt, extension) ? { panel: byExt[extension] } : undefined;
	}
	onEvent(serverId: string, type: string, data: unknown): void {
		const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
		if (type === "extension_settings_updated") {
			const cur = this.settings[serverId] ?? { tick: 0, ids: {} };
			const id = typeof d.id === "string" ? d.id : "";
			this.settings[serverId] = { tick: cur.tick + 1, ids: id ? { ...cur.ids, [id]: (cur.ids[id] ?? 0) + 1 } : cur.ids };
		} else if (type === "extensions_updated") {
			this.reloads[serverId] = (this.reloads[serverId] ?? 0) + 1;
			// A reload drops every page and the extensions set theirs again; the list read that follows has them all.
			if (this.panels[serverId]) { const { [serverId]: _drop, ...rest } = this.panels; this.panels = rest; }
		} else if (type === "extension_panel_updated" && typeof d.extension === "string") {
			this.panels = { ...this.panels, [serverId]: { ...this.panels[serverId], [d.extension]: d.panel ?? null } };
		}
	}
}
