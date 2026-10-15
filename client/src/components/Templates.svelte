<script lang="ts">
	import Notice from "./Notice.svelte";
	import Badge from "./Badge.svelte";
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import { holdClosing } from "../lib/motion";
	import { sheetPull } from "../lib/sheet";
	import { errorText, type Api } from "../lib/api";
	import type { TemplateList } from "../lib/types";
	import Icon from "./Icon.svelte";
	import { nativeModal } from "../lib/dialog";

	let { dialog: target, api, onclose }: { dialog: { cwd: string }; api: Api; onclose: () => void } = $props();

	let data = $state<TemplateList | null>(null);
	let loading = $state(true);
	let error = $state("");
	let refresh = $state(0);
	let query = $state("");

	$effect(() => {
		refresh;
		// Files added or edited on disk arrive as skills_updated.
		app.skillsTick;
		const controller = new AbortController();
		error = "";
		api.templates(target.cwd, controller.signal)
			.then((list) => { if (!controller.signal.aborted) data = list; })
			.catch((e) => { if (!controller.signal.aborted) error = errorText(e); })
			.finally(() => { if (!controller.signal.aborted) loading = false; });
		return () => controller.abort();
	});

	const shown = $derived(
		(data?.templates ?? []).filter((s) => {
			const q = query.trim().toLowerCase();
			return !q || s.name.includes(q) || s.description.toLowerCase().includes(q);
		}),
	);

	const home = (p: string) => p.replace(/^\/home\/[^/]+/, "~");
</script>

<dialog out:holdClosing|global oncancel={onclose} use:nativeModal={{ onclose }} aria-labelledby="templates-title">
	<div class="panel">
		<header use:sheetPull={{ onclose }}>
			<div class="titles">
				<h2 id="templates-title">{t("프롬프트 템플릿")}</h2>
				{#if data}<p class="state">{t("{n}개", { n: data.templates.length })} · <span class="mono">{home(data.cwd)}</span></p>{/if}
			</div>
			<div class="actions">
				<button class="iconbtn" onclick={() => refresh++} disabled={loading} aria-label={t("새로고침")} title={t("새로고침")}><Icon name="retry" /></button>
				<button class="iconbtn" onclick={onclose} aria-label={t("닫기")}><Icon name="x" /></button>
			</div>
		</header>
		{#if (data?.templates.length ?? 0) > 6}
			<div class="tools"><input class="search" type="search" placeholder={t("템플릿 검색")} bind:value={query} aria-label={t("템플릿 검색")} /></div>
		{/if}
		<p class="hint">{t("입력창에 /prompt:이름 [내용]을 쓰면 저장된 긴 프롬프트가 대화에 전달됩니다. 프롬프트 안의 $ARGUMENTS는 뒤에 쓴 내용으로 바뀝니다.")}</p>

		<div class="body" aria-busy={loading}>
			{#if error}
				<div class="gap"><Notice tone="warn">{error}{#snippet action()}<button onclick={() => refresh++}>{t("다시 시도")}</button>{/snippet}</Notice></div>
			{/if}
			{#if !data && loading}
				<div class="empty" role="status">{t("불러오는 중…")}</div>
			{:else if data}
				{#each data.warnings as warning}
					<div class="gap"><Notice tone="warn"><span class="mono">{home(warning.path)}</span><br />{warning.message}</Notice></div>
				{/each}
				<ul class="list">
					{#each shown as s (s.name)}
						<li class="item">
							<div class="line">
								<span class="name mono">/prompt:{s.name}</span>
								<Badge size="sm">{s.scope === "project" ? t("프로젝트") : t("전역")}</Badge>
							</div>
							<p class="desc">{s.description}</p>
							<p class="path mono">{home(s.path)}</p>
						</li>
					{:else}
						<li class="empty">
							{#if data.templates.length}
								{t("일치하는 템플릿이 없습니다.")}
							{:else}
								{t("템플릿이 없습니다.")} <span class="mono">~/.agents/templates/&lt;{t("템플릿 이름")}&gt;.md</span> {t("또는 프로젝트의")} <span class="mono">.agents/templates/</span>{t("에 추가하세요.")}
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>
</dialog>

<style>
	dialog { margin: auto; width: min(680px, calc(100vw - 32px)); max-width: none; max-height: min(760px, calc(100dvh - 40px)); padding: 0; color: var(--text); background: var(--bg-side); border: 1px solid var(--border-strong); border-radius: var(--radius-panel); box-shadow: var(--shadow); overflow: hidden; }
	dialog::backdrop { background: var(--scrim); }
	.panel { display: flex; flex-direction: column; max-height: inherit; }
	header { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 18px 18px 14px 24px; flex: none; }
	.titles { min-width: 0; }
	h2 { margin: 0; font-size: var(--fs-xl); line-height: 1.4; }
	.state { margin: 3px 0 0; font-size: var(--fs-xs); color: var(--text-faint); overflow-wrap: anywhere; }
	.actions { display: flex; flex: none; }
	.tools { display: flex; padding: 0 24px; flex: none; }
	.search { flex: 1; min-width: 140px; padding: 7px 10px; font: inherit; font-size: var(--fs-sm); color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); }
	.hint { margin: 8px 24px 12px; font-size: var(--fs-xs); color: var(--text-faint); flex: none; }
	.body { overflow-y: auto; padding: 14px 24px 24px; min-height: 80px; border-top: 1px solid var(--border); }
	.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
	.item { padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius); }
	.line { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
	.name { font-size: var(--fs-sm); font-weight: 600; }
	.desc { margin: 6px 0 0; font-size: var(--fs-xs); line-height: 1.55; color: var(--text-dim); display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
	.path { margin: 5px 0 0; font-size: var(--fs-2xs); color: var(--text-faint); overflow-wrap: anywhere; }
	.empty { padding: 18px 14px; font-size: var(--fs-sm); line-height: 1.6; color: var(--text-faint); background: var(--bg); border-radius: var(--radius); overflow-wrap: anywhere; }
	.gap { margin-bottom: 10px; }
	@media (max-width: 640px) {
		dialog { width: 100vw; max-height: 90dvh; margin: auto 0 0; border-radius: var(--radius-panel) var(--radius-panel) 0 0; padding-bottom: var(--sab); }
		header { padding: 14px 12px 12px 16px; }
		h2 { font-size: var(--fs-lg); }
		.tools { padding: 0 16px; }
		.hint { margin: 8px 16px 12px; }
		.body { padding: 14px 16px 16px; }
	}
</style>
