<script lang="ts">
	import { sessionTitle } from "../../lib/session-title";
	import EmptyState from "../ui/EmptyState.svelte";
	import Button from "../ui/Button.svelte";
	import { onMount } from "svelte";
	import ConfirmButton from "../ui/ConfirmButton.svelte";
	import { t } from "../../lib/i18n";
	import { Api, ApiError, errorText } from "../../lib/api";
	import { app } from "../../lib/store.svelte";
	import { fullTime, tilde } from "../../lib/format";
	import { livePast } from "../../lib/minute-clock.svelte";
	import { tailKeepLast } from "../../lib/fit-text";
	import type { Session } from "../../lib/types";
	import Badge from "../ui/Badge.svelte";
	import Handle from "../ui/Handle.svelte";
	import { peerLabel } from "../../lib/peers";
	import Icon from "../ui/Icon.svelte";
	import Notice from "../ui/Notice.svelte";
	import { collapseIn, collapseOut, reflow, rowIn, rowOut } from "../../lib/motion";

	let {
		serverId,
		cwd,
		count = $bindable(null),
		reload = $bindable(),
		busy = $bindable(false),
	}: {
		serverId: string;
		cwd?: string;
		/** how many chats are listed (null until loaded): the dialog shows it next to its title */
		count?: number | null;
		/** reloads the list: the dialog's refresh button calls it */
		reload?: () => void;
		busy?: boolean;
	} = $props();
	const server = $derived(app.servers.find((s) => s.id === serverId));
	const api = $derived(server ? new Api({ baseUrl: server.baseUrl, token: server.token }) : null);


	let sessions = $state<Session[] | null>(null);
	let home = $state<string | null>(null);
	let error = $state("");
	let picked = $state<Record<string, boolean>>({});
	let folded = $state<Record<string, boolean>>({});

	async function load() {
		if (!api) return;
		error = "";
		try {
			const [list, ws] = await Promise.all([api.allSessions(), api.workspace().catch(() => null)]);
			sessions = list;
			home = ws?.home ?? null;
			const alive = new Set(list.map((s) => s.id));
			picked = Object.fromEntries(Object.entries(picked).filter(([id]) => alive.has(id)));
		} catch (e) {
			error = errorText(e);
		}
	}
	onMount(() => void load());
	reload = () => void load();
	$effect(() => {
		count = sessions ? groups.reduce((n, g) => n + g.list.length, 0) : null;
	});

	/** A folder shows as `~/work/x` when it is under the server user's home. */
	const label = (cwd: string): string => tilde(cwd, home);

	const groups = $derived.by(() => {
		const map = new Map<string, Session[]>();
		for (const s of sessions ?? []) {
			if (cwd !== undefined && s.cwd !== cwd) continue;
			const list = map.get(s.cwd);
			if (list) list.push(s);
			else map.set(s.cwd, [s]);
		}
		return [...map.entries()]
			.map(([cwd, list]) => ({ cwd, list, updatedAt: list[0]?.updatedAt ?? 0 }))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	});
	/** Names the open chats answer to. A closed chat keeps its name now, but one closed before that may share it with an
	   open chat that took it meanwhile: that closed chat shows no handle, so the dialog never lists one `@name` twice. */
	const openNames = $derived(new Set((sessions ?? []).filter((s) => !s.closed && s.name).map((s) => s.name.toLowerCase())));
	const handleOf = (s: Session) => (s.closed && openNames.has(s.name.toLowerCase()) ? undefined : peerLabel(s));
	const nIn = (list: Session[]) => list.filter((s) => picked[s.id]).length;

	const allIn = (list: Session[]) => list.length > 0 && list.every((s) => picked[s.id]);
	const someIn = (list: Session[]) => list.some((s) => picked[s.id]) && !allIn(list);
	function toggleGroup(list: Session[]) {
		const on = !allIn(list);
		const next = { ...picked };
		for (const s of list) {
			if (on) next[s.id] = true;
			else delete next[s.id];
		}
		picked = next;
	}
	function toggleOne(id: string) {
		const next = { ...picked };
		if (next[id]) delete next[id];
		else next[id] = true;
		picked = next;
	}
	/** Run `act` over what is ticked in `list` and passes `keep`; then untick those, report with `done` and reload. */
	async function bulk(
		list: Session[],
		keep: (s: Session) => boolean,
		act: (ids: string[]) => Promise<string | { text: string; tone: "ok" | "warn" } | void>,
	) {
		const ids = list.filter((s) => picked[s.id] && keep(s)).map((s) => s.id);
		if (!api || !ids.length) return;
		busy = true;
		error = "";
		try {
			const result = await act(ids);
			if (typeof result === "string") app.toast(result, "ok");
			else if (result) app.toast(result.text, result.tone);
			const next = { ...picked };
			for (const id of ids) delete next[id];
			picked = next;
			await load();
		} catch (e) {
			if (e instanceof ApiError && e.status === 0) void app.links[serverId]?.probe();
			error = errorText(e);
		} finally {
			busy = false;
		}
	}
	const can = (list: Session[], keep: (s: Session) => boolean) => list.some((s) => picked[s.id] && keep(s));
	/** Reopen what was closed (the history stays on the server). */
	const canRestore = (s: Session) => s.closed;
	const canClose = (s: Session) => !s.closed;
	const any = () => true;

	const dropFromLink = (ids: string[]) => {
		const link = app.links[serverId];
		if (!link || !ids.length) return;
		const gone = new Set(ids);
		link.data.sessions = link.data.sessions.filter((x) => !gone.has(x.id));
		for (const id of gone) {
			link.data.running[id] = false;
			delete link.data.compacting[id];
			link.data.awaiting[id] = 0;
			delete link.data.unread[id];
			delete link.data.failed[id];
		}
	};

	/** Reopen what is ticked in one folder; the open ones are left as they are. */
	const restore = (list: Session[]) =>
		bulk(list, canRestore, async (ids) => {
			for (const id of ids) await api!.patchSession(id, { closed: false });
			return t("{n}개를 복원했습니다.", { n: ids.length });
		});
	/** Move what is ticked to the closed sessions (out of the list, still resumable). */
	const close = (list: Session[]) =>
		bulk(list, canClose, async (ids) => {
			for (const id of ids) await api!.patchSession(id, { closed: true });
			dropFromLink(ids);
			return t("{n}개를 닫았습니다.", { n: ids.length });
		});
	/** Delete what is ticked in one folder. Ticks in other folders stay untouched. */
	const remove = (list: Session[]) =>
		bulk(list, any, async (ids) => {
			let deleted = 0, skipped = 0;
			const gone: string[] = [];
			// the server takes up to 500 at a time
			for (let i = 0; i < ids.length; i += 500) {
				const r = await api!.deleteSessions(ids.slice(i, i + 500));
				deleted += r.deleted.length;
				skipped += r.skipped.length;
				gone.push(...r.deleted);
			}
			dropFromLink(gone);
			return skipped
				? { text: t("{n}개를 지웠습니다. {s}개는 실행 중이거나 답을 기다려 남겨 두었습니다.", { n: deleted, s: skipped }), tone: "warn" }
				: t("{n}개를 지웠습니다.", { n: deleted });
		});

