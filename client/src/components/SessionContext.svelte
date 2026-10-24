<script lang="ts">
	import { abortable } from "../lib/abortable";
	import Notice from "./Notice.svelte";
	import { msg, t } from "../lib/i18n";
	import { collapseIn, collapseOut, holdClosing } from "../lib/motion";
	import { sheetPull } from "../lib/sheet";
	import { untrack } from "svelte";
	import { errorText, type Api, type ApiError } from "../lib/api";
	import { app } from "../lib/store.svelte";
	import type { SessionContext } from "../lib/types";
	import Icon from "./Icon.svelte";
	import { nativeModal } from "../lib/dialog";

	let { sessionId, api, onclose }: { sessionId: string; api: Api; onclose: () => void } = $props();
	let data = $state<SessionContext | null>(null);
	let loading = $state(true);
	let error = $state("");
	let refresh = $state(0);
	/** Which sources are unfolded, by key. A plain <details> snaps open, so the fold is drawn by hand to animate. */
	let opened = $state<Record<string, boolean>>({});
	const scope = { global: msg("전역 AGENTS.md"), ancestor: msg("상위 폴더 AGENTS.md"), cwd: msg("프로젝트 AGENTS.md") };
	const bytes = (n: number) => n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;

	// A run captures the instructions, so refresh when the conversation progresses (never on streaming deltas).
	// Cleanup aborts obsolete requests on refresh, server/session switch, or dialog close.
	$effect(() => {
		refresh;
		const chat = app.chatOf(sessionId);
		chat?.items.length;
		chat?.running;
		untrack(() => { loading = true; error = ""; });
		return abortable((signal) => api.sessionContext(sessionId, signal), {
			ok: (result) => (data = result),
			// Duck-typed: don't depend on class identity (HMR/duplicated module instances break instanceof).
			fail: (e) => (error = (e as ApiError)?.status === 404 && /route/i.test((e as Error).message)
				? t("서버가 이 기능을 지원하지 않습니다. 서버를 최신 버전으로 재시작한 뒤 다시 시도하세요.")
				: errorText(e)),
			done: () => (loading = false),
		});
	});

</script>

