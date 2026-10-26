import type { app as AppStore } from "../store.svelte";
import { SIDEBAR_W } from "../sidebar.svelte";
import { viewport } from "../viewport.svelte";
import { LocalizedError, t } from "../i18n";

/**
 * What `sdk.workspace` hands to extensions: the screen around the panes (sidebar, tabs, settings, palette and the
 * app's own commands). Plain JSON only; device-local state, nothing a server or another device sees.
 */
import { SETTINGS_TABS, WORKSPACE_DIALOGS, type SettingsTab, type WorkspaceDialog } from "./workspace-spec";
export { SETTINGS_TABS, WORKSPACE_DIALOGS, type SettingsTab, type WorkspaceDialog };

export interface WorkspaceTab { id: string; kind: "group" | "session" | "terminal" | "browser"; title: string; active: boolean; paneIds: string[] }
export interface WorkspaceState {
  /** `narrow`: phone layout, the sidebar is a drawer (`open`); otherwise it is docked and can be `collapsed`. */
  narrow: boolean;
  sidebar: { open: boolean; collapsed: boolean; width: number; minWidth: number; maxWidth: number };
  /** The working directory in front of the user and its tabs, in order. */
  folder: string;
  tabs: WorkspaceTab[];
  settingsOpen: boolean;
}
export interface SidebarChange { open?: boolean; collapsed?: boolean; width?: number }

/** The surface the extension host needs; implemented over the app store by `workspaceAdapter`. */
export interface WorkspaceAdapter {
  state(): WorkspaceState;
  sidebar(change: SidebarChange): void;
  openTab(id: string): Promise<void>;
  /** Put tab `id` before or after `target` within the current folder's tabs. */
  moveTab(id: string, target: string, after: boolean): void;
  openSettings(tab: SettingsTab): void;
  closeSettings(): void;
  open(dialog: WorkspaceDialog): void;
  /** Run one of the app's built-in slash commands (`new`, `compact`, …) with an argument, as the user would. */
  runCommand(name: string, arg: string): Promise<void>;
  /** The names `runCommand` accepts. */
  commands(): string[];
}

const fail = (m: string): never => { throw new LocalizedError(m); };

export function workspaceAdapter(app: typeof AppStore, builtIn: { names(): string[]; run(name: string, arg: string): void | Promise<void> }): WorkspaceAdapter {
  const folder = () => app.activeTab?.dir ?? app.dirs.find((d) => d.path === app.workdirAbs) ?? null;
  return {
    state() {
      const dir = folder();
      const active = app.activeTab?.tab.id ?? null;
      return {
        narrow: viewport.narrow,
        sidebar: { open: app.sidebar.open, collapsed: app.sidebar.collapsed, width: app.sidebar.width, minWidth: SIDEBAR_W.min, maxWidth: SIDEBAR_W.max },
        folder: dir?.path ?? app.workdirAbs,
        tabs: (dir?.tabs ?? []).map((x) => ({
          id: x.id, kind: x.kind, active: x.id === active,
          title: x.kind === "group" ? x.group.name : x.kind === "session" ? x.session.title : x.kind === "browser" ? x.browser.title || x.browser.url : x.terminal.title,
          paneIds: x.kind === "group" ? x.members.map((m) => m.id) : [x.id],
        })),
        settingsOpen: app.settingsOpen,
      };
    },
    sidebar(change) {
      if (change.open !== undefined) app.sidebar.open = change.open;
      if (change.collapsed !== undefined && change.collapsed !== app.sidebar.collapsed) app.sidebar.toggleCollapsed();
      if (change.width !== undefined) app.sidebar.setWidth(change.width);
    },
    async openTab(id) {
      if (!app.groups.some((g) => g.id === id) && !app.shows(id)) fail(t("열려 있지 않은 탭입니다: {id}", { id }));
      app.openTab(id);
    },
    moveTab(id, target, after) {
      const dir = folder();
      const ids = dir?.tabs.map((x) => x.id) ?? [];
      if (!app.serverId || !ids.includes(id) || !ids.includes(target)) fail(t("같은 폴더의 탭이어야 합니다"));
      if (id !== target) app.sidebar.moveTab(app.serverId!, ids, id, target, after);
    },
    openSettings(tab) { app.openSettings(tab); },
    closeSettings() { app.settingsOpen = false; },
    open(dialog) {
      if (dialog === "skills") return app.openSkills();
      if (dialog === "commands") return app.openCommands();
      if (dialog === "queue") return app.openQueue();
      app.dirPicker = true;
    },
    async runCommand(name, arg) {
      if (!builtIn.names().includes(name)) fail(t("앱 명령이 아닙니다: /{name}", { name }));
      await builtIn.run(name, arg);
    },
    commands: () => builtIn.names(),
  };
}
