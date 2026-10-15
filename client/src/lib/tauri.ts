export const isTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

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
