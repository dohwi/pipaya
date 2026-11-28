/**
 * Local persistence for the app's own state: every key it keeps in localStorage, and the read/write pair that also
 * mirrors writes to durable storage (so a WebView that clears localStorage gets them back; see durable-storage.ts).
 */
import { removeDurableSetting, setDurableSetting } from "./durable-storage";

export const K = {
  servers: "pipaya.servers",
  currentServer: "pipaya.server",
  theme: "pipaya.theme",
  active: "pipaya.active", // per server: pipaya.active.<serverId>
  draft: "pipaya.draft",
  drafts: "pipaya.composer.drafts", // unsent composer text per session ("" = new chat): { <sessionId>: { text, reply, at } }
  sidebar: "pipaya.sidebar", // "1" when collapsed (desktop)
  sidebarW: "pipaya.sidebar.w", // desktop width in px
  dock: "pipaya.dock", // true when right extension dock is collapsed (desktop)
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
  expandWork: "pipaya.work.expand", // work boxes (a reply's tool calls) open by default: true | false
  holdToQueue: "pipaya.touch.holdToQueue", // mobile: long-press the send button while running to queue directly instead of opening the menu: true | false
  mentionClick: "pipaya.click.mention", // @mention click action: "peek" | "open"
  graphClick: "pipaya.click.graph", // graph session click action: "peek" | "open"
  noticeClick: "pipaya.click.notice", // done/failed toast notice click action: "peek" | "open"
  mentionHover: "pipaya.hover.mention", // show floating hover preview card on @mentions: true | false
  sendKey: "pipaya.input.sendKey", // desktop composer send key: "enter" | "mod-enter"
  runningEnter: "pipaya.input.runningEnter", // primary send-key action while agent is running: "steer" | "queue"
  reducedMotion: "pipaya.motion.reduced", // in-app reduced motion: "system" | "on"
  keys: "pipaya.keys", // shortcut overrides: { <action>: combo | "" }
  nativeInputKeys: "pipaya.keys.nativeInput", // prefer OS text-editing shortcuts (Cmd/Ctrl+Arrow, etc.) in text fields: true | false
  settingsFold: "pipaya.settings.fold", // settings sections folded or unfolded by the user: { <tabId>: true (folded) | false }
  folded: "pipaya.folded", // sidebar tree nodes collapsed: "<serverId>", "project\u0000<serverId>\u0000<root>", "group\u0000<groupId>"
  openDirs: "pipaya.opendirs", // sidebar folders opened to list their tabs (folders start folded): ["<serverId>\u0000<workdir>", ...]
  foldedProjectDirs: "pipaya.foldedprojdirs", // folders inside a project folded by hand (they start open): ["<serverId>\u0000<workdir>", ...]
  tabOrder: "pipaya.taborder", // tab order set by dragging (sidebar and tab bar): { <serverId>: [groupId | sessionId | terminalId, ...] }
  fullGroups: "pipaya.fullgroups", // groups shown one pane at a time with a tab strip: [groupId, ...]
  groupDir: "pipaya.groupdir", // folder a group is listed under, fixed once seen: { <serverId>: { <groupId>: cwd } }
  pinnedTabs: "pipaya.pinnedtabs", // tabs pinned to the top of their folder: { <serverId>: [groupId | sessionId | terminalId, ...] }
  pinnedDirs: "pipaya.pinneddirs", // folders pinned to the sidebar, kept even with no tabs: { <serverId>: [cwd, ...] }
  dirNames: "pipaya.dirnames", // names given to folders, shown instead of the path's tail: { <serverId>: { <cwd>: name } }
  projectNames: "pipaya.projectnames", // names given to git repository projects, kept apart from folder names: { <serverId>: { <root>: name } }
  dirOrder: "pipaya.dirorder", // sidebar directory order set by dragging: { <serverId>: [cwd, ...] }
  projects: "pipaya.projects", // hand-made sidebar projects: { <serverId>: [{ id, name, dirs: [cwd, ...] }, ...] }
  hints: "pipaya.hints.seen", // one-time touch hints already shown on this device: ["mic-hold", "steer-hold", ...]
  ungrouped: "pipaya.ungrouped", // folders taken out of their git repository's project: { <serverId>: [cwd, ...] }
};

export function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Forget a value here and in durable storage, so the next read gets the fallback. */
export function remove(key: string) {
  try {
    localStorage.removeItem(key);
    void removeDurableSetting(key);
  } catch {
    /* storage unavailable */
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
