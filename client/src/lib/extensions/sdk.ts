import type { NavbarItemSpec } from "./navbar";
import type { NotificationSpec, NotificationResult, NotificationRule, NotificationStatus } from "../notification-contract";
export type { NotificationSpec, NotificationResult, NotificationRule, NotificationStatus, NotificationKind } from "../notification-contract";
export type { NavbarItemSpec } from "./navbar";
import type { UIPanelSpec, UINode, UIEvent, UITone } from "./ui";
export type { UIPanelSpec, UIPanelPlacement, UIPanelSize, UIPanelPosition, UIFloatAnchor, UINode, UIEvent, UIFieldValue, UITone, IconSpec, IconPath, UIIconNode } from "./ui";

/** Public SDK v1 types for extension authors. Runtime APIs are provided as the
 * `sdk` argument inside a package's async code body, not imported from the app. */
export interface ExtensionContext {
  sessionId: string | null;
  model: string;
  provider: string;
  running: boolean;
  online: boolean;
  /** The UI language tag in use (`ko`, `en`, ...). */
  language: string;
}
export interface ExtensionEvent {
  type: "run_started" | "run_finished" | "session_created" | "session_updated" | "session_deleted" | "compaction_finished" | "question_requested" | "question_resolved" | "turn_end" | "tool_execution_end" | "group_created" | "group_updated" | "group_deleted" | "extensions_updated" | "language_changed";
  sessionId?: string | null;
  /** `group_*` only: the group. */
  groupId?: string;
  at: number;
  status?: string;
  /** `tool_execution_end` only: which tool ran and whether it failed. */
  toolName?: string;
  isError?: boolean;
}
/** What a server extension published with `pi.emit(...)` or stored with `ctx.appendEntry(...)`. Needs `server`. */
export type ServerExtensionEvent =
  | { kind: "event"; extension: string; type: string; sessionId: string | null; data: unknown }
  | { kind: "entry"; extension: string; type: string; sessionId: string | null; data: unknown; id: number };
