import type { app as AppStore } from "../store.svelte";
import { measure, panesOf, resizePane, swap, type Edge, type Layout } from "../layout";
import { isBrowserId } from "../browser";
import { isTerminalId } from "../terminal";
import type { ThinkingLevel } from "../types";
import { LocalizedError, t } from "../i18n";

/** What `sdk.panes` hands to extensions. Plain JSON only: nothing here may leak a token or a store object. */
export interface PaneInfo {
  /** Session id (`s…`) or terminal id. The same id addresses the pane in every `sdk.panes` call. */
  id: string;
  kind: "session" | "terminal" | "browser";
  title: string;
  cwd: string;
  focused: boolean;
  /** Sessions only. */
  running: boolean;
  /** Sessions only: questions waiting for the user's answer. */
  awaitingInput: number;
  /** Sessions only. */
  model: string | null;
  provider: string | null;
  thinkingLevel: string | null;
  groupId: string | null;
  /** Position in the group as fractions (0..1) of its area; the full area for a pane that is alone. */
  box: { x: number; y: number; w: number; h: number };
}
export interface PaneGroupInfo {
  id: string;
  name: string;
  layout: Layout;
  /** The group is shown in full mode / one pane is zoomed. */
  full: boolean;
  zoomed: string | null;
}
export type { LayoutSpec } from "./layout-spec";
/** Any group of the open server, open or not. `paneIds` lists sessions and terminals in layout order. */
export interface PaneGroupSummary { id: string; name: string; layout: Layout; paneIds: string[]; open: boolean; full: boolean }
export interface PaneMessage { role: "user" | "assistant" | "notice"; text: string; at: number }
/** Per-conversation settings; every field is optional and only the given ones change. `model` needs `provider`. */
export interface PaneSettings { title?: string; provider?: string; model?: string; thinkingLevel?: string }
export interface PaneModel { provider: string; id: string; name: string; reasoning: boolean; thinkingLevels: string[] | null; vision: boolean; contextWindow: number }
export type PaneSendMode = "prompt" | "steer" | "follow_up";

/** The surface the extension host needs from the client; implemented over the app store by `paneAdapter`. */
export interface PaneAdapter {
  /** Panes of the open group (or the single open pane); `all`: every session and terminal of the server. */
  list(all?: boolean): PaneInfo[];
  groups(): PaneGroupSummary[];
  /** Show a group (its last focused pane). */
  openGroup(id: string): Promise<void>;
  /** A new group from a layout of known panes (at least two). Resolves to its id. */
  createGroup(layout: Layout, name?: string): Promise<string>;
  setLayout(groupId: string, layout: Layout): Promise<void>;
  renameGroup(groupId: string, name: string): Promise<void>;
  /** Dissolve a group; its panes stay open on their own. */
  deleteGroup(groupId: string): Promise<void>;
  /** Full mode: one pane at a time with a strip to switch. */
  setFull(groupId: string, on: boolean): Promise<void>;
  group(): PaneGroupInfo | null;
  focus(id: string): Promise<void>;
  send(id: string, text: string, mode: PaneSendMode): Promise<void>;
  abort(id: string): Promise<void>;
  /** A new conversation (or terminal) beside `id`. Resolves to the new pane's id. */
  split(id: string, edge: Edge, kind: "session" | "terminal", focus: boolean): Promise<string>;
  /** Move `id` next to `target` (joining its group, or making one). */
  move(id: string, target: string, edge: Edge): Promise<void>;
  swap(a: string, b: string): Promise<void>;
  /** Share (0.1..0.9) of the split holding `id` that the pane gets. */
  resize(id: string, ratio: number): Promise<void>;
  /** Take the pane out of its group; the conversation stays open. */
  leave(id: string): Promise<void>;
  /** Close the conversation or terminal. */
  close(id: string): Promise<void>;
  zoom(id: string | null): Promise<void>;
  /** Models that can be chosen now (a usable credential exists). */
  models(): PaneModel[];
  configure(id: string, settings: PaneSettings): Promise<void>;
  compact(id: string, instructions?: string): Promise<void>;
  read(id: string, limit: number): Promise<PaneMessage[]>;
}

