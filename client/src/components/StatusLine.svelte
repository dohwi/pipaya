<script lang="ts">
	import { abortable } from "../lib/abortable";
	import { localeTag, t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import { extensions } from "../lib/extensions/host.svelte";
	import { compact } from "../lib/format";
	import type { AssistantItem } from "../lib/types";
	import Icon from "./Icon.svelte";
	import SessionContext from "./SessionContext.svelte";
	import { getPane } from "../lib/pane";
	import { cacheLevel, contextLevel, speedLevel } from "../lib/status-level";

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
	// A conversation reads its own context; a new chat previews what the chosen directory will get.
	const ctxKey = $derived(pane.id ? `${app.serverId}:${pane.id}` : `${app.serverId}:new:${app.workdirAbs}`);
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
		const cwd = app.workdirAbs;
		if (!api) return;
		return abortable((signal) => (id ? api.sessionContext(id, signal) : api.previewContext(cwd, signal)), {
			ok: (r) => (loaded = { key, files: r.instructions.map(i => i.path), skills: r.skills.map(k => k.name) }),
			fail: () => { if (loaded?.key === key) loaded = null; },
		});
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
		return abortable((signal) => api.skills(app.workdirAbs, signal), {
			ok: (r) => (fresh = { key, names: r.skills.filter(k => k.enabled && k.modelInvocable).map(k => k.name) }),
			fail: () => { if (fresh?.key === key) fresh = null; },
		});
	});
	// Commands server extensions offer as /prefix:name in the chosen directory (the open chat's, else the new-chat one).
	let tpl = $state<{ key: string; names: string[] } | null>(null);
	const tplCwd = $derived((pane.id ? app.session(pane.id)?.cwd : null) || app.workdirAbs);
	const tplKey = $derived(`${app.serverId}:${tplCwd}`);
	$effect(() => {
		const key = tplKey;
		const cwd = tplCwd;
		const api = app.api;
		app.skillsTick;
		app.serverExtensionsTick;
		chat?.items.length;
		if (!api) return;
		return abortable((signal) => api.commandFamilies(cwd, signal), {
			// Shown even when empty (dimmed), like the other items, so the line keeps its shape.
			ok: (r) => (tpl = { key, names: r.families.flatMap(f => f.entries.map(e => `/${f.prefix}:${e.name}`)) }),
			fail: () => { if (tpl?.key === key) tpl = null; },
		});
	});
	const tplNames = $derived(tpl && tpl.key === tplKey ? tpl.names : null);
	const list = (items: string[], max = 8) => items.slice(0, max).join(", ") + (items.length > max ? ` ${t("외 {n}개", { n: items.length - max })}` : "");
	const tplTip = $derived(
		tplNames
			? [
					t("사용할 수 있는 확장 명령 {n}개", { n: tplNames.length }),
					tplNames.length ? list(tplNames) : t("이 폴더에서 쓸 수 있는 확장 명령이 없습니다."),
					t("눌러서 목록 보기"),
				].join("\n")
			: "",
	);
	const skillNames = $derived(pane.id ? (here ? here.skills : null) : (fresh && fresh.key === cwdKey ? fresh.names : null));
	const skillCount = $derived(skillNames ? skillNames.length : null);
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
	// No server figure (the session's model is gone): fall back to the last call's usage. Explicit null must NOT resurrect pre-compaction usage.
	const estimated = $derived(context === undefined);
	const ctx = $derived(estimated ? (last?.usage?.totalTokens ?? null) : context!.tokens);
	const ctxPct = $derived(win && ctx !== null ? (ctx / win) * 100 : 0);

	const sum = $derived.by(() => {
		const acc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		for (const c of calls) {
			const u = c.usage!;
			acc.input += u.input;
			acc.output += u.output;
			acc.cacheRead += u.cacheRead ?? 0;
			acc.cacheWrite += u.cacheWrite ?? 0;
		}
		return acc;
	});
	// Share of prompt tokens served from the provider's cache.
	const totals = $derived(chat?.usage && chat.usage.turns >= calls.length ? chat.usage : sum);
	const prompt = $derived(totals.input + totals.cacheRead + totals.cacheWrite);
	const hit = $derived(prompt > 0 ? (totals.cacheRead / prompt) * 100 : null);

	const tps = $derived(last?.durationMs && last.usage && last.usage.output > 0 ? last.usage.output / (last.durationMs / 1000) : null);

	// Elapsed time of the current run, ticking once a second while the agent works.
	let now = $state(Date.now());
	const startedAt = $derived(chat?.running ? (chat.runStartedAt ?? null) : null);
	$effect(() => {
		if (startedAt === null) return;
		now = Date.now();
		const timer = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(timer);
	});
	const clock = (ms: number) => {
		const s = Math.floor(ms / 1000);
		const m = Math.floor(s / 60);
		const h = Math.floor(m / 60);
		const two = (n: number) => String(n).padStart(2, "0");
		return h > 0 ? `${h}:${two(m % 60)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
	};
	const elapsed = $derived(startedAt === null ? "" : clock(Math.max(0, now - startedAt)));

	const ring = 2 * Math.PI * 7;
	const level = $derived(ctx === null || !win ? "" : contextLevel(ctxPct));
	const hitLevel = $derived(cacheLevel(hit, calls.length));
	const tpsLevel = $derived(speedLevel(tps));
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
			? t("캐시 적중률 · 응답 후 표시됩니다")
			: [t("캐시 적중률 {n}%", { n: pct(hit) }), t("프롬프트 {prompt} 토큰 중 {read} 토큰을 캐시에서 읽었습니다", { prompt: prompt.toLocaleString(localeTag()), read: totals.cacheRead.toLocaleString(localeTag()) })].join("\n"),
	);
	const tpsTip = $derived(tps === null ? t("출력 속도 · 응답 후 표시됩니다") : t("출력 속도 {n} 토큰/초 (마지막 응답)", { n: tps.toFixed(1) }));
	const speed = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));
</script>

<!-- Reserve room before the first reply; allow narrow screens to wrap without clipping. -->
<div class="statusline mono" data-part="statusline" aria-label={t("세션 통계")}>
	{#each extensions.statuses as item (`${item.owner}:${item.id}`)}
		<span class="b" title={item.owner}>{item.text}</span>
	{/each}
	{#if elapsed}
		<span class="b elapsed" title={t("작업 경과 시간")}>
			<Icon name="clock" />
			<span class="v">{elapsed}</span>
		</span>
	{/if}
	{#if ctxFiles !== null}
		<button class="b files hit" class:empty={ctxFiles === 0} onclick={() => (openKey = ctxKey)} aria-haspopup="dialog" aria-label={t("AGENTS.md {n}개", { n: ctxFiles })} title={filesTip}>
			<Icon name="prompt" />
			<span class="v">{t("{n}개", { n: ctxFiles })}</span>
		</button>
	{/if}
	{#if skillCount !== null}
		<button class="b skills hit" class:empty={skillCount === 0} onclick={() => app.openSkills(pane.id)} aria-haspopup="dialog" aria-label={t("스킬 {n}개", { n: skillCount })} title={skillsTip}>
			<Icon name="skill" />
			<span class="v">{t("{n}개", { n: skillCount })}</span>
		</button>
	{/if}
	{#if tplNames !== null}
		<button class="b commands hit" class:empty={tplNames.length === 0} onclick={() => app.openCommands(pane.id)} aria-haspopup="dialog" aria-label={t("확장 명령 {n}개", { n: tplNames.length })} title={tplTip}>
			<Icon name="list" />
			<span class="v">{t("{n}개", { n: tplNames.length })}</span>
		</button>
	{/if}
	<!-- Always shown, so the line does not jump when the first reply arrives; "—" until there is a figure. -->
	<span class="b ctx {level}" class:empty={ctx === null} title={ctxTip}>
			<svg class="ring" viewBox="0 0 18 18" aria-hidden="true">
				<circle cx="9" cy="9" r="7" class="track" />
				<circle cx="9" cy="9" r="7" class="fill" stroke-dasharray={ring} stroke-dashoffset={ring * (1 - Math.min(100, ctxPct) / 100)} />
			</svg>
			<span class="v">{ctx === null ? "—" : win ? `${pct(ctxPct)}%` : compact(ctx)}</span>
	</span>
	<span class="b hit {hitLevel}" class:empty={hit === null} title={hitTip}>
		<Icon name="cache" />
		<span class="v">{hit === null ? "—" : `${pct(hit)}%`}</span>
	</span>
	<span class="b tps {tpsLevel}" class:empty={tps === null} title={tpsTip}>
		<Icon name="gauge" />
		<span class="v">{tps === null ? "—" : speed(tps)}</span><span class="unit wide">tps</span>
	</span>
</div>

{#if openKey && openKey === ctxKey && app.api}
	{#key openKey}
		<SessionContext sessionId={pane.id} cwd={app.workdirAbs} api={app.api} onclose={() => (openKey = null)} />
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
	@media (max-width: 640px) {
		.wide {
			display: none;
		}
	}
	/* narrow pane: tighter spacing and smaller type so the line stays on as few rows as possible */
	@container (max-width: 420px) {
		.statusline {
			column-gap: 10px;
			padding: 6px 6px 0;
			font-size: var(--fs-2xs);
		}
		.b {
			gap: 3px;
		}
		.b :global(svg:not(.ring)),
		.ring {
			width: 11px;
			height: 11px;
		}
		.wide {
			display: none;
		}
	}
</style>
