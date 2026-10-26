<script lang="ts">
	import IconButton from "./IconButton.svelte";
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

	/** sessionId null: preview of a new conversation in `cwd`. */
	let { sessionId, cwd = "", api, onclose }: { sessionId: string | null; cwd?: string; api: Api; onclose: () => void } = $props();
	let data = $state<SessionContext | null>(null);
	let loading = $state(true);
	let error = $state("");
	let refresh = $state(0);
	/** Which sources are unfolded, by key. A plain <details> snaps open, so the fold is drawn by hand to animate. */
	let opened = $state<Record<string, boolean>>({});
	const scope = { global: msg("전역 AGENTS.md"), ancestor: msg("상위 폴더 AGENTS.md"), cwd: msg("프로젝트 AGENTS.md") };
	const source = { session: msg("이 세션의 도구 목록"), always: msg("항상 포함"), image: msg("이미지 모델"), browser: msg("브라우저") };
	const promptGroups = [
		{ kind: "sdk" as const, name: msg("SDK가 붙이는 문구"), hint: msg("pi SDK가 제공자별로 요청에 직접 넣는 문구입니다. 이 세션의 모델에 해당하는 것만 \"적용 중\"입니다.") },
		{ kind: "runtime" as const, name: msg("실행 중 추가되는 메시지"), hint: msg("대화가 진행되는 동안 서버가 메시지에 덧붙이거나 만들어 넣는 문구입니다.") },
		{ kind: "extension" as const, name: msg("확장이 바꿀 수 있는 부분"), hint: msg("서버 확장이 시스템 프롬프트나 메시지를 바꿀 수 있는 지점입니다.") },
		{ kind: "helper" as const, name: msg("보조 모델 호출"), hint: msg("대화와 별개로 서버가 직접 모델을 부르는 프롬프트입니다(요약, 제목, 그룹 이름).") },
	];
	const toolTotal = $derived((data?.toolSpecs ?? []).filter((x) => x.enabled).reduce((n, x) => n + x.bytes, 0));
	const toolText = (x: { name: string; description: string; parameters: unknown }) => `${x.description}\n\n${JSON.stringify(x.parameters, null, 2)}`;
	const bytes = (n: number) => n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;

	// A run captures the instructions, so refresh when the conversation progresses (never on streaming deltas).
	// Cleanup aborts obsolete requests on refresh, server/session switch, or dialog close.
	$effect(() => {
		refresh;
		// AGENTS.md / skills edited on disk arrive as skills_updated (AgentsWatcher).
		app.skillsTick;
		const chat = sessionId ? app.chatOf(sessionId) : null;
		chat?.items.length;
		chat?.running;
		const id = sessionId;
		const dir = cwd;
		untrack(() => { loading = true; error = ""; });
		return abortable((signal) => (id ? api.sessionContext(id, signal) : api.previewContext(dir, signal)), {
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
					<p class="state">{data.state === "applied" ? t("이 세션에 적용 중") : sessionId ? t("아직 적용 전 · 다음 메시지부터 적용됩니다") : t("새 대화에 적용될 내용")}</p>
				{/if}
			</div>
			<div class="actions">
				<IconButton icon="retry" label={t("새로고침")} tip onclick={() => refresh++} disabled={loading} />
				<IconButton icon="x" label={t("닫기")} onclick={onclose} />
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
							<span class="label"><span class="source-name">{t("시스템")}</span><span class="meta">{sessionId ? t("이 세션 기본") : t("새 대화 기본")} · {bytes(new TextEncoder().encode(data.systemPrompt).length)}</span></span>
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
					<h3>{t("시스템이 추가하는 프롬프트")}</h3>
					{#each promptGroups as g (g.kind)}
						{@const list = data.systemPrompts.filter((x) => x.kind === g.kind)}
						{#if list.length}
							<p class="note">{t(g.name)} — {t(g.hint)}</p>
							{#each list as p (p.id)}
								<div class="source" class:off={!p.active}>
									<button class="fold" onclick={() => (opened[`prompt:${p.id}`] = !opened[`prompt:${p.id}`])} aria-expanded={!!opened[`prompt:${p.id}`]}>
										<span class="label"><span class="source-name">{p.title}</span><span class="meta">{p.active ? t("적용 중") : t("이 세션에는 해당 없음")} · {bytes(p.bytes)}</span></span>
										<span class="chev" class:open={opened[`prompt:${p.id}`]}><Icon name="chevron-right" /></span>
									</button>
									{#if opened[`prompt:${p.id}`]}<p class="when">{p.when}</p><pre in:collapseIn out:collapseOut>{p.text}</pre>{/if}
								</div>
							{/each}
						{/if}
					{/each}
				</section>
				<section class="group">
					<h3>{t("도구")}</h3>
					{#if data.toolSpecs.length}
						<p class="note">{t("모델이 매 요청마다 받는 도구 정의입니다. 켜진 도구 {n}개 · 합계 {size}", { n: data.toolSpecs.filter((x) => x.enabled).length, size: bytes(toolTotal) })}</p>
					{/if}
					{#each data.toolSpecs as tool (tool.name)}
						<div class="source" class:off={!tool.enabled}>
							<button class="fold" onclick={() => (opened[`tool:${tool.name}`] = !opened[`tool:${tool.name}`])} aria-expanded={!!opened[`tool:${tool.name}`]}>
								<span class="label"><span class="source-name mono">{tool.name}</span><span class="meta">{t(source[tool.source])} · {bytes(tool.bytes)}{#if !tool.enabled} · {t("꺼짐 (설정)")}{/if}</span></span>
								<span class="chev" class:open={opened[`tool:${tool.name}`]}><Icon name="chevron-right" /></span>
							</button>
							{#if opened[`tool:${tool.name}`]}<pre in:collapseIn out:collapseOut>{toolText(tool)}</pre>{/if}
						</div>
					{:else}
						<div class="empty">{t("이 세션에 주어지는 도구가 없습니다.")}</div>
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
	.chev :global(svg) { width: 16px; height: 16px; stroke-width: 2; }
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
	.note { margin: 0 2px 8px; font-size: var(--fs-2xs); color: var(--text-faint); }
	.source.off { opacity: 0.55; }
	.when { margin: 0; padding: 10px 14px 0; border-top: 1px solid var(--border); font-size: var(--fs-2xs); line-height: 1.6; color: var(--text-faint); overflow-wrap: anywhere; }
	.when + pre { border-top: 0; }
</style>
