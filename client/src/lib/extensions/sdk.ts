import type { NavbarItemSpec } from "./navbar";
import type { NotificationSpec, NotificationResult, NotificationRule, NotificationStatus } from "../notification-contract";
export type { NotificationSpec, NotificationResult, NotificationRule, NotificationStatus, NotificationKind } from "../notification-contract";
export type { NavbarItemSpec } from "./navbar";
import type { UIPanelSpec, UINode, UIEvent, UITone } from "./ui";
export type { UIPanelSpec, UINode, UIEvent, UIFieldValue, UITone, IconSpec, IconPath, UIIconNode, UIGaugeNode, UIGaugeRing, UIGaugeRow, UIGaugeDetails } from "./ui";

/** Public SDK v1 types for extension authors. Runtime APIs are provided as the
 * `sdk` argument inside a package's async code body, not imported from the app. */
export interface ExtensionContext {
  sessionId: string | null;
  model: string;
  provider: string;
  running: boolean;
  online: boolean;
}
export interface ExtensionEvent {
  type: "run_started" | "run_finished" | "session_created" | "session_updated" | "session_deleted" | "compaction_finished" | "approval_requested" | "approval_resolved" | "turn_end" | "tool_execution_end";
  sessionId?: string | null;
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
  state: "pending" | "awaiting_approval" | "running" | "done" | "error" | "denied" | "skipped";
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
    open(id: string): Promise<void>;
    close(id: string): Promise<void>;
    remove(id: string): Promise<void>;
  };
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
    /** Server extensions that are loaded, their tools, commands and methods. */
    list(): Promise<{ name: string; tools: string[]; commands: { name: string; description?: string }[]; methods: string[]; error?: string }[]>;
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
   * Needs `messages`: draw the entries a server extension stored on the open conversation (`ctx.appendEntry`) as cards
   * in the transcript, in the order they were made. Without a renderer an entry is not shown. Return `null` to hide one.
   */
  readonly messages: {
    registerRenderer(entryType: string, render: (entry: { id: number; extension: string; type: string; data: unknown; createdAt: number }) => UINode | null | Promise<UINode | null>): Promise<void>;
    removeRenderer(entryType: string): Promise<void>;
  };
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
