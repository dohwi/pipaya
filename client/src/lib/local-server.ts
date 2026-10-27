/** The server bundled with the desktop app, reached through the Tauri commands that start and configure it. */
import { isTauri } from "./tauri";

export interface LocalServerInfo { baseUrl: string; token: string }
export interface LocalBind { host: string; port: number }

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

/** Start the bundled server (or learn where it already runs). Null on mobile or when this build has none: the manual flow still works. */
export async function startBundledServer(): Promise<LocalServerInfo | null> {
  if (!isTauri()) return null;
  try {
    return await call<LocalServerInfo>("local_server");
  } catch {
    return null;
  }
}

/** Where the bundled server listens now (desktop only); null when this build has none. */
export async function readBundledBind(): Promise<LocalBind | null> {
  if (!isTauri()) return null;
  try {
    return await call<LocalBind>("local_server_bind");
  } catch {
    return null;
  }
}

/** Change where the bundled server listens ("" = this PC only) and restart it there. Throws the reason on failure. */
export function moveBundledServer(host: string, port: number): Promise<LocalServerInfo> {
  return call<LocalServerInfo>("set_local_server_bind", { host, port });
}
