<script lang="ts">
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

	let { serverId }: { serverId: string } = $props();
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
	let note = $state("");
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
			const list = map.get(s.cwd);
			if (list) list.push(s);
			else map.set(s.cwd, [s]);
		}
		return [...map.entries()]
			.map(([cwd, list]) => ({ cwd, list, updatedAt: list[0]?.updatedAt ?? 0 }))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	});
	const chosen = $derived(Object.keys(picked).filter((id) => picked[id]));
	const nChosen = $derived(chosen.length);

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
	async function remove() {
		if (!api || !nChosen) return;
		busy = true;
		error = "";
		note = "";
		try {
			const ids = [...chosen];
			let deleted = 0, skipped = 0;
			// the server takes up to 500 at a time
			for (let i = 0; i < ids.length; i += 500) {
				const r = await api.deleteSessions(ids.slice(i, i + 500));
				deleted += r.deleted.length;
				skipped += r.skipped.length;
			}
			note = skipped ? t("{n}개를 지웠습니다. {s}개는 실행 중이거나 답을 기다려 남겨 두었습니다.", { n: deleted, s: skipped }) : t("{n}개를 지웠습니다.", { n: deleted });
			picked = {};
			await load();
		} catch (e) {
			error = errorText(e);
		} finally {
			busy = false;
		}
	}

</script>

<div class="sessions">
	{#if error}<Notice tone="danger">{error}</Notice>{/if}
	{#if note}<Notice tone="info">{note}</Notice>{/if}

	<section class="list" aria-labelledby="list-h">
		<div class="row head">
			<div class="grow">
				<div id="list-h" class="label">{t("대화 목록")}{#if sessions} <span class="n">{sessions.length}</span>{/if}</div>
			</div>
			<button class="btn sm" onclick={() => void load()} disabled={busy}>{t("새로고침")}</button>
		</div>

		{#if !sessions && !error}
			<p class="hint">{t("불러오는 중…")}</p>
		{:else if sessions && !sessions.length}
			<p class="empty">{t("이 서버에는 대화가 없습니다")}</p>
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
					</div>
					{#if !folded[g.cwd]}
						<ul in:collapseIn out:collapseOut>
							{#each g.list as s (s.id)}
								<li class:on={picked[s.id]} animate:reflow in:rowIn out:rowOut>
									<label>
										<input type="checkbox" checked={!!picked[s.id]} onchange={() => toggleOne(s.id)} aria-label={s.title} />
										<span class="title">{s.title || t("제목 없음")}</span>
									</label>
									{#if s.closed}<Badge size="sm">{t("닫음")}</Badge>{/if}
									<span class="age" title={new Date(s.updatedAt).toLocaleString()}>{ageOf(s.updatedAt)}</span>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			{/each}
		{/if}
	</section>

	{#if nChosen}
		<div class="bar" in:collapseIn out:collapseOut>
			<span>{t("{n}개 선택됨", { n: nChosen })}</span>
			<button class="btn sm" onclick={() => (picked = {})} disabled={busy}>{t("선택 해제")}</button>
			<ConfirmButton size="sm" danger timeout={5000} confirmLabel={t("정말 {n}개 삭제", { n: nChosen })} onconfirm={() => void remove()} disabled={busy}><Icon name="trash" /> {t("삭제")}</ConfirmButton>
		</div>
	{/if}
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
	.label {
		font-size: var(--fs-sm);
		font-weight: 650;
	}
	.hint {
		margin: 4px 0 0;
		font-size: var(--fs-xs);
		line-height: 1.5;
		color: var(--text-faint);
	}
	.n {
		margin-left: 4px;
		font-size: var(--fs-xs);
		font-weight: 500;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}
	.empty {
		margin: 4px 0;
		padding: 18px;
		border: 1px dashed var(--border);
		border-radius: var(--radius);
		color: var(--text-faint);
		font-size: var(--fs-sm);
		text-align: center;
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
		stroke: currentColor;
		fill: none;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
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
	.bar {
		position: sticky;
		bottom: 0;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 12px;
		background: var(--bg-elev);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-panel);
		box-shadow: var(--shadow-soft);
		font-size: var(--fs-sm);
	}
	.bar span {
		flex: 1;
	}
</style>
