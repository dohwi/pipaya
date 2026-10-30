<script lang="ts">
	import EmptyState from "./EmptyState.svelte";
	import SearchField from "./SearchField.svelte";
	import IconButton from "./IconButton.svelte";
	import { abortable } from "../lib/abortable";
	import Notice from "./Notice.svelte";
	import Badge from "./Badge.svelte";
	import Switch from "./Switch.svelte";
	import { t } from "../lib/i18n";
	import { reflow, rowIn, rowOut } from "../lib/motion";
	import { untrack } from "svelte";
	import { errorText, type Api, type ApiError } from "../lib/api";
	import { app } from "../lib/store.svelte";
	import type { SessionContext, SkillInfo, SkillList } from "../lib/types";
	import DialogBody from "./DialogBody.svelte";
	import ListItem from "./ListItem.svelte";
	import Modal from "./Modal.svelte";

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
		const { cwd, sessionId } = target;
		untrack(() => { if (!data) loading = true; error = ""; });
		return abortable((signal) => Promise.all([
			api.skills(cwd, signal, sessionId),
			sessionId ? api.sessionContext(sessionId, signal).catch(() => null) : null,
		]), {
			ok: ([list, ctx]) => {
				data = list;
				session = ctx;
			},
			fail: (e) => (error = (e as ApiError)?.status === 404 && /route/i.test((e as Error).message)
				? t("서버가 스킬 기능을 지원하지 않습니다. 서버를 최신 버전으로 재시작한 뒤 다시 시도하세요.")
				: errorText(e)),
			done: () => (loading = false),
		});
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
<li animate:reflow in:rowIn out:rowOut>
	<ListItem off={!on || !s.modelInvocable}>
		{#snippet lead()}
			<span title={s.modelInvocable ? undefined : t("자동 호출에서 제외된 스킬(disable-model-invocation)이라 켜고 끌 수 없습니다")}>
				<Switch
					checked={on && s.modelInvocable}
					disabled={!s.modelInvocable || saving[mode + s.name]}
					onchange={next => toggle(s, next, mode)}
					label="{s.name} {mode === 'project' ? t('이 프로젝트') : t('모든 프로젝트')}"
				/>
			</span>
		{/snippet}
		{#snippet title()}
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
		{/snippet}
		<p class="desc">{s.description}</p>
		<p class="meta mono">{home(s.path)}</p>
	</ListItem>
</li>
		{:else}
<EmptyState as="li">
	{#if data?.skills.length}
		{t("일치하는 스킬이 없습니다.")}
	{:else}
		{t("스킬이 없습니다.")} <span class="mono">~/.agents/skills/&lt;{t("스킬 이름")}&gt;/SKILL.md</span> {t("또는 프로젝트의")} <span class="mono">.agents/skills/</span>{t("에 추가하세요.")}
	{/if}
</EmptyState>
		{/each}
	</ul>
{/snippet}

<Modal {onclose} title={t("스킬")} sub={data ? `${t("{total}개 중 {on}개 사용", { total: data.skills.length, on: onCount })} · ${home(data.project)}` : null} width="xl" maxHeight="760px" safeArea>
	{#snippet headerActions()}
		<IconButton icon="retry" label={t("새로고침")} tip onclick={() => refresh++} disabled={loading} />
	{/snippet}

	{#if (data?.skills.length ?? 0) > 6}
		<div class="tools">
			<SearchField label={t("스킬 검색")} bind:value={query} />
		</div>
	{/if}

	<DialogBody busy={loading}>
		{#if error}
			<div class="gap"><Notice tone="warn">{error}{#snippet action()}<button onclick={() => refresh++}>{t("다시 시도")}</button>{/snippet}</Notice></div>
		{/if}
		{#if !data && loading}
			<EmptyState loading />
		{:else if data}
			<div class="note" role="status">
				{#if target.sessionId}
					{t("바꾼 설정은 이 대화의")} <b>{t("다음 메시지")}</b>{t("부터 바로 적용됩니다.")}
				{:else}
					{t("바꾼 설정은 새 대화와 기존 대화의")} <b>{t("다음 메시지")}</b>{t("부터 적용됩니다.")}
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
				<p class="hint">{t("모든 프로젝트의 기본값입니다. 프로젝트에서 따로 정한 스킬은 그대로 유지됩니다.")}</p>
				{@render list("global")}
			</section>
		{/if}
	</DialogBody>
</Modal>

<style>
	.tools { display: flex; padding: 0 var(--dlg-px) var(--dlg-foot-t); flex: none; }
	.link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
	.hint { margin: 4px 0 8px; }
	.section + .section { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border); }
	h3 { margin: 0; font-size: var(--fs-md, 1rem); font-weight: 600; }
	.note { margin-bottom: 12px; padding: 8px 12px; font-size: var(--fs-xs); line-height: 1.5; color: var(--text-dim); background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); }
	.note b { color: var(--text); font-weight: 600; }
	.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
	.link { padding: 0; font: inherit; font-size: var(--fs-xs); color: var(--text-dim); text-decoration: underline; background: none; border: 0; cursor: pointer; }
	.link.small { font-size: var(--fs-2xs); }
	.link:hover:not(:disabled) { color: var(--text); }
	@media (max-width: 640px) {
		.tools { padding: 0 var(--dlg-px); }
	}
	.gap { margin-bottom: 8px; }
</style>
