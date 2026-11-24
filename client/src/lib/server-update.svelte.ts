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
type Phase = "idle" | "checking" | "pending" | "updating" | "restarting" | "error";

export interface ServerUpdateEvent {
	phase?: Phase;
	pending?: boolean;
	runningSessions?: number;
	toVersion?: string | null;
	code?: string;
	message?: string;
}

export type ServerUpdateOutcome = "updated" | "pending" | "failed";

const WITH_APP = "pipaya.update.withServer"; // "0": do not offer the server together with an app update
const RECHECK_MS = 30 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class ServerUpdater {
	status = $state<ServerUpdateStatus | null>(null);
	/** The version the last update moved the server to, when the server named it. */
	updatedTo = $state("");
	phase = $state<Phase>("idle");
	error = $state("");
	/** The last update was refused by an older server because conversations are running: offer to stop them and go on. */
	blockedByRuns = $state(false);
	/** Running sessions the queued update is currently waiting on. */
	runningSessions = $state(0);
	/** Update the server whenever the app is updated (the checkbox in the update dialog). */
	withApp = $state(localStorage.getItem(WITH_APP) !== "0");
	private checkedFor = "";
	private checkedAt = 0;
	private restartingPromise: Promise<boolean> | null = null;
	private applyingDirect = false;
	/** Bumped on reset() so an in-flight waitForRestart from the previous server ignores its own completion. */
	private gen = 0;

	/** A newer server build exists and this server can install it by itself. */
	get available(): boolean {
		return Boolean(this.status?.managed && this.status.available);
	}
	get pending(): boolean {
		return this.phase === "pending";
	}
	get busy(): boolean {
		return this.phase === "checking" || this.phase === "updating" || this.phase === "restarting";
	}
	/** What the server is doing right now, in words; "" when it is idle. The one wording for every place that shows it. */
	get progressLabel(): string {
		if (this.phase === "pending") {
			return this.runningSessions > 0
				? t("대화 {n}개 종료 대기 중…", { n: this.runningSessions })
				: t("대화 종료 대기 중…");
		}
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
		this.gen++;
		this.status = null;
		this.updatedTo = "";
		this.phase = "idle";
		this.error = "";
		this.blockedByRuns = false;
		this.runningSessions = 0;
		this.checkedFor = "";
		this.restartingPromise = null;
	}

	/** Background check after connecting (throttled per server); `manual` shows failures. */
	async check(api: Api, serverId: string, manual = false): Promise<void> {
		if (this.busy) return;
		if (!manual && this.checkedFor === serverId && Date.now() - this.checkedAt < RECHECK_MS) return;
		const g = this.gen;
		this.checkedFor = serverId;
		this.checkedAt = Date.now();
		this.error = "";
		const wasPending = this.phase === "pending";
		this.phase = "checking";
		try {
			const st = await api.serverUpdateStatus();
			if (g !== this.gen) return;
			this.status = st;
			if (st.pending) {
				this.phase = "pending";
				this.runningSessions = st.runningSessions ?? 0;
				this.updatedTo = st.latestVersion ?? "";
				this.blockedByRuns = false;
			} else {
				this.phase = "idle";
				this.runningSessions = 0;
			}
		} catch (e) {
			if (g !== this.gen) return;
			this.status = null;
			const unsupported = e instanceof ApiError && (e.status === 403 || e.status === 404);
			if (manual && !unsupported) {
				this.phase = "error";
				this.error = e instanceof LocalizedError ? e.message : t("서버 업데이트를 확인하지 못했습니다");
			} else {
				this.phase = wasPending ? "pending" : "idle";
			}
		}
	}

	/**
	 * Install the update and wait for the server to come back.
	 * When conversations are running and `force` is false on a server that supports queuing, queues the update instead of
	 * failing and returns `"pending"` so it runs automatically as soon as those conversations finish.
	 */
	async apply(api: Api, force = false): Promise<ServerUpdateOutcome> {
		if (this.busy || !this.available) return "failed";
		const g = this.gen;
		const supportsQueue = typeof this.status?.pending === "boolean";
		this.error = "";
		this.blockedByRuns = false;
		this.phase = "updating";
		this.updatedTo = "";
		this.applyingDirect = true;
		let res: Awaited<ReturnType<Api["updateServer"]>>;
		try {
			res = await api.updateServer(force ? { force: true } : supportsQueue ? { force: false, queue: true } : { force: false });
		} catch (e) {
			this.applyingDirect = false;
			if (g !== this.gen) return "failed";
			this.phase = "error";
			this.error = failureText(e);
			this.blockedByRuns = e instanceof ApiError && e.code === "sessions_running";
			return "failed";
		}
		this.applyingDirect = false;
		if (g !== this.gen) return "failed";
		this.updatedTo = res.toVersion ?? "";
		if (res.pending && !res.restarting) {
			this.phase = "pending";
			this.runningSessions = res.runningSessions ?? 1;
			return "pending";
		}
		return (await this.awaitRestart(api, g)) ? "updated" : "failed";
	}

	/** Cancel a queued server update. */
	async cancel(api: Api): Promise<boolean> {
		if (this.phase !== "pending") return false;
		const g = this.gen;
		this.error = "";
		try {
			await api.cancelServerUpdate();
			if (g !== this.gen) return false;
			this.phase = "idle";
			this.runningSessions = 0;
			return true;
		} catch (e) {
			if (g !== this.gen) return false;
			this.error = failureText(e);
			return false;
		}
	}

	/** Live state updates from the server's SSE `server_update_changed` event. */
	onServerEvent(ev: ServerUpdateEvent, api: Api | null, onUpdated: () => void): void {
		if (!ev || typeof ev.phase !== "string") return;
		if (ev.toVersion) this.updatedTo = ev.toVersion;
		if (ev.phase === "pending") {
			this.phase = "pending";
			this.runningSessions = typeof ev.runningSessions === "number" ? ev.runningSessions : this.runningSessions;
			this.error = "";
			this.blockedByRuns = false;
			return;
		}
		if (ev.phase === "updating") {
			this.phase = "updating";
			this.runningSessions = 0;
			this.error = "";
			this.blockedByRuns = false;
			return;
		}
		if (ev.phase === "restarting") {
			this.runningSessions = 0;
			this.error = "";
			this.blockedByRuns = false;
			if (api && !this.applyingDirect && !this.restartingPromise) {
				const g = this.gen;
				void this.awaitRestart(api, g).then((ok) => {
					if (ok && g === this.gen) onUpdated();
				});
			} else {
				this.phase = "restarting";
			}
			return;
		}
		if (ev.phase === "idle") {
			if (this.phase === "pending") this.phase = "idle";
			this.runningSessions = 0;
			return;
		}
		if (ev.phase === "error") {
			this.phase = "error";
			this.runningSessions = 0;
			this.error = failureTextByCode(ev.code);
		}
	}

	private awaitRestart(api: Api, g: number): Promise<boolean> {
		if (this.restartingPromise) return this.restartingPromise;
		this.phase = "restarting";
		const p = (async () => {
			const back = await waitForRestart(api);
			if (g !== this.gen) return false;
			this.status = null;
			this.checkedAt = 0;
			this.runningSessions = 0;
			if (!back) {
				this.phase = "error";
				this.error = t("서버가 다시 시작되지 않았습니다. 서버를 직접 확인해 주세요");
				return false;
			}
			this.phase = "idle";
			return true;
		})();
		this.restartingPromise = p;
		void p.finally(() => {
			if (this.restartingPromise === p) this.restartingPromise = null;
		});
		return p;
	}
}

