import type { Platform } from "./notifications";

/** Where the install commands come from: the root README and install.sh / install.ps1. */
export const INSTALL_SERVER_CMD = "curl -fsSL https://raw.githubusercontent.com/dohwi/pipaya/main/install.sh | bash";
export const INSTALL_WINDOWS_CMD = "irm https://raw.githubusercontent.com/dohwi/pipaya/main/install.ps1 | iex";
/** install.sh prints this line itself; its data dir defaults to ~/.pipaya. */
export const TOKEN_CMD = "cat ~/.pipaya/token";

export type FirstRunWay = "local" | "scan" | "manual";

/**
 * The ways to connect that can work in this app, best first. `local` needs the desktop app (it bundles a server and
 * normally starts it by itself, so this is the retry), `scan` a phone app with a camera, `manual` works everywhere.
 */
export function firstRunWays(env: { tauri: boolean; platform: Platform }): FirstRunWay[] {
	const phone = env.tauri && (env.platform === "android" || env.platform === "ios");
	if (phone) return ["scan", "manual"];
	if (env.tauri) return ["local", "manual"];
	return ["manual"];
}
