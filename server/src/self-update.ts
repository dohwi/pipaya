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
 *
 * What it trusts: the release tag is only a pointer, and a pointer is cheap to move (any push access, a workflow token).
 * The branch the releases are cut from is the protected one: nothing lands there without a reviewed, checked pull
 * request. So before any code is replaced, the commit the tag names must lie on that branch's history (`provenance`
 * below). A tag moved to a commit from anywhere else is refused, and the running version stays as it is.
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
	/** The version the release tag holds, or null when it could not be read (no update is offered without a newer version). */
	latestVersion: string | null;
	available: boolean;
	/** True when an update has been queued to apply automatically as soon as running sessions finish. */
	pending: boolean;
	/** Number of sessions currently mid-turn. */
	runningSessions: number;
	checkedAt: number;
}

export interface SelfUpdateStateEvent {
	phase: "idle" | "pending" | "updating" | "restarting" | "error";
	pending: boolean;
	runningSessions: number;
	toVersion?: string | null;
	code?: string;
	message?: string;
}

export interface ApplyOptions {
	force?: boolean;
	queue?: boolean;
}

export interface ApplyResult {
	from: string;
	to: string;
	fromVersion: string | null;
	toVersion: string | null;
	pending: boolean;
	runningSessions: number;
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
	/** Notified whenever the update state changes (queued, running count changed, applying, restarting, failed, cancelled). */
	onChange?: (event: SelfUpdateStateEvent) => void;
	/** Optional logger for background auto-apply failures. */
	log?: (message: string) => void;
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
/** How much of the release branch's history is fetched to find the release commit on it, before fetching all of it. */
const ANCESTRY_DEPTHS = [64, 512];
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

import { compareVersions } from "./shared/version.ts";
export { compareVersions };

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
	private cached: Omit<UpdateStatus, "pending" | "runningSessions"> | null = null;
	private applying = false;
	private queued = false;
	private queuedTarget: { from: string; to: string; fromVersion: string | null; toVersion: string | null } | null = null;
	private lastReportedRunning = -1;
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
	 * then `git show`. Distinguishes a fetch failure (`ok: false`, retried next time) from a commit whose version is missing
	 * or unreadable (`ok: true, version: null`, cached).
	 */
	private async readVersionAt(sha: string): Promise<{ ok: true; version: string | null } | { ok: false }> {
		if (this.versionAt.has(sha)) return { ok: true, version: this.versionAt.get(sha) ?? null };
		const fetched = await this.git(["fetch", "--quiet", "--depth", "1", "origin", sha], 120_000);
		if (fetched.code !== 0) return { ok: false };
		let found: string | null = null;
		const shown = await this.git(["show", `${sha}:server/package.json`]);
		if (shown.code === 0) {
			try {
				const v = (JSON.parse(shown.out) as { version?: unknown }).version;
				if (typeof v === "string" && VERSION_PATTERN.test(v)) found = v;
			} catch { /* not JSON: no version */ }
		}
		this.versionAt.set(sha, found);
		return { ok: true, version: found };
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

	/** The branch releases are cut from: the remote's default branch, or `PIPAYA_RELEASE_BRANCH` for a fork that releases from another. */
	private async releaseBranch(): Promise<string | null> {
		const wanted = this.env.PIPAYA_RELEASE_BRANCH?.trim();
		if (wanted) return REF_PATTERN.test(wanted) && !wanted.startsWith("-") ? wanted : null;
		const head = await this.git(["ls-remote", "--symref", "origin", "HEAD"], 30_000);
		const name = head.code === 0 ? /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(head.out)?.[1] : undefined;
		return name && REF_PATTERN.test(name) && !name.startsWith("-") ? name : null;
	}

	/**
	 * Whether `sha` lies on the history of the release branch. "unknown" when the remote could not be asked: the caller
	 * refuses then as well, since an update that cannot be checked is not applied.
	 *
	 * The checkout is shallow (install.sh clones one commit), so the branch's history is fetched in growing slices, and
	 * in full only when the commit was not found in them: a real release is a few commits behind the tip, and only a
	 * commit that is not on the branch at all costs the whole download.
	 */
	private async provenance(sha: string): Promise<"on_branch" | "off_branch" | "unknown"> {
		const branch = await this.releaseBranch();
		if (!branch) return "unknown";
		const tip = await this.git(["ls-remote", "origin", `refs/heads/${branch}`], 30_000);
		const head = tip.code === 0 ? tip.out.split("\n").find((l) => l.endsWith(`\trefs/heads/${branch}`))?.split("\t")[0] : undefined;
		if (!head || !SHA_PATTERN.test(head)) return "unknown";
		if (head === sha) return "on_branch";
		const reached = async () => (await this.git(["merge-base", "--is-ancestor", sha, head])).code === 0;
		for (const depth of ANCESTRY_DEPTHS) {
			if ((await this.git(["fetch", "--quiet", "--depth", String(depth), "origin", head], 300_000)).code !== 0) return "unknown";
			if (await reached()) return "on_branch";
		}
		// Not within the slices: only the whole history can tell "older than that" from "not on the branch".
		const shallow = await this.git(["rev-parse", "--is-shallow-repository"]);
		if (shallow.code === 0 && shallow.out.trim() === "true") {
			if ((await this.git(["fetch", "--quiet", "--unshallow", "origin"], 600_000)).code !== 0) return "unknown";
			if ((await this.git(["fetch", "--quiet", "origin", head], 300_000)).code !== 0) return "unknown";
			if (await reached()) return "on_branch";
		}
		return "off_branch";
	}

	get isPending(): boolean {
		return this.queued;
	}

	private runningCount(): number {
		return Math.max(0, this.o.running?.() ?? 0);
	}

	private withLive(base: Omit<UpdateStatus, "pending" | "runningSessions">): UpdateStatus {
		return { ...base, pending: this.queued, runningSessions: this.runningCount() };
	}

	private emit(event: SelfUpdateStateEvent): void {
		try {
			this.o.onChange?.(event);
		} catch {
			/* listener errors never break self-update */
		}
	}

	/** Cancels a queued update waiting for running sessions to finish. Returns true if one was queued. */
	cancelPending(): boolean {
		if (!this.queued) return false;
		this.queued = false;
		this.queuedTarget = null;
		this.lastReportedRunning = -1;
		this.emit({ phase: "idle", pending: false, runningSessions: this.runningCount() });
		return true;
	}

	/**
	 * Called whenever a session starts or finishes a turn. If an update is waiting for sessions to finish, either
	 * broadcasts the new running count or runs the update immediately once none remain.
	 */
	onActivityChange(): void {
		if (!this.queued || this.applying) return;
		const running = this.runningCount();
		if (running === 0) {
			void this.runQueued();
		} else if (running !== this.lastReportedRunning) {
			this.lastReportedRunning = running;
			this.emit({ phase: "pending", pending: true, runningSessions: running, toVersion: this.queuedTarget?.toVersion ?? null });
		}
	}

	private async runQueued(): Promise<void> {
		if (!this.queued || this.applying || this.runningCount() > 0) return;
		this.queued = false;
		this.queuedTarget = null;
		this.lastReportedRunning = -1;
		try {
			await this.apply({ force: false, queue: true });
		} catch (e) {
			const code = e instanceof HttpError ? e.code : "update_failed";
			const message = e instanceof Error ? e.message : String(e);
			this.o.log?.(`queued server update failed (${code}): ${message}`);
			this.emit({ phase: "error", pending: false, runningSessions: this.runningCount(), code, message });
		}
	}

	async status(refresh = false): Promise<UpdateStatus> {
		if (!refresh && this.cached && this.now() - this.cached.checkedAt < this.cacheMs) return this.withLive(this.cached);
		const checkedAt = this.now();
		const none = (reason: UnavailableReason, extra: Partial<Omit<UpdateStatus, "pending" | "runningSessions">> = {}): UpdateStatus => {
			this.cached = { managed: false, reason, ref: null, current: null, latest: null, currentVersion: this.runningVersion, latestVersion: null, available: false, checkedAt, ...extra };
			return this.withLive(this.cached);
		};

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
		if (latest === current) {
			this.cached = {
				managed: true,
				ref,
				current,
				latest,
				currentVersion: this.runningVersion,
				latestVersion: this.runningVersion,
				available: false,
				checkedAt,
			};
			return this.withLive(this.cached);
		}
		// Only offer an update when the release tag actually carries a newer version, matching the client updater.
		const read = await this.readVersionAt(latest);
		if (!read.ok) return none("fetch_failed", { ref, current, latest });
		const latestVersion = read.version;
		const cmp = compareVersions(latestVersion, this.runningVersion);
		const available = cmp !== null && cmp > 0;
		this.cached = { managed: true, ref, current, latest, currentVersion: this.runningVersion, latestVersion, available, checkedAt };
		return this.withLive(this.cached);
	}

	/**
	 * Moves to the newest commit and asks the process to restart. Throws HttpError with a reason the client can show.
	 * When `queue` is true and sessions are running, validates and fetches the release first, then queues the update
	 * to run automatically once all running sessions finish (returning `pending: true`).
	 */
	async apply(opts: boolean | ApplyOptions = false): Promise<ApplyResult> {
		const force = typeof opts === "boolean" ? opts : Boolean(opts.force);
		const queue = typeof opts === "boolean" ? false : Boolean(opts.queue);
		if (this.applying) throw new HttpError(409, "update_in_progress", "an update is already running");

		// Already waiting for sessions to finish: a repeat queued press is idempotent while sessions are still running.
		if (queue && !force && this.queued && this.queuedTarget) {
			const running = this.runningCount();
			if (running > 0) return { ...this.queuedTarget, pending: true, runningSessions: running };
		}

		this.applying = true;
		try {
			const st = await this.status(true);
			if (!st.managed || !st.current) {
				this.queued = false;
				this.queuedTarget = null;
				throw new HttpError(400, "update_unavailable", `this server cannot update itself (${st.reason ?? "unknown"})`);
			}
			if (!st.available || !st.latest) {
				this.queued = false;
				this.queuedTarget = null;
				throw new HttpError(409, "up_to_date", "the server is already up to date");
			}
			const busy = this.runningCount();
			if (busy > 0 && !force && !queue) {
				throw new HttpError(409, "sessions_running", `${busy} session(s) are running; a restart would interrupt them`);
			}

			// `reset --hard` below would silently discard edits made in this checkout: refuse before queuing or touching anything.
			const dirty = await this.git(["status", "--porcelain", "--untracked-files=no"]);
			if (dirty.code === 0 && dirty.out.length > 0) {
				this.queued = false;
				this.queuedTarget = null;
				throw new HttpError(409, "dirty_checkout", "the server's checkout has local changes; commit or discard them before updating");
			}

			const fetched = await this.git(["fetch", "--quiet", "--depth", "1", "origin", st.latest], 120_000);
			// The tag is only a pointer: the code it names must come from the protected release branch (see the top of this file).
			if (fetched.code === 0) {
				const origin = await this.provenance(st.latest);
				if (origin === "off_branch") {
					this.cached = null;
					this.queued = false;
					this.queuedTarget = null;
					throw new HttpError(409, "update_untrusted", "the release tag points at a commit that is not on the release branch; the update was refused");
				}
				if (origin === "unknown") {
					this.cached = null;
					this.queued = false;
					this.queuedTarget = null;
					throw new HttpError(502, "update_unverified", "the release could not be checked against the release branch; nothing was changed");
				}
			}

			// Re-check running sessions after network fetch/provenance: if they finished meanwhile, apply immediately.
			const busyAfter = this.runningCount();
			if (fetched.code === 0 && busyAfter > 0 && !force) {
				if (!queue) {
					throw new HttpError(409, "sessions_running", `${busyAfter} session(s) are running; a restart would interrupt them`);
				}
				const target = { from: st.current, to: st.latest, fromVersion: st.currentVersion, toVersion: st.latestVersion };
				this.queued = true;
				this.queuedTarget = target;
				this.lastReportedRunning = busyAfter;
				this.emit({ phase: "pending", pending: true, runningSessions: busyAfter, toVersion: st.latestVersion });
				return { ...target, pending: true, runningSessions: busyAfter };
			}

			this.queued = false;
			this.queuedTarget = null;
			this.lastReportedRunning = -1;
			this.emit({ phase: "updating", pending: false, runningSessions: busyAfter, toVersion: st.latestVersion });

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
			this.emit({ phase: "restarting", pending: false, runningSessions: 0, toVersion: st.latestVersion });
			this.o.restart?.();
			return { from: st.current, to: st.latest, fromVersion: st.currentVersion, toVersion: st.latestVersion, pending: false, runningSessions: 0 };
		} finally {
			this.applying = false;
		}
	}
}

/** Exit through the normal SIGTERM path (index.ts closes sockets first) a moment after the reply has been sent. */
export const restartSoon = () => {
	setTimeout(() => process.kill(process.pid, "SIGTERM"), 400).unref?.();
};
