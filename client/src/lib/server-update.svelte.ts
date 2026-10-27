import { ApiError, type Api } from "./api";
import { LocalizedError, t } from "./i18n";
import type { ServerUpdateStatus } from "./protocol";

/**
 * Updating the server the app is connected to. The server does the work (git fetch, install, restart, see
 * server/src/self-update.ts); this class asks, shows the state, and waits for it to come back.
 *
 * Only the owner (admin token) may do it: a paired device gets 403 and a server from before this feature gets 404. Both
 * simply mean "nothing to offer", so a background check never shows an error.
 */
type Phase = "idle" | "checking" | "updating" | "restarting" | "error";

const WITH_APP = "pipaya.update.withServer"; // "0": do not offer the server together with an app update
const RECHECK_MS = 30 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class ServerUpdater {
	status = $state<ServerUpdateStatus | null>(null);
	phase = $state<Phase>("idle");
	error = $state("");
	/** Update the server whenever the app is updated (the checkbox in the update dialog). */
	withApp = $state(localStorage.getItem(WITH_APP) !== "0");
	private checkedFor = "";
	private checkedAt = 0;

	/** A newer server build exists and this server can install it by itself. */
	get available(): boolean {
		return Boolean(this.status?.managed && this.status.available);
	}
	get busy(): boolean {
		return this.phase === "checking" || this.phase === "updating" || this.phase === "restarting";
	}
	/** What the server is doing right now, in words; "" when it is not being updated. The one wording for every place that shows it. */
	get progressLabel(): string {
		if (this.phase === "updating") return t("서버를 업데이트하는 중…");
		if (this.phase === "restarting") return t("서버가 다시 시작되기를 기다리는 중…");
		return "";
	}

	setWithApp(on: boolean) {
		this.withApp = on;
		localStorage.setItem(WITH_APP, on ? "1" : "0");
	}

	/** Forget everything about the previous server. */
	reset() {
		this.status = null;
		this.phase = "idle";
		this.error = "";
		this.checkedFor = "";
	}

	/** Background check after connecting (throttled per server); `manual` shows failures. */
	async check(api: Api, serverId: string, manual = false): Promise<void> {
		if (this.busy) return;
		if (!manual && this.checkedFor === serverId && Date.now() - this.checkedAt < RECHECK_MS) return;
		this.checkedFor = serverId;
		this.checkedAt = Date.now();
		this.error = "";
		this.phase = "checking";
		try {
			this.status = await api.serverUpdateStatus();
			this.phase = "idle";
		} catch (e) {
			this.status = null;
			const unsupported = e instanceof ApiError && (e.status === 403 || e.status === 404);
			if (manual && !unsupported) {
				this.phase = "error";
				this.error = e instanceof LocalizedError ? e.message : t("서버 업데이트를 확인하지 못했습니다");
			} else this.phase = "idle";
		}
	}

	/**
	 * Install the update and wait for the server to come back. Returns true when it is running again.
	 * `force` restarts even though a conversation is mid-turn (it would be cut off).
	 */
	async apply(api: Api, force = false): Promise<boolean> {
		if (this.busy || !this.available) return false;
		this.error = "";
		this.phase = "updating";
		try {
			await api.updateServer(force);
		} catch (e) {
			this.phase = "error";
			this.error = failureText(e);
			return false;
		}
		this.phase = "restarting";
		const back = await waitForRestart(api);
		this.status = null;
		this.checkedAt = 0;
		if (!back) {
			this.phase = "error";
			this.error = t("서버가 다시 시작되지 않았습니다. 서버를 직접 확인해 주세요");
			return false;
		}
		this.phase = "idle";
		return true;
	}
}

function failureText(e: unknown): string {
	if (e instanceof ApiError) {
		if (e.code === "sessions_running") return t("실행 중인 대화가 있어 서버를 다시 시작하면 중단됩니다");
		if (e.code === "up_to_date") return t("서버가 이미 최신 버전입니다");
		if (e.code === "update_failed") return t("서버를 업데이트하지 못해 이전 버전으로 되돌렸습니다");
		if (e.code === "update_restore_failed") return t("서버를 업데이트하지 못했고 이전 버전도 완전히 복원하지 못했습니다. 서버의 체크아웃을 확인하세요");
		if (e.code === "dirty_checkout") return t("서버의 체크아웃에 로컬 변경이 있어 업데이트할 수 없습니다");
		if (e.code === "update_unavailable") return t("이 서버는 스스로 업데이트할 수 없습니다");
		if (e.status === 403) return t("서버 관리자 토큰으로 연결해야 업데이트할 수 있습니다");
	}
	return t("서버를 업데이트하지 못했습니다");
}

/**
 * The server exits a moment after replying and its service manager starts it again. Wait until it has gone away and
 * answered again; if the drop is never seen (it came back faster than we asked) accept the first answer after a few seconds.
 */
async function waitForRestart(api: Api, timeoutMs = 90_000): Promise<boolean> {
	const start = Date.now();
	let sawDown = false;
	while (Date.now() - start < timeoutMs) {
		await sleep(800);
		try {
			await api.health(AbortSignal.timeout(3000));
			if (sawDown || Date.now() - start > 6000) return true;
		} catch {
			sawDown = true;
		}
	}
	return false;
}

export const serverUpdater = new ServerUpdater();
