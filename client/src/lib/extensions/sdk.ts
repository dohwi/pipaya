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
  type: "run_started" | "run_finished" | "session_created" | "session_updated" | "session_deleted" | "compaction_finished" | "approval_requested" | "approval_resolved";
  sessionId?: string | null;
  at: number;
  status?: string;
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
