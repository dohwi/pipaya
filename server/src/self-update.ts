import { existsSync } from "node:fs";
import { join } from "node:path";
import { HttpError } from "./errors.ts";
import { SERVER_VERSION } from "./version.ts";

/**
 * Lets a client update the server it is connected to: look up the commit of the rolling `latest` release tag (no download; the client release workflow moves it, so a plain merge to main is not an update), fetch and move the working tree to it,
 * reinstall dependencies only when `package.json`/`bun.lock` changed, then exit so the service manager (systemd `Restart=always`, launchd `KeepAlive`) starts the new code.
 * It does the same as `install.sh update`, minus the service restart that would kill the server in the middle of replying.
 *
 * Only offered when something will bring the process back: a systemd/launchd service (detected from the environment they set),
 * or `PIPAYA_SELF_UPDATE=1` for another supervisor (pm2, a container restart policy on a git checkout). `PIPAYA_SELF_UPDATE=0`
 * switches it off. A Docker image, a compiled binary and a manual `bun src/index.ts` have no way back, so they report why.
 */

export interface RunResult {
	code: number;
	out: string;
}
export type Run = (cmd: string[], cwd: string, timeoutMs: number) => Promise<RunResult>;

export type UnavailableReason = "disabled" | "unmanaged" | "not_git" | "detached" | "fetch_failed";

export interface UpdateStatus {
	/** The server can update itself and come back. */
	managed: boolean;
	reason?: UnavailableReason;
	/** The branch this checkout is on (the release commit is checked out onto it). */
	ref: string | null;
	/** Commit of the running checkout. For comparing and diagnostics only: people are shown the version. */
	current: string | null;
	/** Commit the release tag points at. */
	latest: string | null;
	/** The version this server runs (`1.2.3`), the one a person recognises. */
	currentVersion: string | null;
	/** The version the release tag holds, or null when it could not be read (the update is still offered, by commit). */
	latestVersion: string | null;
	available: boolean;
	checkedAt: number;
}

export interface SelfUpdateOptions {
	/** Repository root (the directory with `.git`). */
	root: string;
	/** `<root>/server`, where dependencies are installed. */
	serverDir: string;
	env?: Record<string, string | undefined>;
	run?: Run;
	/** Reinstall dependencies; true on success. Replaceable in tests. */
	install?: (serverDir: string) => Promise<boolean>;
	/** Ask the process to exit so the supervisor restarts it. */
	restart?: () => void;
	/** Sessions that are mid-turn right now: a restart would cut them off. */
	running?: () => number;
	/** How long a check is reused. */
	cacheMs?: number;
	now?: () => number;
	/** The version this server runs. Defaults to the one in server/package.json. */
	version?: string;
}

const DEFAULT_LAUNCHD_LABEL = "app.pipaya.server";
const REF_PATTERN = /^[A-Za-z0-9._/-]+$/;
/** The rolling release tag the client workflow moves on every version bump; the server follows the same release. A fork that publishes under another tag sets `PIPAYA_RELEASE_TAG`. */
const DEFAULT_RELEASE_TAG = "latest";
const TAG_PATTERN = /^[A-Za-z0-9._-]+$/;
const SHA_PATTERN = /^[0-9a-f]{7,64}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export const defaultRun: Run = async (cmd, cwd, timeoutMs) => {
	try {
		const proc = Bun.spawn(cmd, {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			timeout: timeoutMs,
			killSignal: "SIGKILL",
		});
		const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { code, out: (out + err).trim() };
	} catch (e) {
		return { code: 127, out: (e as Error).message };
	}
};

const defaultInstall = (run: Run) => async (serverDir: string) =>
	(await run([process.execPath, "install", "--frozen-lockfile", "--production", "--silent"], serverDir, 5 * 60_000)).code === 0;

export class SelfUpdater {
	private readonly env: Record<string, string | undefined>;
	private readonly run: Run;
	private readonly install: (serverDir: string) => Promise<boolean>;
	private readonly now: () => number;
	private readonly cacheMs: number;
	private cached: UpdateStatus | null = null;
	private applying = false;
	/** The version found at a release commit never changes, so each commit is read once. */
	private readonly versionAt = new Map<string, string | null>();

	constructor(private readonly o: SelfUpdateOptions) {
		this.env = o.env ?? process.env;
		this.run = o.run ?? defaultRun;
		this.install = o.install ?? defaultInstall(this.run);
		this.now = o.now ?? Date.now;
		this.cacheMs = o.cacheMs ?? 5 * 60_000;
	}

	private get runningVersion(): string {
		return this.o.version ?? SERVER_VERSION;
	}

	/**
	 * The `version` in server/package.json at `sha`, read without touching the working tree: one shallow fetch of that commit,
	 * then `git show`. Null when it cannot be read; the update is then offered by commit and shown without a version.
	 */
	private async readVersionAt(sha: string): Promise<string | null> {
		if (this.versionAt.has(sha)) return this.versionAt.get(sha) ?? null;
		let found: string | null = null;
		const fetched = await this.git(["fetch", "--quiet", "--depth", "1", "origin", sha], 120_000);
		if (fetched.code === 0) {
			const shown = await this.git(["show", `${sha}:server/package.json`]);
			if (shown.code === 0) {
				try {
					const v = (JSON.parse(shown.out) as { version?: unknown }).version;
					if (typeof v === "string" && VERSION_PATTERN.test(v)) found = v;
				} catch { /* not JSON: no version */ }
			}
		}
		if (fetched.code === 0) this.versionAt.set(sha, found); // a failed fetch is retried next time
		return found;
	}