<!-- Native modal provides focus trapping, Escape, background inertness and focus restoration. -->
<dialog out:holdClosing|global oncancel={onclose} use:nativeModal={{ onclose }} aria-labelledby="session-context-title">
	<div class="panel">
		<header use:sheetPull={{ onclose }}>
			<div>
				<h2 id="session-context-title">{t("적용된 컨텍스트")}</h2>
				{#if data}
					<p class="state">{data.state === "applied" ? t("이 세션에 적용 중") : t("아직 적용 전 · 다음 메시지부터 적용됩니다")}</p>
				{/if}
			</div>
			<div class="actions">
				<button class="iconbtn" onclick={() => refresh++} disabled={loading} aria-label={t("새로고침")} title={t("새로고침")}><Icon name="retry" /></button>
				<button class="iconbtn" onclick={onclose} aria-label={t("닫기")}><Icon name="x" /></button>
			</div>
		</header>
		<div class="body" aria-busy={loading}>
			{#if error}
				<div class="gap"><Notice tone="warn">{error}{#snippet action()}<button onclick={() => refresh++}>{t("다시 시도")}</button>{/snippet}</Notice></div>
			{/if}
			{#if !data && loading}
				<div class="empty" role="status">{t("불러오는 중…")}</div>
			{:else if data}
				{#each data.warnings as warning}
					<div class="gap"><Notice tone="warn"><span class="mono">{warning.path}</span><br />{warning.message}</Notice></div>
				{/each}
				<section class="group">
					<h3>{t("기본 프롬프트")}</h3>
					<div class="source">
						<button class="fold" onclick={() => (opened.system = !opened.system)} aria-expanded={!!opened.system}>
							<span class="label"><span class="source-name">{t("시스템")}</span><span class="meta">{t("이 세션 기본")} · {bytes(new TextEncoder().encode(data.systemPrompt).length)}</span></span>
							<span class="chev" class:open={opened.system}><Icon name="chevron-right" /></span>
						</button>
						{#if opened.system}<pre in:collapseIn out:collapseOut>{data.systemPrompt}</pre>{/if}
					</div>
					{#each [
						{ key: "skills", name: t("스킬"), text: data.skillsPrompt, count: data.skills.length },
					] as block (block.key)}
						{#if block.text}
							<div class="source">
								<button class="fold" onclick={() => (opened[block.key] = !opened[block.key])} aria-expanded={!!opened[block.key]}>
									<span class="label"><span class="source-name">{block.name}</span><span class="meta">{t("{n}개 주입 중", { n: block.count })} · {bytes(new TextEncoder().encode(block.text).length)}</span></span>
									<span class="chev" class:open={opened[block.key]}><Icon name="chevron-right" /></span>
								</button>
								{#if opened[block.key]}<pre in:collapseIn out:collapseOut>{block.text}</pre>{/if}
							</div>
						{/if}
					{/each}
				</section>
				<section class="group">
					<h3>{t("AGENTS.md (적용 순서)")}</h3>
					{#each data.instructions as instruction, i (instruction.path)}
						<div class="source">
							<button class="fold" onclick={() => (opened[instruction.path] = !opened[instruction.path])} aria-expanded={!!opened[instruction.path]}>
								<span class="label"><span class="source-name mono">{i + 1}. {instruction.path}</span><span class="meta">{t(scope[instruction.scope])} · {bytes(instruction.bytes)}</span></span>
								<span class="chev" class:open={opened[instruction.path]}><Icon name="chevron-right" /></span>
							</button>
							{#if opened[instruction.path]}<pre in:collapseIn out:collapseOut>{instruction.content}</pre>{/if}
						</div>
					{:else}
						<div class="empty">{t("적용된 AGENTS.md가 없습니다. (전역·상위 폴더·프로젝트 모두 없음)")}</div>
					{/each}
				</section>
			{/if}
		</div>
	</div>
</dialog>

<style>
	/* The global `* { margin: 0 }` reset removes the modal's default auto margin, so center explicitly. */
	dialog { margin: auto; width: min(var(--modal-w-xl), calc(var(--vw) - var(--modal-gutter))); max-width: none; max-height: min(720px, calc(var(--dvh) - 40px)); padding: 0; color: var(--text); background: var(--bg-side); border: 1px solid var(--border-strong); border-radius: var(--radius-panel); box-shadow: var(--shadow); overflow: hidden; }
	dialog::backdrop { background: var(--scrim); }
	.panel { display: flex; flex-direction: column; max-height: inherit; }
	header { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 18px 18px 16px 24px; border-bottom: 1px solid var(--border); flex: none; }
	h2 { margin: 0; font-size: var(--fs-xl); line-height: 1.4; }
	.state { margin: 3px 0 0; font-size: var(--fs-xs); color: var(--text-faint); }
	.actions { display: flex; flex: none; }
	.body { overflow-y: auto; padding: 18px 24px 24px; min-height: 80px; }
	.source { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
	.source + .source { margin-top: 8px; }
	.group + .group { margin-top: 22px; }
	h3 { margin: 0 0 8px 2px; font-size: var(--fs-xs); font-weight: 600; color: var(--text-faint); }
	.fold { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; padding: 12px 14px; text-align: left; overflow-wrap: anywhere; }
	.fold:hover { background: var(--bg-hover); }
	/* a full-width row must not shrink when pressed (the global 0.97 press scale is meant for small buttons): feedback is a tint */
	.fold:active { scale: none; background: var(--bg-active); }
	.label { min-width: 0; }
	/* the arrow turns in step with the body: same duration and curve as collapseIn (open) / collapseOut (close) */
	.chev { flex: none; display: grid; color: var(--text-faint); transition: transform var(--motion-fast) var(--ease-exit); }
	.chev.open { transition: transform var(--motion-normal) var(--ease); }
	.chev.open { transform: rotate(90deg); }
	.chev :global(svg) { width: 16px; height: 16px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
	.source-name { font-size: var(--fs-xs); }
	.meta { display: block; margin-top: 5px; color: var(--text-faint); font-size: var(--fs-2xs); }
	pre { border-top: 1px solid var(--border); margin: 0; padding: 14px; max-height: 360px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.7 var(--mono); background: var(--bg); user-select: text; }
	.empty { padding: 18px 14px; font-size: var(--fs-sm); color: var(--text-faint); background: var(--bg); border-radius: var(--radius); }
	@media (max-width: 640px) {
		dialog { width: var(--vw); max-height: calc(var(--dvh) * 0.9); margin: auto 0 0; border-radius: var(--radius-panel) var(--radius-panel) 0 0; padding-bottom: var(--sab); }
		header { padding: 14px 12px 14px 16px; }
		h2 { font-size: var(--fs-lg); }
		.body { padding: 16px; }
	}
	.gap { margin-bottom: 10px; }
</style>
