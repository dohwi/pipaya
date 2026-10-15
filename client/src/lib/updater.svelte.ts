import { isTauri, openExternal } from "./tauri";
import { notificationPlatform } from "./notifications";
import { APK_NAME, DOWNLOAD_PREFIX, fetchLatestRelease, isNewer } from "./update-check";
import { LocalizedError, t } from "./i18n";

/**
 * Update flow for the installed app.
 *  - Windows / macOS: Tauri updater. The bundle is verified against the public key in tauri.conf.json, installed,
 *    and the app restarts. Nothing is installed without the user pressing the button.
 *  - Android: the APK is downloaded inside the app (with a progress bar) and handed to the system installer, which
 *    still asks the user to confirm: Android never lets an app install itself silently. If anything in the native
 *    side fails, the APK link is opened in the browser instead, as before.
 *  - iOS and the browser: nothing to update from here.
 */
type Phase = "idle" | "checking" | "available" | "downloading" | "ready" | "ready-install" | "error";

const AUTO = "pipaya.update.auto"; // "0" turns the startup check off

type Mode = "desktop" | "android" | "none";
function mode(): Mode {
	if (!isTauri()) return "none";
	const p = notificationPlatform();
	return p === "desktop" ? "desktop" : p === "android" ? "android" : "none";
}

class Updater {
	phase = $state<Phase>("idle");
	version = $state("");
	current = $state("");
	progress = $state(0); // 0..1, 0 while the size is unknown
	error = $state("");
	/** Hidden by "later" until the app is started again (not remembered), so every launch reminds the user. */
	dismissed = $state("");
	auto = $state(localStorage.getItem(AUTO) !== "0");
	supported = mode() !== "none";

	private update: import("@tauri-apps/plugin-updater").Update | null = null;
	private apkUrl: string | null = null;
	private busy = false;

	get visible(): boolean {
		return (this.phase === "available" || this.phase === "downloading" || this.phase === "ready" || this.phase === "ready-install") && this.dismissed !== this.version;
	}

	setAuto(on: boolean) {
		this.auto = on;
		localStorage.setItem(AUTO, on ? "1" : "0");
	}

	dismiss() {
		this.dismissed = this.version;
	}

	/** Called at every launch: respects the setting; a newer version opens the update dialog. */
	autoCheck() {
		if (!this.supported || !this.auto) return;
		void this.check(false);
	}

	/** `manual` shows "up to date" and errors; a background check stays silent. */
	async check(manual = true): Promise<void> {
		if (!this.supported || this.busy || this.phase === "downloading") return;
		this.busy = true;
		this.error = "";
		if (manual) this.phase = "checking";
		try {
			const { getVersion } = await import("@tauri-apps/api/app");
			this.current = await getVersion();
			if (mode() === "desktop") {
				const { check } = await import("@tauri-apps/plugin-updater");
				const found = await check({ timeout: 15000 });
				this.update = found;
				if (found) this.found(found.version);
				else this.none();
			} else {
				const info = await fetchLatestRelease();
				this.apkUrl = info.apkUrl;
				if (isNewer(info.version, this.current)) this.found(info.version);
				else this.none();
			}
		} catch (e) {
			this.phase = manual ? "error" : "idle";
			if (manual) this.error = e instanceof LocalizedError ? e.message : t("업데이트를 확인하지 못했습니다");
		} finally {
			this.busy = false;
		}
	}

	private found(version: string) {
		this.version = version;
		this.phase = "available";
	}

	private none() {
		this.phase = "idle";
		this.version = "";
	}

	/** Only a link from this repository's latest release is ever used (checked when the release is parsed). */
	private apkLink(): string {
		return this.apkUrl && this.apkUrl.startsWith(DOWNLOAD_PREFIX) ? this.apkUrl : `${DOWNLOAD_PREFIX}${APK_NAME}`;
	}

	/** Android: download inside the app, then open the system installer. */
	private async installAndroid(): Promise<void> {
		const { invoke } = await import("@tauri-apps/api/core");
		this.phase = "downloading";
		this.progress = 0;
		this.error = "";
		try {
			await invoke("plugin:pipaya-push|download_apk", { url: this.apkLink() });
			for (let i = 0; i < 20 * 60 * 10; i++) {
				const s = await invoke<{ state: string; done: number; total: number; error: string }>("plugin:pipaya-push|update_progress");
				if (s.state === "error") throw new Error(s.error || "download failed");
				if (s.total > 0) this.progress = Math.min(1, s.done / s.total);
				if (s.state === "done") break;
				await new Promise((r) => setTimeout(r, 300));
			}
			this.progress = 1;
			await this.openInstaller(invoke);
		} catch {
			// The native side is missing or the download failed: the browser can still fetch the APK.
			this.phase = "available";
			await openExternal(this.apkLink());
		}
	}

	/** Opens the system installer. The first time, Android asks the user to allow installs from this app; then try again. */
	private async openInstaller(invoke: typeof import("@tauri-apps/api/core").invoke): Promise<void> {
		const r = await invoke<{ needsPermission?: boolean }>("plugin:pipaya-push|install_apk");
		if (r?.needsPermission) {
			// the settings page is open; when the user comes back with the switch on, install again
			this.phase = "ready-install";
			this.waitForReturn(invoke);
			return;
		}
		// the installer is on screen; the app is replaced when the user confirms, so there is nothing more to do here
		this.phase = "available";
	}

	private waitForReturn(invoke: typeof import("@tauri-apps/api/core").invoke) {
		const again = async () => {
			if (document.visibilityState !== "visible") return;
			document.removeEventListener("visibilitychange", again);
			try { await this.openInstaller(invoke); } catch { this.phase = "available"; await openExternal(this.apkLink()); }
		};
		document.addEventListener("visibilitychange", again);
	}

	/** Desktop: download, verify, install, restart. Android: download in the app and open the system installer. */
	async install(): Promise<void> {
		if (this.phase !== "available") return;
		if (mode() === "android") return this.installAndroid();
		const update = this.update;
		if (!update) return;
		this.phase = "downloading";
		this.progress = 0;
		this.error = "";
		try {
			let total = 0;
			let got = 0;
			await update.downloadAndInstall((event) => {
				if (event.event === "Started") total = event.data.contentLength ?? 0;
				else if (event.event === "Progress") {
					got += event.data.chunkLength;
					this.progress = total ? Math.min(1, got / total) : 0;
				}
			});
			this.phase = "ready";
			const { relaunch } = await import("@tauri-apps/plugin-process");
			await relaunch();
		} catch (e) {
			this.phase = "error";
			this.error = e instanceof LocalizedError ? e.message : t("업데이트를 설치하지 못했습니다");
		}
	}
}

export const updater = new Updater();
