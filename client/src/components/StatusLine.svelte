<script lang="ts">
	import { localeTag, t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import { extensions } from "../lib/extensions/host.svelte";
	import { compact, money } from "../lib/format";
	import type { AssistantItem } from "../lib/types";
	import Icon from "./Icon.svelte";
	import SessionContext from "./SessionContext.svelte";
	import { getPane } from "../lib/pane";
	import { cacheLevel, contextLevel, costLevel, speedLevel } from "../lib/status-level";

	const pane = getPane();
	const chat = $derived(app.chatOf(pane.id));

	// Live call statistics come from the transcript; server context and billing totals also include compaction.
	const calls = $derived(
		(chat?.items ?? []).filter((i): i is AssistantItem => i.kind === "assistant" && !i.streaming && (i.usage?.totalTokens ?? 0) > 0),
	);
	const last = $derived(calls[calls.length - 1]);

	// Number of entries in the context panel: the system prompt plus every applied AGENTS.md.
	// Servers without the endpoint (or a failed lookup) simply hide the item.
	type Loaded = { key: string; files: string[]; skills: string[] | null };
	let loaded = $state<Loaded | null>(null);
	let openKey = $state<string | null>(null);
	const ctxKey = $derived(pane.id ? `${app.serverId}:${pane.id}` : null);
	const here = $derived(loaded && loaded.key === ctxKey ? loaded : null);
	// Applied AGENTS.md files; the system prompt is always there and is shown inside the panel.
	const ctxFiles = $derived(here ? here.files.length : null);
	$effect(() => {
		const id = pane.id;
		const key = ctxKey;
		const api = app.api;
		// A run captures the instructions, so re-read when the conversation progresses (not on streaming deltas).
		chat?.items.length;
		chat?.running;
		app.skillsTick;
		if (!id || !key || !api) return;
		const controller = new AbortController();
		api.sessionContext(id, controller.signal)
			// `skills` is absent on servers that predate skills: hide the item rather than show a wrong 0.
			.then(r => { if (!controller.signal.aborted) loaded = { key, files: r.instructions.map(i => i.path), skills: Array.isArray(r.skills) ? r.skills.map(k => k.name) : null }; })
			.catch(() => { if (!controller.signal.aborted && loaded?.key === key) loaded = null; });
		return () => controller.abort();
	});
	$effect(() => { if (openKey !== ctxKey) openKey = null; });

	// Skills the model is offered. A conversation shows what it uses (frozen after its first run);
	// a new chat shows what the next conversation in the chosen directory will get.
	let fresh = $state<{ key: string; names: string[] } | null>(null);
	const cwdKey = $derived(pane.id ? null : `${app.serverId}:${app.workdirAbs}`);
	$effect(() => {
		const key = cwdKey;
		const api = app.api;
		app.skillsTick;
		if (!key || !api) return;
		const controller = new AbortController();
		api.skills(app.workdirAbs, controller.signal)
			.then(r => { if (!controller.signal.aborted) fresh = { key, names: r.skills.filter(k => k.enabled && k.modelInvocable).map(k => k.name) }; })
			.catch(() => { if (!controller.signal.aborted && fresh?.key === key) fresh = null; });
		return () => controller.abort();
	});
	// Prompt templates callable as /template:name in the chosen directory (the open chat's, else the new-chat one).
	let tpl = $state<{ key: string; names: string[] } | null>(null);
	const tplCwd = $derived((pane.id ? app.session(pane.id)?.cwd : null) || app.workdirAbs);
	const tplKey = $derived(`${app.serverId}:${tplCwd}`);
	$effect(() => {
		const key = tplKey;
		const cwd = tplCwd;
		const api = app.api;
		app.skillsTick;
		chat?.items.length;
		if (!api) return;
		const controller = new AbortController();
		api.templates(cwd, controller.signal)
			.then(r => { if (!controller.signal.aborted) tpl = { key, names: r.templates.map(k => k.name) }; })
			// Servers that predate templates simply hide the item.
			.catch(() => { if (!controller.signal.aborted && tpl?.key === key) tpl = null; });
		return () => controller.abort();
	});
	const tplNames = $derived(tpl && tpl.key === tplKey ? tpl.names : null);
	const tplTip = $derived(
		tplNames
			? [
					t("사용할 수 있는 프롬프트 템플릿 {n}개", { n: tplNames.length }),
					tplNames.length ? tplNames.slice(0, 8).map(n => `/template:${n}`).join(", ") + (tplNames.length > 8 ? ` ${t("외 {n}개", { n: tplNames.length - 8 })}` : "") : t("템플릿이 없습니다."),
					t("눌러서 목록 보기"),
				].join("\n")
			: "",
	);
	const skillNames = $derived(pane.id ? (here ? here.skills : null) : (fresh && fresh.key === cwdKey ? fresh.names : null));
	const skillCount = $derived(skillNames ? skillNames.length : null);
	const list = (items: string[], max = 8) => items.slice(0, max).join(", ") + (items.length > max ? ` ${t("외 {n}개", { n: items.length - max })}` : "");
	const base = (p: string) => p.replace(/^\/home\/[^/]+/, "~");
	const filesTip = $derived(
		here
			? [
					here.files.length ? t("적용된 AGENTS.md {n}개", { n: here.files.length }) : t("적용된 AGENTS.md가 없습니다"),
					...here.files.slice(0, 6).map(f => `· ${base(f)}`),
					here.files.length > 6 ? `· ${t("외 {n}개", { n: here.files.length - 6 })}` : "",
					t("눌러서 시스템 프롬프트와 함께 보기"),
				].filter(Boolean).join("\n")
			: "",
	);
	const skillsTip = $derived(
		skillNames
			? [
					pane.id ? t("이 대화가 사용하는 스킬 {n}개 (이 프로젝트 설정 반영)", { n: skillNames.length }) : t("다음 대화에서 사용할 스킬 {n}개", { n: skillNames.length }),
					skillNames.length ? list(skillNames) : t("켜진 스킬이 없습니다"),
					t("눌러서 켜기/끄기"),
				].join("\n")
			: "",
	);

	const context = $derived(chat?.context);
	const win = $derived(context?.contextWindow ?? app.effectiveModelOf(pane.id)?.contextWindow ?? 0);
	// Legacy servers only offer a last-call approximation. Explicit null must NOT resurrect pre-compaction usage.
	const estimated = $derived(context === undefined);
	const ctx = $derived(estimated ? (last?.usage?.totalTokens ?? null) : context!.tokens);
	const ctxPct = $derived(win && ctx !== null ? (ctx / win) * 100 : 0);

	const sum = $derived.by(() => {
		const acc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		for (const c of calls) {
			const u = c.usage!;
			acc.input += u.input;
			acc.output += u.output;
			acc.cacheRead += u.cacheRead ?? 0;
			acc.cacheWrite += u.cacheWrite ?? 0;
			acc.cost += u.cost?.total ?? 0;
		}
		return acc;
	});
	// Share of prompt tokens served from the provider's cache.
	const totals = $derived(chat?.usage && chat.usage.turns >= calls.length ? chat.usage : sum);
	const prompt = $derived(totals.input + totals.cacheRead + totals.cacheWrite);
	const hit = $derived(prompt > 0 ? (totals.cacheRead / prompt) * 100 : null);

	const tps = $derived(last?.durationMs && last.usage && last.usage.output > 0 ? last.usage.output / (last.durationMs / 1000) : null);

	const ring = 2 * Math.PI * 7;
	const level = $derived(ctx === null || !win ? "" : contextLevel(ctxPct));
	const hitLevel = $derived(cacheLevel(hit, calls.length));
	const tpsLevel = $derived(speedLevel(tps));
	const costState = $derived(costLevel(totals.cost));
	const pct = (n: number) => (n >= 10 ? n.toFixed(0) : n.toFixed(1));

	const ctxWindow = $derived(win ? ` / ${win.toLocaleString(localeTag())} ${t("토큰")} (${pct(ctxPct)}%)` : ` ${t("토큰")}`);
	const ctxTip = $derived(
		[
			ctx === null
				? t("현재 컨텍스트 사용량을 아직 측정하지 못했습니다")
				: (estimated ? t("컨텍스트 추정 {used}{window}", { used: ctx.toLocaleString(localeTag()), window: ctxWindow }) : t("컨텍스트 {used}{window}", { used: ctx.toLocaleString(localeTag()), window: ctxWindow })),
			estimated ? t("마지막 모델 호출 기준이며, 새 입력과 도구 결과는 포함되지 않습니다") : "",
			level ? t("컨텍스트 압축으로 오래된 기록을 요약할 수 있습니다") : "",
			chat?.compaction?.autoEnabled ? t("서버의 pi 자동 압축이 활성화되어 있습니다") : "",
		]
			.filter(Boolean)
			.join("\n"),
	);
	const hitTip = $derived(
		hit === null
			? ""
			: [t("캐시 적중률 {n}%", { n: pct(hit) }), t("프롬프트 {prompt} 토큰 중 {read} 토큰을 캐시에서 읽었습니다", { prompt: prompt.toLocaleString(localeTag()), read: totals.cacheRead.toLocaleString(localeTag()) })].join("\n"),
	);
	const tpsTip = $derived(tps === null ? "" : t("출력 속도 {n} 토큰/초 (마지막 응답)", { n: tps.toFixed(1) }));
	const costTip = $derived(
		[t("이 대화 누적 비용 · 모델 호출 {n}회", { n: calls.length }), t("입력 {input} · 출력 {output} 토큰", { input: prompt.toLocaleString(localeTag()), output: totals.output.toLocaleString(localeTag()) })].join("\n"),
	);
	const speed = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));
