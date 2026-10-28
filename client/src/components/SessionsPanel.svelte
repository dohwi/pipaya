<script lang="ts">
	import EmptyState from "./EmptyState.svelte";
	import Button from "./Button.svelte";
	import { onMount } from "svelte";
	import ConfirmButton from "./ConfirmButton.svelte";
	import { t } from "../lib/i18n";
	import { Api, errorText } from "../lib/api";
	import { app } from "../lib/store.svelte";
	import { tilde } from "../lib/format";
	import type { Session } from "../lib/types";
	import Badge from "./Badge.svelte";
	import Icon from "./Icon.svelte";
	import Notice from "./Notice.svelte";
	import { collapseIn, collapseOut, reflow, rowIn, rowOut } from "../lib/motion";

	let { serverId, cwd, archivedOnly = false }: { serverId: string; cwd?: string; archivedOnly?: boolean } = $props();
	const server = $derived(app.servers.find((s) => s.id === serverId));
	const api = $derived(server ? new Api({ baseUrl: server.baseUrl, token: server.token }) : null);

	const PAGE = 200;
	const DAY = 24 * 3600_000;

	let sessions = $state<Session[] | null>(null);
	let home = $state<string | null>(null);
	let error = $state("");
	let busy = $state(false);
	let picked = $state<Record<string, boolean>>({});
	let folded = $state<Record<string, boolean>>({});
	let now = $state(Date.now());

	/** Every session of the server, newest first. The list is paged, so keep asking until it ends. */
	async function loadAll(a: Api): Promise<Session[]> {
		const all: Session[] = [];
		let before: number | undefined;
		for (let i = 0; i < 100; i++) {
			const page = await a.listSessionsPage(PAGE, before);
			all.push(...page.sessions);
			if (page.nextBefore === null) break;
			before = page.nextBefore;
		}
		return all;
	}

	async function load() {
		if (!api) return;
		error = "";
		try {
			const [list, ws] = await Promise.all([loadAll(api), api.workspace().catch(() => null)]);
			sessions = list;
			home = ws?.home ?? null;
			now = Date.now();
			const alive = new Set(list.map((s) => s.id));
			picked = Object.fromEntries(Object.entries(picked).filter(([id]) => alive.has(id)));
		} catch (e) {
			error = errorText(e);
		}
	}
	onMount(() => void load());

	/** A folder shows as `~/work/x` when it is under the server user's home. */
	const label = (cwd: string): string => tilde(cwd, home);

	const groups = $derived.by(() => {
		const map = new Map<string, Session[]>();
		for (const s of sessions ?? []) {
			if (cwd !== undefined && s.cwd !== cwd) continue;
			if (archivedOnly && (!s.archived || s.closed)) continue;
			const list = map.get(s.cwd);
			if (list) list.push(s);
			else map.set(s.cwd, [s]);
		}
		return [...map.entries()]
			.map(([cwd, list]) => ({ cwd, list, updatedAt: list[0]?.updatedAt ?? 0 }))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	});
	const nIn = (list: Session[]) => list.filter((s) => picked[s.id]).length;

	function ageOf(ts: number): string {
		const d = Math.floor((now - ts) / DAY);
		if (d <= 0) return t("오늘");
		if (d < 60) return t("{n}일 전", { n: d });
		const m = Math.floor(d / 30);
		return m < 12 ? t("{n}개월 전", { n: m }) : t("{n}년 전", { n: Math.floor(d / 365) });
	}

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
	async function bulk(list: Session[], keep: (s: Session) => boolean, act: (ids: string[]) => Promise<string | void>) {
		const ids = list.filter((s) => picked[s.id] && keep(s)).map((s) => s.id);
		if (!api || !ids.length) return;
		busy = true;
		error = "";
		try {
			const msg = await act(ids);
			if (msg) app.toast(msg);
			const next = { ...picked };
			for (const id of ids) delete next[id];
			picked = next;
			await load();
		} catch (e) {
			error = errorText(e);
		} finally {
			busy = false;
		}
	}
	const can = (list: Session[], keep: (s: Session) => boolean) => list.some((s) => picked[s.id] && keep(s));
	const canArchive = (s: Session) => !s.closed && !s.archived;
	const canRestore = (s: Session) => !!s.archived && !s.closed;
	const canClose = (s: Session) => !s.closed;
	const any = () => true;

	/** Archive (or, with `on` false, restore) what is ticked in one folder; closed ones are left as they are. */
	const archive = (list: Session[], on: boolean) =>
		bulk(list, on ? canArchive : canRestore, async (ids) => {
			for (const id of ids) await api!.patchSession(id, { archived: on });
			return on ? t("{n}개를 보관했습니다.", { n: ids.length }) : t("{n}개를 복원했습니다.", { n: ids.length });
		});
	/** Move what is ticked to the closed sessions (out of the list and the archive, still resumable). */
	const close = (list: Session[]) =>
		bulk(list, canClose, async (ids) => {
			for (const id of ids) await api!.patchSession(id, { closed: true, archived: false });
			return t("{n}개를 닫았습니다.", { n: ids.length });
		});
	/** Delete what is ticked in one folder. Ticks in other folders stay untouched. */
	const remove = (list: Session[]) =>
		bulk(list, any, async (ids) => {
			let deleted = 0, skipped = 0;
			// the server takes up to 500 at a time
			for (let i = 0; i < ids.length; i += 500) {
				const r = await api!.deleteSessions(ids.slice(i, i + 500));
				deleted += r.deleted.length;
				skipped += r.skipped.length;
			}
			return skipped ? t("{n}개를 지웠습니다. {s}개는 실행 중이거나 답을 기다려 남겨 두었습니다.", { n: deleted, s: skipped }) : t("{n}개를 지웠습니다.", { n: deleted });
		});