const fail = (m: string): never => { throw new LocalizedError(m); };

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export function paneAdapter(app: typeof AppStore): PaneAdapter {
  const known = (id: string) => app.shows(id) || fail(t("열려 있지 않은 패널입니다: {id}", { id }));
  const sessionOnly = (id: string) => { known(id); if (isTerminalId(id) || isBrowserId(id)) fail(t("터미널이나 브라우저에는 쓸 수 없는 동작입니다")); };
  const groupOf = (id: string) => app.groupOf(id);
  const info = (id: string): PaneInfo => {
    const s = app.session(id), term = app.terminal(id), web = app.browser(id), g = groupOf(id);
    const box = g ? measure(g.layout).panes.find(p => p.id === id) : undefined;
    return {
      id, kind: s ? "session" : web ? "browser" : "terminal", title: (s?.title || term?.title || web?.title || web?.url) ?? "", cwd: (s?.cwd || term?.cwd || web?.cwd) ?? "",
      focused: app.activeId === id, running: !!s && !!app.running[id], awaitingInput: s ? app.awaiting[id] ?? 0 : 0,
      model: s?.model ?? null, provider: s?.provider ?? null, thinkingLevel: s?.thinkingLevel ?? null, groupId: g?.id ?? null,
      box: box ? { x: box.x, y: box.y, w: box.w, h: box.h } : { x: 0, y: 0, w: 1, h: 1 },
    };
  };
  const settled = async (id: string, what: () => Promise<boolean>) => {
    // `app.send` refuses while another send is in flight; an orchestrator sending to several panes just waits its turn.
    for (let i = 0; i < 40 && app.sending; i++) await sleep(50);
    await app.ensureChat(id);
    if (!(await what())) fail(t("보내지 못했습니다"));
  };
  const groupById = (id: string) => app.groups.find(g => g.id === id) ?? fail(t("그룹을 찾을 수 없습니다: {id}", { id }));
  const knownLayout = (layout: Layout) => { for (const id of panesOf(layout)) known(id); return layout; };
  return {
    groups() {
      const open = app.activeGroup?.id ?? null;
      return app.groups.map(g => ({ id: g.id, name: g.name, layout: JSON.parse(JSON.stringify(g.layout)), paneIds: panesOf(g.layout).filter(id => app.shows(id)), open: g.id === open, full: app.isFull(g.id) }));
    },
    async openGroup(id) { groupById(id); app.openTab(id); },
    async createGroup(layout, name) {
      const g = await app.createGroup(knownLayout(layout), name);
      return g?.id ?? fail(t("그룹을 만들지 못했습니다"));
    },
    async setLayout(groupId, layout) {
      groupById(groupId);
      await app.saveLayout(groupId, knownLayout(layout));
      await app.refreshGroups();
    },
    async renameGroup(groupId, name) { groupById(groupId); await app.renameGroup(groupId, name); },
    async deleteGroup(groupId) { groupById(groupId); await app.deleteGroup(groupId); },
    async setFull(groupId, on) { groupById(groupId); if (app.isFull(groupId) !== on) app.toggleFull(groupId); },
    list(all = false) {
      if (all) return [...app.sessions.map(s => s.id), ...app.terminals.map(x => x.id)].filter(id => app.shows(id)).map(info);
      const g = app.activeGroup;
      const ids = g ? panesOf(g.layout).filter(id => app.shows(id)) : app.activeId && app.shows(app.activeId) ? [app.activeId] : [];
      return ids.map(info);
    },
    group() {
      const g = app.activeGroup;
      return g ? { id: g.id, name: g.name, layout: JSON.parse(JSON.stringify(g.layout)), full: app.isFull(g.id), zoomed: app.zoomId } : null;
    },
    async focus(id) { known(id); await app.openSession(id); },
    async send(id, text, mode) {
      sessionOnly(id);
      await settled(id, () => mode === "steer" ? app.steer(text, [], id) : mode === "follow_up" ? app.queue(text, [], id) : app.send(text, [], id));
    },
    async abort(id) { sessionOnly(id); await app.abort(id); },
    async split(id, edge, kind, focus) {
      known(id);
      const made = kind === "terminal"
        ? (await app.openTerminal(app.session(id)?.cwd ?? app.terminal(id)?.cwd, { target: id, zone: edge, focus }))?.id
        : await app.splitPane(id, edge, focus);
      return made ?? fail(t("패널을 만들지 못했습니다"));
    },
    async move(id, target, edge) {
      known(id); known(target);
      if (id === target) fail(t("같은 패널입니다"));
      await app.dropSession(id, target, edge, false);
    },
    async swap(a, b) {
      known(a); known(b);
      const g = groupOf(a);
      if (!g || groupOf(b)?.id !== g.id || a === b) fail(t("같은 그룹의 서로 다른 패널이어야 합니다"));
      await app.saveLayout(g!.id, swap(g!.layout, a, b));
    },
    async resize(id, ratio) {
      known(id);
      const g = groupOf(id);
      const next = g && resizePane(g.layout, id, ratio);
      if (!g || !next) return fail(t("그룹에 속한 대화가 아닙니다"));
      await app.saveLayout(g.id, next);
    },
    async leave(id) { known(id); await app.leaveGroup(id); },
    async close(id) { known(id); await (isTerminalId(id) ? app.closeTerminal(id) : isBrowserId(id) ? app.closeBrowser(id) : app.close(id)); },
    async zoom(id) {
      if (id === null) { app.zoomId = null; return; }
      known(id);
      const g = groupOf(id);
      if (!g) return fail(t("그룹에 속한 대화가 아닙니다"));
      if (app.isFull(g.id)) app.toggleFull(g.id);
      app.zoomId = id;
    },
    models() {
      return app.models.filter(m => m.configured && m.available !== false).map(m => ({ provider: m.provider, id: m.id, name: m.name, reasoning: m.reasoning, thinkingLevels: m.thinkingLevels ?? null, vision: m.vision, contextWindow: m.contextWindow }));
    },
    async configure(id, settings) {
      sessionOnly(id);
      const s = app.session(id)!;
      const { title, provider, model, thinkingLevel } = settings;
      if ((provider === undefined) !== (model === undefined)) fail(t("provider와 model은 함께 지정해야 합니다"));
      const target = model === undefined ? app.models.find(m => m.provider === s.provider && m.id === s.model) : app.models.find(m => m.provider === provider && m.id === model && m.configured && m.available !== false);
      if (model !== undefined && !target) fail(t("사용할 수 없는 모델입니다: {model}", { model: `${provider}/${model}` }));
      if (thinkingLevel !== undefined && target?.thinkingLevels && !target.thinkingLevels.includes(thinkingLevel as ThinkingLevel))
        fail(t("이 모델이 지원하지 않는 추론 강도입니다: {level}", { level: thinkingLevel }));
      if (title !== undefined) await app.rename(id, title);
      const model_ = provider === undefined ? {} : { provider, model };
      if (provider !== undefined || thinkingLevel !== undefined) {
        if (!(await app.configure({ ...model_, ...(thinkingLevel === undefined ? {} : { thinkingLevel: thinkingLevel as ThinkingLevel }) }, id))) fail(t("변경하지 못했습니다"));
      }
    },
    async compact(id, instructions) {
      sessionOnly(id);
      await app.ensureChat(id);
      if (!(await app.compact(instructions, id))) fail(t("압축하지 못했습니다"));
    },
    async read(id, limit) {
      sessionOnly(id);
      await app.ensureChat(id);
      const items = app.chatOf(id)?.items ?? [];
      const out: PaneMessage[] = [];
      for (const it of items) {
        if (it.kind === "user") out.push({ role: "user", text: it.text.slice(0, 4000), at: it.ts });
        else if (it.kind === "assistant") out.push({ role: "assistant", text: it.blocks.flatMap(b => b.type === "text" ? [b.text] : []).join("\n").slice(0, 4000), at: it.ts });
        else if (it.kind === "notice") out.push({ role: "notice", text: it.text.slice(0, 4000), at: it.ts });
      }
      return out.slice(-limit);
    },
  };
}
