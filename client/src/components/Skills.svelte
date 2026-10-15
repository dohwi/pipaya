<script lang="ts">
	import Notice from "./Notice.svelte";
	import Badge from "./Badge.svelte";
	import Switch from "./Switch.svelte";
	import { t } from "../lib/i18n";
	import { holdClosing } from "../lib/motion";
	import { sheetPull } from "../lib/sheet";
	import { untrack } from "svelte";
	import { errorText, type Api, type ApiError } from "../lib/api";
	import { app } from "../lib/store.svelte";
	import type { SessionContext, SkillInfo, SkillList } from "../lib/types";
	import Icon from "./Icon.svelte";
	import { nativeModal } from "../lib/dialog";

	let { dialog: target, api, onclose }: { dialog: { cwd: string; sessionId: string | null }; api: Api; onclose: () => void } = $props();

	type Mode = "project" | "global";
	let data = $state<SkillList | null>(null);
	let session = $state<SessionContext | null>(null);
	let loading = $state(true);
	let error = $state("");
	let refresh = $state(0);
	let query = $state("");
	let saving = $state<Record<string, boolean>>({});

	// Re-read on manual refresh and whenever any client changes a skill (skills_updated).
	// Cleanup aborts obsolete requests on refresh, server switch or close.
	$effect(() => {
		refresh;
		app.skillsTick;
		const controller = new AbortController();
		const { cwd, sessionId } = target;
		untrack(() => { if (!data) loading = true; error = ""; });
		void Promise.all([
			api.skills(cwd, controller.signal, sessionId),
			sessionId ? api.sessionContext(sessionId, controller.signal).catch(() => null) : null,
		]).then(([list, ctx]) => {
			if (controller.signal.aborted) return;
			data = list;
			session = ctx;
		}).catch(e => {
			if (controller.signal.aborted) return;
			error = (e as ApiError)?.status === 404 && /route/i.test((e as Error).message)
				? t("서버가 스킬 기능을 지원하지 않습니다. 서버를 최신 버전으로 재시작한 뒤 다시 시도하세요.")
				: errorText(e);
		}).finally(() => { if (!controller.signal.aborted) loading = false; });
		return () => controller.abort();
	});

	const shown = $derived(
		(data?.skills ?? []).filter(s => {
			const q = query.trim().toLowerCase();
			return !q || s.name.includes(q) || s.description.toLowerCase().includes(q);
		}),
	);
	const projectEnabled = (s: SkillInfo) => s.override ?? s.globalEnabled;
	const effective = (s: SkillInfo, mode: Mode) => (mode === "project" ? projectEnabled(s) : s.globalEnabled);
	const onCount = $derived((data?.skills ?? []).filter(s => s.enabled && s.modelInvocable).length);
	const used = $derived(new Set(session?.skills.map(s => s.name)));

	async function toggle(s: SkillInfo, next: boolean, mode: Mode) {
		const key = mode + s.name;
		if (saving[key]) return;
		saving[key] = true;
		error = "";
		try {
			// Project mode: matching the inherited value drops the override instead of pinning it.
			const sessionId = target.sessionId ?? undefined;
			data = mode === "global"
				? await api.setSkill(s.name, { scope: "global", enabled: next, cwd: target.cwd, sessionId })
				: await api.setSkill(s.name, { scope: "project", enabled: next === s.globalEnabled ? null : next, cwd: target.cwd, sessionId });
		} catch (e) {
			error = errorText(e);
		} finally {
			delete saving[key];
			app.skillsTick++;
		}
	}

	async function reset(s: SkillInfo) {
		const key = "project" + s.name;
		if (saving[key]) return;
		saving[key] = true;
		try {
			const sessionId = target.sessionId ?? undefined;
			data = await api.setSkill(s.name, { scope: "project", enabled: null, cwd: target.cwd, sessionId });
		} catch (e) {
			error = errorText(e);
		} finally {
			delete saving[key];
			app.skillsTick++;
		}
	}

	const home = (p: string) => p.replace(/^\/home\/[^/]+/, "~");
</script>

