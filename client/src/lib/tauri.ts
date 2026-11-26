export const isTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** True only inside the desktop Tauri shell (Windows, macOS, Linux), never in browsers or mobile apps. */
export function isDesktopTauri(): boolean {
	if (!isTauri() || typeof navigator === "undefined") return false;
	const ua = navigator.userAgent ?? "";
	if (/Android|iPhone|iPad|iPod/i.test(ua)) return false;
	if (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1 && !/Chrome\//.test(ua)) return false;
	return true;
}

/** Open a URL in the system browser when inside Tauri, otherwise a new tab. */
export async function openExternal(url: string): Promise<void> {
	if (isTauri()) {
		try {
			const { openUrl } = await import("@tauri-apps/plugin-opener");
			await openUrl(url);
			return;
		} catch {
			/* fall through to window.open */
		}
	}
	window.open(url, "_blank", "noopener,noreferrer");
}
