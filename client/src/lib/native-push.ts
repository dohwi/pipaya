import { isTauri } from "./tauri";
import { hexOf } from "./css-color";
import { notificationPlatform, type NativePushAdapter, type PushRegistration } from "./notifications";

/** Loaded on demand like every other Tauri module, so the web build never carries the IPC bridge in its main chunk. */
const invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => (await import("@tauri-apps/api/core")).invoke<T>(cmd, args);
/**
 * Paints the Android status and navigation bars to match the app theme. The colour is the page's own background,
 * read from CSS, so it follows the theme and any extension theme without a second list of colours to keep in step.
 */
export function syncSystemBars(): void {
  if (!isTauri() || notificationPlatform() !== "android") return;
  const color = hexOf(getComputedStyle(document.documentElement).getPropertyValue("--bg"));
  if (!color) return;
  void invoke("plugin:pipaya-push|set_system_bars", { color, dark: document.documentElement.dataset.theme !== "light" }).catch(() => {});
}
/**
 * Paints the desktop window frame (macOS title bar, Windows title bar) to match the app theme. Without this the frame follows the
 * operating system, so a dark app under a light system shows a white bar. `"system"` hands control back to the OS.
 */
export function syncWindowTheme(pref: "system" | "dark" | "light"): void {
  if (!isTauri() || ["android", "ios"].includes(notificationPlatform())) return;
  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().setTheme(pref === "system" ? null : pref)).catch(() => {});
}
/** Android implementation today; the same adapter contract accepts APNs or FCM on iOS. */
export function nativePushAdapter(): NativePushAdapter | undefined {
  if (!isTauri() || notificationPlatform() !== "android") return undefined;
  const register = async (): Promise<PushRegistration | null> => {
    const value = await invoke<Partial<PushRegistration>>("plugin:pipaya-push|register");
    return value?.provider === "fcm" && typeof value.token === "string" && value.token ? { provider: "fcm", token: value.token } : null;
  };
  return {
    register,
    async onTokenChanged(handler) {
      const update = () => { if (!document.hidden) void register().then(value => { if (value) handler(value); }).catch(() => {}); };
      document.addEventListener("visibilitychange", update);
      return () => document.removeEventListener("visibilitychange", update);
    },
    async onTap(handler) {
      const update = () => { void invoke<{ sessionId?: string; notificationId?: string }>("plugin:pipaya-push|pending_tap").then(data => { if (data?.sessionId) handler(data); }).catch(() => {}); };
      document.addEventListener("visibilitychange", update); window.addEventListener("focus", update); update();
      return () => { document.removeEventListener("visibilitychange", update); window.removeEventListener("focus", update); };
    },
  };
}