{#snippet list(mode: Mode)}
	<ul class="list">
		{#each shown as s (s.name)}
{@const on = effective(s, mode)}
<li class="item" class:off={!on || !s.modelInvocable}>
	<span class="switch" title={s.modelInvocable ? undefined : t("자동 호출에서 제외된 스킬(disable-model-invocation)이라 켜고 끌 수 없어요")}>
		<Switch
			checked={on && s.modelInvocable}
			disabled={!s.modelInvocable || saving[mode + s.name]}
			onchange={next => toggle(s, next, mode)}
			label="{s.name} {mode === 'project' ? t('이 프로젝트') : t('모든 프로젝트')}"
		/>
	</span>
	<div class="info">
		<div class="line">
			<span class="name mono">{s.name}</span>
			<Badge size="sm">{s.scope === "project" ? t("프로젝트") : s.scope === "builtin" ? t("기본 내장") : t("전역")}</Badge>
			{#if !s.modelInvocable}<Badge size="sm" variant="outline">{t("수동 전용")}</Badge>{/if}
			{#if mode === "project" && s.override !== null}
				<Badge size="sm" variant="solid" tone="accent">{s.override ? t("프로젝트에서 켬") : t("프로젝트에서 끔")}</Badge>
				<button class="link small" onclick={() => reset(s)} disabled={saving[mode + s.name]} title={t("기본값을 따르도록 되돌리기")}>{t("되돌리기")}</button>
			{:else if mode === "global" && s.override !== null}
				<Badge size="sm" variant="outline">{t("프로젝트 설정 있음")}</Badge>
			{/if}
			{#if used.has(s.name)}<Badge size="sm" tone="ok">{t("이 대화에서 사용 중")}</Badge>{/if}
		</div>
		<p class="desc">{s.description}</p>
		<p class="path mono">{home(s.path)}</p>
	</div>
</li>
		{:else}
<li class="empty">
	{#if data?.skills.length}
		{t("일치하는 스킬이 없습니다.")}
	{:else}
		{t("스킬이 없습니다.")} <span class="mono">~/.agents/skills/&lt;{t("스킬 이름")}&gt;/SKILL.md</span> {t("또는 프로젝트의")} <span class="mono">.agents/skills/</span>{t("에 추가하세요.")}
	{/if}
</li>
		{/each}
	</ul>
{/snippet}

<!-- Native modal provides focus trapping, Escape, background inertness and focus restoration. -->
<dialog out:holdClosing|global oncancel={onclose} use:nativeModal={{ onclose }} aria-labelledby="skills-title">
	<div class="panel">
		<header use:sheetPull={{ onclose }}>
			<div class="titles">
				<h2 id="skills-title">{t("스킬")}</h2>
				{#if data}
					<p class="state">{t("{total}개 중 {on}개 사용", { total: data.skills.length, on: onCount })} · <span class="mono">{home(data.project)}</span></p>
				{/if}
			</div>
			<div class="actions">
				<button class="iconbtn" onclick={() => refresh++} disabled={loading} aria-label={t("새로고침")} title={t("새로고침")}><Icon name="retry" /></button>
				<button class="iconbtn" onclick={onclose} aria-label={t("닫기")}><Icon name="x" /></button>
			</div>
		</header>

		{#if (data?.skills.length ?? 0) > 6}
			<div class="tools">
				<input class="search" type="search" placeholder={t("스킬 검색")} bind:value={query} aria-label={t("스킬 검색")} />
			</div>
		{/if}

		<div class="body" aria-busy={loading}>
			{#if error}
				<div class="gap"><Notice tone="warn">{error}{#snippet action()}<button onclick={() => refresh++}>{t("다시 시도")}</button>{/snippet}</Notice></div>
			{/if}
			{#if !data && loading}
				<div class="empty" role="status">{t("불러오는 중…")}</div>
			{:else if data}
				<div class="note" role="status">
					{#if target.sessionId}
						{t("바꾼 설정은 이 대화의")} <b>{t("다음 메시지")}</b>{t("부터 바로 적용돼요.")}
					{:else}
						{t("바꾼 설정은 새 대화와 기존 대화의")} <b>{t("다음 메시지")}</b>{t("부터 적용돼요.")}
					{/if}
				</div>
				{#each data.warnings as warning}
					<div class="gap"><Notice tone="warn"><span class="mono">{home(warning.path)}</span><br />{warning.message}</Notice></div>
				{/each}
				<section class="section">
					<h3>{t("이 프로젝트")}</h3>
					<p class="hint">{t("이 프로젝트에서만 켜고 끕니다. 기본값과 같게 돌리면 기본값을 따릅니다.")}</p>
					{@render list("project")}
				</section>
				<section class="section">
					<h3>{t("모든 프로젝트")}</h3>
					<p class="hint">{t("모든 프로젝트의 기본값입니다. 프로젝트에서 따로 정한 스킬은 그대로 유지돼요.")}</p>
					{@render list("global")}
				</section>
			{/if}
		</div>
	</div>
</dialog>

<style>
	/* The global `* { margin: 0 }` reset removes the modal's default auto margin, so center explicitly. */
	dialog { margin: auto; width: min(var(--modal-w-xl), calc(100vw - var(--modal-gutter))); max-width: none; max-height: min(760px, calc(100dvh - 40px)); padding: 0; color: var(--text); background: var(--bg-side); border: 1px solid var(--border-strong); border-radius: var(--radius-panel); box-shadow: var(--shadow); overflow: hidden; }
	dialog::backdrop { background: var(--scrim); }
	.panel { display: flex; flex-direction: column; max-height: inherit; }
	header { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 18px 18px 14px 24px; flex: none; }
	.titles { min-width: 0; }
	h2 { margin: 0; font-size: var(--fs-xl); line-height: 1.4; }
	.state { margin: 3px 0 0; font-size: var(--fs-xs); color: var(--text-faint); overflow-wrap: anywhere; }
	.actions { display: flex; flex: none; }
	.tools { display: flex; padding: 0 24px 12px; flex: none; }
	.link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
	.search { flex: 1; min-width: 140px; padding: 7px 10px; font: inherit; font-size: var(--fs-sm); color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); }
	.hint { margin: 2px 0 10px; font-size: var(--fs-xs); color: var(--text-faint); }
	.section + .section { margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--border); }
	h3 { margin: 0; font-size: var(--fs-md, 1rem); font-weight: 600; }
	.body { overflow-y: auto; padding: 0 24px 24px; min-height: 80px; border-top: 1px solid var(--border); padding-top: 14px; }
	.note { margin-bottom: 12px; padding: 10px 12px; font-size: var(--fs-xs); line-height: 1.5; color: var(--text-dim); background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); }
	.note b { color: var(--text); font-weight: 600; }
	.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
	.item { display: flex; gap: 14px; align-items: flex-start; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius); }
	.item.off .info { opacity: 0.55; }
	.info { min-width: 0; flex: 1; transition: opacity var(--motion-fast) var(--ease); }
	.line { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
	.name { font-size: var(--fs-sm); font-weight: 600; }
	.desc { margin: 6px 0 0; font-size: var(--fs-xs); line-height: 1.55; color: var(--text-dim); display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
	.path { margin: 5px 0 0; font-size: var(--fs-2xs); color: var(--text-faint); overflow-wrap: anywhere; }
	.link { padding: 0; font: inherit; font-size: var(--fs-xs); color: var(--text-dim); text-decoration: underline; background: none; border: 0; cursor: pointer; }
	.link.small { font-size: var(--fs-2xs); }
	.link:hover:not(:disabled) { color: var(--text); }
	.switch { flex: none; display: inline-flex; margin-top: 2px; }
	.empty { padding: 18px 14px; font-size: var(--fs-sm); line-height: 1.6; color: var(--text-faint); background: var(--bg); border-radius: var(--radius); overflow-wrap: anywhere; }
	@media (max-width: 640px) {
		dialog { width: 100vw; max-height: 90dvh; margin: auto 0 0; border-radius: var(--radius-panel) var(--radius-panel) 0 0; padding-bottom: var(--sab); }
		header { padding: 14px 12px 12px 16px; }
		h2 { font-size: var(--fs-lg); }
		.tools { padding: 0 16px; }
		.body { padding: 14px 16px 16px; }
	}
	.gap { margin-bottom: 10px; }
</style>
