/**
 * Local persistence for the app's own state: every key it keeps in localStorage, and the read/write pair that also
 * mirrors writes to durable storage (so a WebView that clears localStorage gets them back; see durable-storage.ts).
 */
import { setDurableSetting } from "./durable-storage";

export const K = {
  servers: "pipaya.servers",
  currentServer: "pipaya.server",
  theme: "pipaya.theme",
  active: "pipaya.active", // per server: pipaya.active.<serverId>
  draft: "pipaya.draft",
  sidebar: "pipaya.sidebar", // "1" when collapsed (desktop)
  sidebarW: "pipaya.sidebar.w", // desktop width in px
  workdir: "pipaya.workdir", // per server: pipaya.workdir.<serverId>
  sound: "pipaya.sound", // notification sounds on/off
  volume: "pipaya.volume2", // notification volume, 0-200 (100 = base loudness)
  escalate: "pipaya.notify.escalate", // per server: pipaya.notify.escalate.<serverId>
  quietPeers: "pipaya.notify.quietPeers", // per server: pipaya.notify.quietPeers.<serverId>, "false" = also notify about agent-to-agent runs
  favModels: "pipaya.fav.models", // per server: pipaya.fav.models.<serverId>, entries "<provider>\u0000<modelId>"
  favDirs: "pipaya.fav.dirs", // per server: pipaya.fav.dirs.<serverId>, absolute directory paths
  terminal: "pipaya.terminal", // terminal look: { fontFamily, fontSize, lineHeight, cursorBlink, scrollback }
  footer: "pipaya.footer", // footer items: { order, hidden, layout, align }
  uiScale: "pipaya.uiscale", // whole-app zoom in percent, 50-200 (100 = normal)
  keys: "pipaya.keys", // shortcut overrides: { <action>: combo | "" }
  settingsFold: "pipaya.settings.fold", // settings sections folded or unfolded by the user: { <tabId>: true (folded) | false }
  folded: "pipaya.folded", // sidebar tree nodes collapsed: "<serverId>" or "<serverId>\u0000<workdir>"
  tabOrder: "pipaya.taborder", // tab order set by dragging (sidebar and tab bar): { <serverId>: [groupId | sessionId | terminalId, ...] }
  fullGroups: "pipaya.fullgroups", // groups shown one pane at a time with a tab strip: [groupId, ...]
  groupDir: "pipaya.groupdir", // folder a group is listed under, fixed once seen: { <serverId>: { <groupId>: cwd } }
  pinnedTabs: "pipaya.pinnedtabs", // tabs pinned to the top of their folder: { <serverId>: [groupId | sessionId | terminalId, ...] }
  pinnedDirs: "pipaya.pinneddirs", // folders pinned to the sidebar, kept even with no tabs: { <serverId>: [cwd, ...] }
  dirNames: "pipaya.dirnames", // names given to pinned folders, shown instead of the path's tail: { <serverId>: { <cwd>: name } }
  dirOrder: "pipaya.dirorder", // sidebar directory order set by dragging: { <serverId>: [cwd, ...] }
};

export function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function write(key: string, value: unknown) {
  try {
    const json = JSON.stringify(value);
    localStorage.setItem(key, json);
    void setDurableSetting(key, json);
  } catch {
    /* storage unavailable */
  }
}