/** The tool call a renderer is asked to draw. */
export interface ToolRenderInput {
  toolName: string;
  state: "pending" | "awaiting_input" | "running" | "done" | "error" | "skipped";
  args: Record<string, unknown>;
  output: string;
  details: Record<string, unknown> | null;
}
export interface CommandSpec { name: string; description: string; args?: string }
export interface ComposerActionSpec { id: string; label: string }
export interface ExtensionSDK {
  readonly version: 1;
  readonly commands: { register(spec: CommandSpec, handler: (arg: string) => void | Promise<void>): Promise<void> };
  readonly composer: {
    setText(text: string): Promise<void>;
    registerAction(spec: ComposerActionSpec, handler: () => void | Promise<void>): Promise<void>;
  };
  readonly ui: {
    registerPanel(spec: UIPanelSpec, handler: (event: UIEvent) => void | Promise<void>): Promise<void>;
    /** `options.tone: "danger"` shows the panel's launcher badge in red until the next update clears it. */
    update(id: string, view: UINode, options?: { tone?: UITone }): Promise<void>;
    /** `panel`: open the extension-screen modal on it. `side`/`floating`: show it. `composer`/`sidebar`: unfold it. */
    open(id: string): Promise<void>;
    /** The reverse of `open` (hides a dock or window, folds a section, closes the modal). */
    close(id: string): Promise<void>;
    /**
     * Move a panel to another placement and/or change its size and position (see `UIPanelSpec`): e.g.
     * `place("notes", { placement: "floating", size: { width: 420, height: 300 }, position: "bottom-right" })`.
     * A new placement drops the old size/position unless given; a dock or window shows, a section starts folded.
     */
    place(id: string, layout: { placement?: import("./ui").UIPanelPlacement; size?: import("./ui").UIPanelSize; position?: import("./ui").UIPanelPosition }): Promise<void>;
    remove(id: string): Promise<void>;
  };
  /** Needs `ui-components`: the value (JSON, ≤64KB) is read by this package's components as `ext.data` (from "pipaya"). */
  readonly components: { setData(value: unknown): Promise<void> };
  readonly navbar: { set(id: string, spec: NavbarItemSpec): Promise<void>; remove(id: string): Promise<void> };
  readonly http: {
    getJson(path: string): Promise<unknown>;
    requestJson(request: import("./transport").JsonRequest): Promise<import("./transport").JsonResponse>;
  };
  /** Generic approved import/export. Jobs return immediately; poll status after user approval. */
  readonly configuration: {
    authorize(): Promise<{ id: string }>;
    revoke(): Promise<void>;
    access(): Promise<{ authorized: boolean }>;
    read(): Promise<{ document: import("./configuration").ConfigurationDocument; fingerprint: string }>;
    applyBackground(document: import("./configuration").ConfigurationDocument, fingerprint: string): Promise<{ document: import("./configuration").ConfigurationDocument; fingerprint: string }>;
    export(): Promise<{ id: string }>;
    apply(document: import("./configuration").ConfigurationDocument): Promise<{ id: string }>;
    restore(): Promise<{ id: string }>;
    status(): Promise<import("./configuration").ConfigurationJob | null>;
  };
  readonly status: { set(id: string, text: string): Promise<void>; remove(id: string): Promise<void> };
  /** Needs `server`: talk to the extensions that run inside the server. */
  readonly server: {
    /** Calls `pi.registerMethod(method, ...)` of a server extension. Pass `sessionId` to give it that session's context. */
    call(extension: string, method: string, params?: unknown, sessionId?: string): Promise<unknown>;
    /** Entries a server extension stored with `ctx.appendEntry` on a session (default: the open one). */
    entries(options?: { sessionId?: string; extension?: string; type?: string }): Promise<{ id: number; extension: string; type: string; data: unknown; createdAt: number }[]>;
    /** Server extensions that are loaded: what each registered (tools, commands, command families, methods, providers, flags, hooked events). */
    list(): Promise<{ extensions: { name: string; tools: string[]; commands: { name: string; description?: string; args?: string }[]; commandFamilies: { prefix: string; label?: string }[]; methods: string[]; providers: string[]; flags: { name: string; description?: string; type: string; value?: boolean | string }[]; events: string[]; companion?: string; title?: string; version?: string; description?: string; descriptions?: Record<string, string>; settings?: unknown[]; settingsId: string; clientPackage?: boolean; error?: string }[]; commands: { name: string; description?: string; args?: string; extension: string }[] }>;
    on(handler: (event: ServerExtensionEvent) => void | Promise<void>): Promise<() => void>;
  };
  /** Needs `shortcuts`. The combo must contain Ctrl/⌘ (`Mod`) or `Alt`, e.g. `Mod+Shift+K`; the user can see which extension owns it. */
  readonly shortcuts: { register(spec: { id: string; label: string; combo: string }, handler: () => void | Promise<void>): Promise<void>; remove(id: string): Promise<void> };
  /** Needs `dialogs`: modal questions. Resolve to `null` when the user cancels. */
  readonly dialog: {
    confirm(spec: { title: string; message?: string; confirmLabel?: string }): Promise<boolean>;
    select(spec: { title: string; message?: string; options: { value: string; label: string; description?: string }[] }): Promise<string | null>;
    input(spec: { title: string; message?: string; placeholder?: string; value?: string; multiline?: boolean }): Promise<string | null>;
  };
  /** Needs `session`: act on the open conversation. At most 5 calls per 10 seconds. */
  readonly session: { send(text: string, mode?: "prompt" | "steer" | "follow_up"): Promise<void>; abort(): Promise<void> };
  /**
   * Needs `panes`: orchestrate the panes (conversations and terminals) and the groups (split layouts) of the open server.
   * A pane is addressed by its session/terminal id. Changes are limited to 30 per 10 seconds.
   * Panes opened by `split` do not take focus unless `focus: true`. `close` ends a terminal's shell for good.
   */
  readonly panes: {
    /**
     * Panes of the open group (or the single open one), each with its state and position (`box`, fractions of the group).
     * `{ all: true }`: every open conversation and terminal of the server.
     */
    list(options?: { all?: boolean }): Promise<import("./panes").PaneInfo[]>;
    /** Every group of the server, with its layout and whether it is the one shown. */
    groups(): Promise<import("./panes").PaneGroupSummary[]>;
    /** Show a group (focus goes to the pane last used in it). */
    openGroup(groupId: string): Promise<void>;
    /**
     * A new group from a layout: `{ type: "pane", id }` | `{ type: "split", dir: "row" | "col", ratio?: 0.1–0.9, a, b }`,
     * 2–8 panes of open conversations/terminals. A pane already in another group moves here. Resolves to the group id.
     */
    createGroup(layout: import("./panes").LayoutSpec, name?: string): Promise<{ id: string }>;
    /** Replace a group's whole layout (same rules as `createGroup`): reorder, re-split, resize, add or drop panes at once. */
    setLayout(groupId: string, layout: import("./panes").LayoutSpec): Promise<void>;
    renameGroup(groupId: string, name: string): Promise<void>;
    /** Dissolve a group; its panes stay open on their own. */
    deleteGroup(groupId: string): Promise<void>;
    /** Full mode on/off: one pane of the group at a time, with a strip to switch. */
    full(groupId: string, on: boolean): Promise<void>;
    /** The open group's name and layout tree, or `null` outside a group. */
    group(): Promise<import("./panes").PaneGroupInfo | null>;
    /** The last `limit` (default 20, max 100) messages of a conversation as text. */
    read(id: string, options?: { limit?: number }): Promise<import("./panes").PaneMessage[]>;
    focus(id: string): Promise<void>;
    /** Send to a specific conversation, focused or not. `steer`/`follow_up` queue behind a running turn. */
    send(id: string, text: string, mode?: import("./panes").PaneSendMode): Promise<void>;
    abort(id: string): Promise<void>;
    /** A new conversation (same folder and model) or terminal beside `id`. Resolves to its id. */
    split(id: string, edge: "left" | "right" | "top" | "bottom", options?: { kind?: "session" | "terminal"; focus?: boolean }): Promise<{ id: string }>;
    /** Move `id` to the given side of `target` (joins its group, or forms one). */
    move(id: string, target: string, edge: "left" | "right" | "top" | "bottom"): Promise<void>;
    swap(a: string, b: string): Promise<void>;
    /** Give `id` the share 0.1–0.9 of the split that holds it. */
    resize(id: string, ratio: number): Promise<void>;
    /** Take `id` out of its group; the conversation stays open. */
    leave(id: string): Promise<void>;
    close(id: string): Promise<void>;
    /** Enlarge a pane to the whole group; `zoom()` / `zoom(null)` puts it back. */
    zoom(id?: string | null): Promise<void>;
    /** Models that can be chosen now, with the thinking levels each accepts (`null` = every level). */
    models(): Promise<import("./panes").PaneModel[]>;
    /**
     * Change one conversation's own settings (not the defaults of new chats): `title`, `provider` + `model` together,
     * `thinkingLevel` (`minimal`…`max`, must suit the model). Conversations only.
     */
    configure(id: string, settings: import("./panes").PaneSettings): Promise<void>;
    /** Compress the conversation's context now (not while it is running). */
    compact(id: string, instructions?: string): Promise<void>;
  };
  /**
   * Needs `workspace`: the screen around the panes on this device. Changes share the pane limit (30 per 10 seconds).
   * Built-in commands can be run but never replaced: an extension cannot register `/new`, `/compact`, …
   */
  readonly workspace: {
    state(): Promise<import("./workspace").WorkspaceState>;
    /** `open`: the drawer on a narrow screen; `collapsed`: the docked sidebar shrinks to a rail; `width` in px (clamped). */
    sidebar(change: import("./workspace").SidebarChange): Promise<void>;
    /** Show a tab of `state().tabs` (a group, conversation or terminal id). */
    openTab(id: string): Promise<void>;
    /** Reorder the current folder's tabs: put `id` before (default) or after `target`. */
    moveTab(id: string, target: string, edge?: "before" | "after"): Promise<void>;
    openSettings(tab?: import("./workspace").SettingsTab): Promise<void>;
    closeSettings(): Promise<void>;
    /** Open a built-in screen: `skills`, `commands` (extension commands), `queue`, `folder` (the folder picker). */
    open(dialog: import("./workspace").WorkspaceDialog): Promise<void>;
    /** Run a built-in slash command on the focused pane, as if typed: `runCommand("compact", "keep the plan")`. */
    runCommand(name: string, arg?: string): Promise<void>;
    /** Names `runCommand` accepts. */
    commands(): Promise<string[]>;
  };
  /**
   * Needs `messages`: draw the entries a server extension stored on the open conversation (`ctx.appendEntry`) as cards
   * in the transcript, in the order they were made. Without a renderer an entry is not shown. Return `null` to hide one.
   */
  readonly messages: {
    registerRenderer(entryType: string, render: (entry: { id: number; extension: string; type: string; data: unknown; createdAt: number }) => UINode | null | Promise<UINode | null>): Promise<void>;
    removeRenderer(entryType: string): Promise<void>;
    /**
     * Give user messages a header: when the first line of a message matches `pattern` (a RegExp source, at most 400
     * characters, tested on the first 500 characters), group 1 is shown as a header above the bubble and the lines after
     * it as the text. Replaces the earlier rule of this extension.
     */
    setHeader(pattern: string): Promise<void>;
    clearHeader(): Promise<void>;
  };
  /**
   * Needs `session-labels`: a short label (at most 40 characters) in front of a session's title in the sidebar and the
   * pane header, keyed by session id. Each call replaces all labels of this extension; at most 1000.
   */
  readonly sessionLabels: { set(labels: Record<string, { text: string; title?: string }>): Promise<void> };
  /**
   * Needs `composer-mentions`: `@` completions in the composer. `insert` (`@token`, no spaces) is what lands in the text
   * and gets highlighted; `desc`, `group` (menu heading) and `keywords` (extra match text) are shown or searched;
   * `except` is a session id that does not get the item (usually itself). Each call replaces the list; at most 500.
   */
  readonly mentions: { set(items: { insert: string; desc?: string; group?: string; keywords?: string; except?: string }[]): Promise<void> };
  /**
   * Needs `slots`: read-only views above the composer (`footer`) or under the header (`header`), like navbar items but
   * wider. Same node limits as navbar items; at most 2 per extension.
   */
  readonly slots: { set(slot: "header" | "footer", id: string, spec: { label: string; view: UINode }): Promise<void>; remove(slot: "header" | "footer", id: string): Promise<void> };
  /**
   * Needs `composer-filter`: runs on the text just before it is sent and may rewrite it or stop the send. The handler has
   * 2 seconds; on timeout or error the text is sent unchanged. Slash commands are not filtered.
   */
  readonly composerFilter: { set(filter: (text: string) => string | { text: string } | { cancel: string } | null | Promise<string | { text: string } | { cancel: string } | null>): Promise<void>; clear(): Promise<void> };
  /** Needs `tools`: draw the result of a tool call (a built-in or a server extension's) as a view. Return `null` to keep the default look. */
  readonly tools: { registerRenderer(toolName: string, render: (call: ToolRenderInput) => UINode | null | Promise<UINode | null>): Promise<void>; removeRenderer(toolName: string): Promise<void> };
  readonly context: { get(): Promise<ExtensionContext> };
  readonly events: { on(handler: (event: ExtensionEvent) => void | Promise<void>): Promise<() => void> };
  readonly storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
  readonly settings: { get(): Promise<Record<string, unknown>> };
  readonly notifications: {
    /** Existing in-app toast; requires `notifications`. */
    show(text: string): Promise<void>;
    /** OS/push notification respecting presence and user settings; requires `system-notifications`. */
    send(spec: NotificationSpec): Promise<NotificationResult>;
    status(): Promise<NotificationStatus>;
    /** Durable server-side event rule: continues when the app is closed. At most five per extension. */
    register(id: string, rule: NotificationRule): Promise<void>;
    remove(id: string): Promise<void>;
  };
  log(...values: unknown[]): Promise<void>;
}
