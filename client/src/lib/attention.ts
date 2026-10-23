import { isTauri } from "./tauri";
import { notificationPlatform, osFromAgent } from "./notifications";

/** Overlay for Windows, which has no numeric badge: a red disc with the count, drawn as raw RGBA. */
function overlay(count: number): { rgba: Uint8Array; size: number } | null {
	const size = 32;
	const canvas = document.createElement("canvas");
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;
	ctx.fillStyle = "#e5484d";
	ctx.beginPath();
	ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
	ctx.fill();
	ctx.fillStyle = "#fff";
	ctx.font = "bold 20px sans-serif";
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillText(count > 9 ? "9+" : String(count), size / 2, size / 2 + 1);
	return { rgba: new Uint8Array(ctx.getImageData(0, 0, size, size).data.buffer), size };
}

/**
 * Desktop taskbar / dock: shows how many sessions wait for the user (a number badge) and, when that number grows while the
 * window is not focused, flashes the taskbar entry (bounces the dock icon) until the window is focused again.
 * Returns the function to call with the new count.
 */
export function createAttention(): (count: number) => void {
	if (!isTauri() || ["android", "ios"].includes(notificationPlatform())) return () => {};
	const os = osFromAgent();
	let last = 0;
	return (count) => {
		const grew = count > last;
		last = count;
		void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
			const win = getCurrentWindow();
			if (os === "Windows") {
				if (!count) return void (await win.setOverlayIcon(undefined));
				const o = overlay(count);
				if (o) {
					const { Image } = await import("@tauri-apps/api/image");
					await win.setOverlayIcon(await Image.new(o.rgba, o.size, o.size));
				}
			} else {
				await win.setBadgeCount(count || undefined);
			}
			if (grew && !document.hasFocus()) await win.requestUserAttention(2); // UserAttentionType.Informational
		}).catch(() => {});
	};
}