</script>

<div class="sessions" data-part="sessions">
	{#if error}<Notice tone="danger">{error}</Notice>{/if}

	<section class="list" aria-labelledby="list-h">
		<div class="row head">
			<div class="grow">
				<div id="list-h" class="section-label">{t("대화 목록")}{#if sessions} <span class="n">{groups.reduce((n, g) => n + g.list.length, 0)}</span>{/if}</div>
			</div>
			<Button size="sm" onclick={() => void load()} disabled={busy}>{t("새로고침")}</Button>
		</div>

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
							<span class="mono path" title={g.cwd}>{label(g.cwd)}</span>
							<span class="n">{g.list.length}</span>
						</button>
						{#if nIn(g.list)}
							<span class="del" in:collapseIn out:collapseOut>
								<Button size="sm" onclick={() => void close(g.list)} disabled={busy || !can(g.list, canClose)}><Icon name="x" /> {t("닫기")}</Button>
								{#if !archivedOnly}<Button size="sm" onclick={() => void archive(g.list, true)} disabled={busy || !can(g.list, canArchive)}><Icon name="archive" /> {t("보관")}</Button>{/if}
								<Button size="sm" onclick={() => void archive(g.list, false)} disabled={busy || !can(g.list, canRestore)}><Icon name="undo" /> {t("복원")}</Button>
								<ConfirmButton size="sm" danger timeout={5000} confirmLabel={t("정말 {n}개 삭제", { n: nIn(g.list) })} onconfirm={() => void remove(g.list)} disabled={busy}><Icon name="trash" /> {t("{n}개 삭제", { n: nIn(g.list) })}</ConfirmButton>
							</span>
						{/if}
					</div>
					{#if !folded[g.cwd]}
						<ul in:collapseIn out:collapseOut>
							{#each g.list as s (s.id)}
								<li class:on={picked[s.id]} animate:reflow in:rowIn out:rowOut>
									<label>
										<input type="checkbox" checked={!!picked[s.id]} onchange={() => toggleOne(s.id)} aria-label={s.title} />
										<span class="title">{s.title || t("제목 없음")}</span>
									</label>
									{#if s.closed}<Badge size="sm">{t("닫음")}</Badge>{:else if s.archived}<Badge size="sm">{t("보관됨")}</Badge>{/if}
									<span class="age" title={new Date(s.updatedAt).toLocaleString()}>{ageOf(s.updatedAt)}</span>
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
	.row {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.grow {
		flex: 1;
		min-width: 0;
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
		gap: 10px;
	}
	.group {
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		overflow: hidden;
	}
	.gh {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 12px;
		background: var(--bg-elev);
	}
	.fold {
		flex: 1;
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
	li {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 12px 8px 14px;
		border-top: 1px solid var(--border);
	}
	li.on {
		background: var(--accent-soft);
	}
	li label {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 10px;
		cursor: pointer;
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
	.del {
		flex: none;
		display: flex;
		gap: 6px;
	}
</style>