function failureTextByCode(code?: string, status?: number): string {
	if (code === "sessions_running") return t("실행 중인 대화가 있어 업데이트하지 않았습니다. 대화가 끝난 뒤 다시 누르거나, 중지하고 업데이트하세요");
	if (code === "up_to_date") return t("서버가 이미 최신 버전입니다");
	if (code === "update_failed") return t("서버를 업데이트하지 못해 이전 버전으로 되돌렸습니다");
	if (code === "update_restore_failed") return t("서버를 업데이트하지 못했고 이전 버전도 완전히 복원하지 못했습니다. 서버의 체크아웃을 확인하세요");
	if (code === "dirty_checkout") return t("서버의 체크아웃에 로컬 변경이 있어 업데이트할 수 없습니다");
	if (code === "update_untrusted") return t("릴리스가 가리키는 코드가 릴리스 브랜치에 없어 업데이트를 거부했습니다. 서버는 그대로입니다");
	if (code === "update_unverified") return t("릴리스의 출처를 확인하지 못해 업데이트하지 않았습니다. 잠시 뒤 다시 시도하세요");
	if (code === "update_unavailable") return t("이 서버는 스스로 업데이트할 수 없습니다");
	if (status === 403) return t("서버 관리자 토큰으로 연결해야 업데이트할 수 있습니다");
	return t("서버를 업데이트하지 못했습니다");
}

function failureText(e: unknown): string {
	if (e instanceof ApiError) return failureTextByCode(e.code, e.status);
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