</script>

<div class="sessions" data-part="sessions">
	{#if error}<Notice tone="danger">{error}</Notice>{/if}

	<section class="list">
		{#if !sessions && !error}
			<EmptyState loading tone="plain" as="p" />
		{:else if sessions && !groups.length}
			<EmptyState tone="dashed" as="p">{t("이 서버에는 대화가 없습니다")}</EmptyState>
		{:else if sessions}
			{#each groups as g (g.cwd)}
				<div class="group">
					<div class="gh">
						<input
							type="checkbox"
							checked={allIn(g.list)}
							indeterminate={someIn(g.list)}
							onchange={() => toggleGroup(g.list)}
							aria-label={t("{path}의 대화 모두 선택", { path: label(g.cwd) })}
						/>
						<button class="fold" onclick={() => (folded[g.cwd] = !folded[g.cwd])} aria-expanded={!folded[g.cwd]}>
							<Icon name={folded[g.cwd] ? "chevron-right" : "chevron-down"} />
							<Icon name="folder" />
							<span class="mono path" title={g.cwd} use:tailKeepLast={label(g.cwd)}></span>
							<span class="n">{g.list.length}</span>
						</button>
						{#if nIn(g.list)}
							<span class="del" in:collapseIn out:collapseOut>
								<Button size="sm" onclick={() => void restore(g.list)} disabled={busy || !can(g.list, canRestore)}><Icon name="undo" /> {t("복원")}</Button>
								<Button size="sm" onclick={() => void close(g.list)} disabled={busy || !can(g.list, canClose)}><Icon name="x" /> {t("대화 닫기")}</Button>
								<ConfirmButton size="sm" danger timeout={5000} confirmLabel={t("정말 {n}개 삭제", { n: nIn(g.list) })} onconfirm={() => void remove(g.list)} disabled={busy}><Icon name="trash" /> {t("{n}개 삭제", { n: nIn(g.list) })}</ConfirmButton>
							</span>
						{/if}
					</div>
					{#if !folded[g.cwd]}
						<ul in:collapseIn out:collapseOut>
							{#each g.list as s (s.id)}
								{@const who = handleOf(s)}
								<li class:on={picked[s.id]} animate:reflow in:rowIn out:rowOut>
									<label>
										<input type="checkbox" checked={!!picked[s.id]} onchange={() => toggleOne(s.id)} aria-label={s.title} />
										<span class="name" title={who?.title}>
											{#if who}<Handle text={who.text} />{/if}
											<span class="title">{s.title ? sessionTitle(s.title) : t("제목 없음")}</span>
										</span>
									</label>
									{#if s.closed}<Badge size="sm">{t("닫음")}</Badge>{/if}
									<span class="age" title={fullTime(s.updatedAt)}>{livePast(s.updatedAt, { time: false })}</span>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			{/each}
		{/if}
	</section>
</div>

<style>
	.sessions {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}
	.n {
		margin-left: 4px;
		font-size: var(--fs-xs);
		font-weight: 500;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}
	.list {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.group {
		/* a borderless tinted group (no box-in-box); a row sits 12px in, like the header, so every control lines up */
		background: var(--bg-set);
		border-radius: var(--radius-sm);
		padding: 4px 0;
		overflow: hidden;
	}
	/* the checkbox, folder name and the bulk buttons share one row that wraps: on a phone the buttons drop under the name
	   instead of covering it. Checkbox column x = 12 in the header and in every row below, so the ticks line up. */
	.gh {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 12px;
		padding: 8px 12px;
	}
	.fold {
		flex: 1 1 160px;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 0;
		background: none;
		border: 0;
		color: var(--text);
		font: inherit;
		font-size: var(--fs-sm);
		text-align: left;
		cursor: pointer;
	}
	.fold :global(svg) {
		flex: none;
		width: 15px;
		height: 15px;
		stroke-width: 1.8;
		color: var(--text-dim);
	}
	.path {
		flex: 1; /* the path takes the row, so every folder's count ends on one right line, whatever the path's length */
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	/* a whole-pixel line box (20px): the body's line-height 1.55 made every row 37.14px and the header 44.14, so the rows
	   drifted by 0.14px each. Row = 8 + 20 + 8 = 36 + the 1px hairline above it; header = 8 + 4 + 20 + 4 + 8 = 44. */
	.gh,
	li {
		line-height: 20px;
	}
	li {
		display: flex;
		align-items: center;
		gap: 12px;
		margin: 0 3px; /* 3 + 1 border + 8 padding = the header's 12px gutter */
		padding: 8px;
		border: 1px solid transparent; /* inactive rows keep the border's room, so selecting never shifts the layout */
		border-radius: var(--radius-xs);
	}
	li + li {
		margin-top: 1px;
	}
	/* Hairline Inset Fill: the selected row is the page colour with a 1px hairline */
	li.on {
		background: var(--bg-active);
		border-color: var(--border-strong);
	}
	li label {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 12px;
		cursor: pointer;
	}
	/* the `@name` handle before the title, as in the sidebar row (4px apart, centred on the title's line): the handle keeps
	   its width, the title gives way */
	.name {
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.title {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-sm);
	}
	.age {
		flex: none;
		font-size: var(--fs-xs);
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}
	/* the bulk buttons take their own row under the folder name and share it, left edge on the checkbox column and right edge on the
	   card's inner edge, at every width (a phone wraps the last one onto a second row) */
	.del {
		flex: 1 1 100%;
		min-width: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.del > :global(*) {
		flex: 1 1 auto;
		min-width: 0;
		justify-content: center;
	}
</style>