</script>

<!-- Reserve room before the first reply; allow narrow screens to wrap without clipping. -->
<div class="statusline mono" aria-label={t("세션 통계")}>
	{#each extensions.statuses as item (`${item.owner}:${item.id}`)}
		<span class="b" title={item.owner}>{item.text}</span>
	{/each}
	{#if ctxFiles !== null}
		<button class="b files" class:empty={ctxFiles === 0} onclick={() => (openKey = ctxKey)} aria-haspopup="dialog" aria-label={t("AGENTS.md {n}개", { n: ctxFiles })} title={filesTip}>
			<Icon name="prompt" />
			<span class="v">{t("{n}개", { n: ctxFiles })}</span>
		</button>
	{/if}
	{#if skillCount !== null}
		<button class="b skills" class:empty={skillCount === 0} onclick={() => app.openSkills(pane.id)} aria-haspopup="dialog" aria-label={t("스킬 {n}개", { n: skillCount })} title={skillsTip}>
			<Icon name="skill" />
			<span class="v">{t("{n}개", { n: skillCount })}</span>
		</button>
	{/if}
	{#if tplNames !== null}
		<button class="b templates" class:empty={tplNames.length === 0} onclick={() => app.openTemplates(pane.id)} aria-haspopup="dialog" aria-label={t("템플릿 {n}개", { n: tplNames.length })} title={tplTip}>
			<Icon name="list" />
			<span class="v">{t("{n}개", { n: tplNames.length })}</span>
		</button>
	{/if}
	{#if calls.length || context !== undefined}
		<span class="b ctx {level}" title={ctxTip}>
			<svg class="ring" viewBox="0 0 18 18" aria-hidden="true">
				<circle cx="9" cy="9" r="7" class="track" />
				<circle cx="9" cy="9" r="7" class="fill" stroke-dasharray={ring} stroke-dashoffset={ring * (1 - Math.min(100, ctxPct) / 100)} />
			</svg>
			<span class="v">{ctx === null ? "—" : win ? `${pct(ctxPct)}%` : compact(ctx)}</span>
		</span>
		{#if hit !== null}
			<span class="b hit {hitLevel}" title={hitTip}>
				<Icon name="cache" />
				<span class="v">{pct(hit)}%</span>
			</span>
		{/if}
		{#if tps !== null}
			<span class="b tps {tpsLevel}" title={tpsTip}>
				<Icon name="gauge" />
				<span class="v">{speed(tps)}</span><span class="unit wide">tok/s</span>
			</span>
		{/if}
		{#if totals.cost > 0}
			<span class="b cost {costState}" title={costTip}>
				<Icon name="coin" />
				<span class="v">{money(totals.cost).replace("$", "")}</span>
			</span>
		{/if}
	{/if}
</div>

{#if openKey && openKey === ctxKey && pane.id && app.api}
	{#key openKey}
		<SessionContext sessionId={pane.id} api={app.api} onclose={() => (openKey = null)} />
	{/key}
{/if}

<style>
	/* Plain text and icons under the input: no pills. Only the context ring turns amber/red as it fills. */
	.statusline {
		display: flex;
		justify-content: center;
		align-items: center;
		column-gap: 14px;
		row-gap: 4px;
		min-height: 26px;
		flex-wrap: wrap;
		padding: 8px 10px 0;
		font-size: var(--fs-2xs);
		line-height: 1;
		color: var(--text-faint);
		user-select: none;
	}
	.b {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 2px 0;
		font: inherit;
		color: inherit;
		white-space: nowrap;
		cursor: default;
		transition: color var(--motion-fast) var(--ease);
	}
	button.b {
		cursor: pointer;
		border-radius: var(--radius-sm);
	}
	button.b:hover {
		color: var(--text);
	}
	button.b:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.b.empty {
		opacity: 0.6;
	}
	.b.warn {
		color: var(--warn);
	}
	.b.danger {
		color: var(--danger);
	}
	.v {
		font-variant-numeric: tabular-nums;
	}
	.unit {
		font-size: var(--fs-2xs);
		opacity: 0.75;
	}
	.ring {
		width: 13px;
		height: 13px;
		transform: rotate(-90deg);
		flex: none;
	}
	.ring circle {
		fill: none;
		stroke-width: 2.2;
	}
	.ring .track {
		stroke: color-mix(in srgb, currentColor 25%, transparent);
	}
	.ring .fill {
		stroke: currentColor;
		stroke-linecap: round;
		transition: stroke-dashoffset var(--motion-slow) var(--ease);
	}
	.b :global(svg:not(.ring)) {
		width: 13px;
		height: 13px;
		flex: none;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.7;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	@media (max-width: 560px) {
		.wide {
			display: none;
		}
	}
</style>
