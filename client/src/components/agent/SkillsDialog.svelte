<script lang="ts">
	import EmptyState from "../ui/EmptyState.svelte";
	import SearchField from "../ui/SearchField.svelte";
	import IconButton from "../ui/IconButton.svelte";
	import { abortable } from "../../lib/abortable";
	import Notice from "../ui/Notice.svelte";
	import Badge from "../ui/Badge.svelte";
	import Switch from "../ui/Switch.svelte";
	import Button from "../ui/Button.svelte";
	import ConfirmButton from "../ui/ConfirmButton.svelte";
	import SkillEditor from "./SkillEditor.svelte";
	import { t } from "../../lib/i18n";
	import { reflow, rowIn, rowOut } from "../../lib/motion";
	import { untrack } from "svelte";
	import { errorText, type Api, type ApiError } from "../../lib/api";
	import { app } from "../../lib/store.svelte";
	import type { SessionContext, SkillInfo, SkillList, SkillSource } from "../../lib/types";
	import DialogBody from "../ui/DialogBody.svelte";
	import ExtrasIntro from "../ui/ExtrasIntro.svelte";
	import ListGroup from "../ui/ListGroup.svelte";
	import ListItem from "../ui/ListItem.svelte";
	import Modal from "../ui/Modal.svelte";
	import Segmented from "../ui/Segmented.svelte";

	let { dialog: target, api, onclose }: { dialog: { cwd: string; sessionId: string | null }; api: Api; onclose: () => void } = $props();

	type Mode = "project" | "global";
	let data = $state<SkillList | null>(null);
	let session = $state<SessionContext | null>(null);
	let loading = $state(true);
	let error = $state("");
	let refresh = $state(0);
	let query = $state("");
	let tab = $state<Mode>("project");
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
	const onCount = $derived((data?.skills ?? []).filter(s => s.enabled).length);
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

	/* ---------- edit / delete: they change the skill's own files, so every skill from a file has them (the built-in ones are read-only) ---------- */
	let editing = $state<SkillSource | null>(null);
	let fileBusy = $state(false);
	async function startEdit(s: SkillInfo) {
		if (fileBusy) return;
		fileBusy = true;
		error = "";
		try {
			editing = await api.skillSource(s.name, target.cwd);
		} catch (e) {
			error = errorText(e);
		} finally {
			fileBusy = false;
		}
	}
	async function remove(s: SkillInfo) {
		if (fileBusy) return;
		fileBusy = true;
		error = "";
		try {
			data = await api.deleteSkill(s.name, target.cwd);
			app.skillsTick++;
		} catch (e) {
			error = errorText(e);
		} finally {
			fileBusy = false;
		}
	}

	const home = (p: string) => p.replace(/^\/home\/[^/]+/, "~");
</script>

{#snippet list(mode: Mode)}
	<ul class="list">
		{#each shown as s (s.name)}
{@const on = effective(s, mode)}
<li animate:reflow in:rowIn out:rowOut>
{#snippet fileActions()}
	<Button size="sm" onclick={() => startEdit(s)} disabled={fileBusy}>{t("수정")}</Button>
	<ConfirmButton size="sm" danger confirmLabel={t("정말 삭제")} onconfirm={() => remove(s)} disabled={fileBusy}>{t("삭제")}</ConfirmButton>
{/snippet}
	<ListItem off={!on} actions={s.scope !== "builtin" ? fileActions : undefined}>
		{#snippet lead()}
			<Switch
				checked={on}
				disabled={saving[mode + s.name]}
				onchange={next => toggle(s, next, mode)}
				label="{s.name} {mode === 'project' ? t('이 프로젝트') : t('모든 프로젝트')}"
			/>
		{/snippet}
		{#snippet title()}
			<span class="name mono">{s.name}</span>
			<Badge size="sm" variant="outline">{s.scope === "project" ? t("프로젝트") : s.scope === "builtin" ? t("기본 내장") : t("전역")}</Badge>
			{#if !on}<Badge size="sm">{t("꺼짐")}</Badge>{/if}
			{#if !s.modelInvocable}<span title={t("에이전트는 이 스킬을 모릅니다. /skill:이름 으로 직접 부를 때만 쓰입니다.")}><Badge size="sm" variant="outline">{t("수동 전용")}</Badge></span>{/if}
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

	<DialogBody gap busy={loading}>
		{#if error}
			<Notice tone="warn">{error}{#snippet action()}<button onclick={() => refresh++}>{t("다시 시도")}</button>{/snippet}</Notice>
		{/if}
		{#if !data && loading}
			<EmptyState loading />
		{:else if data}
			<ExtrasIntro
				what={t("에이전트가 작업에 맞으면 스스로 읽어서 따르는 지침 묶음입니다. 사용자가 /skill:이름 으로 직접 부를 수도 있습니다.")}
				how={target.sessionId ? t("바꾼 설정은 이 대화의 다음 메시지부터 바로 적용됩니다.") : t("바꾼 설정은 새 대화와 기존 대화의 다음 메시지부터 적용됩니다.")}
			/>
			{#each data.warnings as warning}
				<Notice tone="warn"><span class="mono">{home(warning.path)}</span><br />{warning.message}</Notice>
			{/each}
			{@const projOn = data.skills.filter(x => effective(x, "project")).length}
			{@const globOn = data.skills.filter(x => x.globalEnabled).length}
			<Segmented
				tabs
				label={t("적용 범위")}
				value={tab}
				onchange={(id) => (tab = id)}
				options={[
					{ id: "project", label: `${t("이 프로젝트")} ${projOn}/${data.skills.length}` },
					{ id: "global", label: `${t("모든 프로젝트")} ${globOn}/${data.skills.length}` },
				]}
			/>
			{#if tab === "project"}
				<ListGroup title={t("이 프로젝트")} count={t("{on}/{total}개 사용", { on: projOn, total: data.skills.length })} path={home(data.project)} hint={t("이 프로젝트에서만 켜고 끕니다. 기본값과 같게 돌리면 기본값을 따릅니다.")}>
					{@render list("project")}
				</ListGroup>
			{:else}
				<ListGroup title={t("모든 프로젝트")} count={t("{on}/{total}개 사용", { on: globOn, total: data.skills.length })} hint={t("모든 프로젝트의 기본값입니다. 프로젝트에서 따로 정한 스킬은 그대로 유지됩니다.")}>
					{@render list("global")}
				</ListGroup>
			{/if}
		{/if}
	</DialogBody>
</Modal>

{#if editing}
	<SkillEditor source={editing} cwd={target.cwd} {api} onsaved={(l) => { data = l; app.skillsTick++; }} onclose={() => (editing = null)} />
{/if}

<style>
	.tools { display: flex; padding: 0 var(--dlg-px) var(--dlg-foot-t); flex: none; }
	.link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
	.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
	.link { padding: 0; font: inherit; font-size: var(--fs-xs); color: var(--text-dim); text-decoration: underline; background: none; border: 0; cursor: pointer; }
	.link.small { font-size: var(--fs-2xs); }
	.link:hover:not(:disabled) { color: var(--text); }
	@media (max-width: 640px) {
		.tools { padding: 0 var(--dlg-px); }
	}
</style>