	private get releaseTag(): string {
		const wanted = this.env.PIPAYA_RELEASE_TAG?.trim();
		return wanted && TAG_PATTERN.test(wanted) ? wanted : DEFAULT_RELEASE_TAG;
	}

	/** Why the server could not come back after an update, or null when it can. */
	private unmanagedReason(): UnavailableReason | null {
		const flag = this.env.PIPAYA_SELF_UPDATE;
		if (flag === "0") return "disabled";
		if (!existsSync(join(this.o.root, ".git"))) return "not_git";
		if (flag === "1") return null;
		const supervised = Boolean(this.env.INVOCATION_ID) || this.env.XPC_SERVICE_NAME === (this.env.PIPAYA_LAUNCHD_LABEL || DEFAULT_LAUNCHD_LABEL);
		return supervised ? null : "unmanaged";
	}

	private git(args: string[], timeoutMs = 30_000) {
		return this.run(["git", ...args], this.o.root, timeoutMs);
	}

	async status(refresh = false): Promise<UpdateStatus> {
		if (!refresh && this.cached && this.now() - this.cached.checkedAt < this.cacheMs) return this.cached;
		const checkedAt = this.now();
		const none = (reason: UnavailableReason, extra: Partial<UpdateStatus> = {}): UpdateStatus =>
			(this.cached = { managed: false, reason, ref: null, current: null, latest: null, currentVersion: this.runningVersion, latestVersion: null, available: false, checkedAt, ...extra });

		const reason = this.unmanagedReason();
		if (reason) return none(reason);

		const branch = await this.git(["symbolic-ref", "--short", "-q", "HEAD"]);
		const ref = branch.out.split("\n")[0]?.trim() ?? "";
		// A pinned tag or commit is a deliberate choice: do not move it.
		if (branch.code !== 0 || !REF_PATTERN.test(ref)) return none("detached");

		const head = await this.git(["rev-parse", "HEAD"]);
		const current = head.code === 0 && SHA_PATTERN.test(head.out) ? head.out : null;
		if (!current) return none("not_git", { ref });

		// Only asks the remote where the release tag points: nothing is downloaded until the update is applied.
		const tag = this.releaseTag;
		const remote = await this.git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`], 30_000);
		const tip = remote.code === 0 ? remote.out.split("\n").find((l) => l.endsWith(`\trefs/tags/${tag}`))?.split("\t")[0] : undefined;
		const latest = tip && SHA_PATTERN.test(tip) ? tip : null;
		if (!latest) return none("fetch_failed", { ref, current });
		const available = latest !== current;
		// Only worth a download when there is something new to name.
		const latestVersion = available ? await this.readVersionAt(latest) : this.runningVersion;
		return (this.cached = { managed: true, ref, current, latest, currentVersion: this.runningVersion, latestVersion, available, checkedAt });
	}

	/** Moves to the newest commit and asks the process to restart. Throws HttpError with a reason the client can show. */
	async apply(force = false): Promise<{ from: string; to: string; fromVersion: string | null; toVersion: string | null }> {
		if (this.applying) throw new HttpError(409, "update_in_progress", "an update is already running");
		this.applying = true;
		try {
			const st = await this.status(true);
			if (!st.managed || !st.current) {
				throw new HttpError(400, "update_unavailable", `this server cannot update itself (${st.reason ?? "unknown"})`);
			}
			if (!st.available || !st.latest) throw new HttpError(409, "up_to_date", "the server is already up to date");
			const busy = this.o.running?.() ?? 0;
			if (busy > 0 && !force) {
				throw new HttpError(409, "sessions_running", `${busy} session(s) are running; a restart would interrupt them`);
			}

			// `reset --hard` below would silently discard edits made in this checkout: refuse instead.
			const dirty = await this.git(["status", "--porcelain", "--untracked-files=no"]);
			if (dirty.code === 0 && dirty.out.length > 0) {
				throw new HttpError(409, "dirty_checkout", "the server's checkout has local changes; commit or discard them before updating");
			}

			const fetched = await this.git(["fetch", "--quiet", "--depth", "1", "origin", st.latest], 120_000);
			// Dependencies are reinstalled only when the manifest or lockfile differ between the two commits (unknown = reinstall).
			const diff = fetched.code === 0 ? await this.git(["diff", "--name-only", st.current, st.latest, "--", "server/package.json", "server/bun.lock"]) : null;
			const depsChanged = !diff || diff.code !== 0 || diff.out.length > 0;
			const moved = fetched.code === 0 ? await this.git(["reset", "--hard", "--quiet", st.latest]) : fetched;
			const ready =
				moved.code === 0 && existsSync(join(this.o.serverDir, "src", "index.ts")) && (!depsChanged || (await this.install(this.o.serverDir)));
			if (!ready) {
				// Leave the working tree as it was; a half-updated checkout would not start.
				const back = await this.git(["reset", "--hard", "--quiet", st.current]);
				const depsBack = !depsChanged || (await this.install(this.o.serverDir));
				this.cached = null;
				if (back.code !== 0 || !depsBack) {
					throw new HttpError(500, "update_restore_failed", "the update failed and the previous version could not be fully restored; check the server's checkout");
				}
				throw new HttpError(502, "update_failed", "the update could not be installed; the previous version was restored");
			}
			this.cached = null;
			this.o.restart?.();
			return { from: st.current, to: st.latest, fromVersion: st.currentVersion, toVersion: st.latestVersion };
		} finally {
			this.applying = false;
		}
	}
}

/** Exit through the normal SIGTERM path (index.ts closes sockets first) a moment after the reply has been sent. */
export const restartSoon = () => {
	setTimeout(() => process.kill(process.pid, "SIGTERM"), 400).unref?.();
};
