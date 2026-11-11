<script lang="ts">
	import { abortable } from "../../lib/abortable";
	import { localeTag, t } from "../../lib/i18n";
	import { app } from "../../lib/store.svelte";
	import { extensions } from "../../lib/extensions/host.svelte";
	import { compact } from "../../lib/format";
	import type { AssistantItem } from "../../lib/types";
	import StatusItem from "./StatusItem.svelte";
	import SessionContext from "./SessionContext.svelte";
	import { getPane } from "../../lib/pane";
	import { visibleFooter } from "../../lib/footer-prefs";
	import { cacheLevel, contextLevel, speedLevel } from "../../lib/status-level";

	const pane = getPane();
	const chat = $derived(app.chatOf(pane.id));

	// Live call statistics come from the transcript; server context and billing totals also include compaction.
	const calls = $derived(
		(chat?.items ?? []).filter((i): i is AssistantItem => i.kind === "assistant" && !i.streaming && (i.usage?.totalTokens ?? 0) > 0),
	);
	const last = $derived(calls[calls.length - 1]);

	// Number of entries in the context panel: the system prompt plus every applied AGENTS.md.
	// Servers without the endpoint (or a failed lookup) simply hide the item.
	type Loaded = { key: string; files: string[] };
	let loaded = $state<Loaded | null>(null);
	let openKey = $state<string | null>(null);
	// Narrow pane: the count items (AGENTS.md, skills, MCP, roles, commands) stay folded behind one button until it is pressed.
	let expanded = $state(false);
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
			ok: (r) => (loaded = { key, files: r.instructions.map(i => i.path) }),
			fail: () => { if (loaded?.key === key) loaded = null; },
		});
	});
	$effect(() => { if (openKey !== ctxKey) openKey = null; });

	// Skills the model is offered in the project (the conversation's folder, else the chosen one): the project's settings, not a
	// conversation's frozen set, so the count matches the "this project" tab of the skills dialog.
	let fresh = $state<{ key: string; names: string[] } | null>(null);
	const skillsCwd = $derived((pane.id ? app.session(pane.id)?.cwd : null) || app.workdirAbs);
	const cwdKey = $derived(`${app.serverId}:${skillsCwd}`);
	$effect(() => {
		const key = cwdKey;
		const cwd = skillsCwd;
		const api = app.api;
		app.skillsTick;
		if (!api) return;
		return abortable((signal) => api.skills(cwd, signal), {
			ok: (r) => (fresh = { key, names: r.skills.filter(k => projectOn(k) && k.modelInvocable).map(k => k.name) }),
			fail: () => { if (fresh?.key === key) fresh = null; },
		});
	});
	const projectOn = (k: { override: boolean | null; globalEnabled: boolean }) => k.override ?? k.globalEnabled;
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
	// MCP servers connected to this server and the tools they add. Shown dimmed when none is connected, like the other items.
	let mcp = $state<{ key: string; ready: number; tools: number; failed: number; total: number } | null>(null);
	$effect(() => {
		const key = app.serverId ?? "";
		const api = app.api;
		app.mcpTick;
		if (!api) return;
		return abortable((signal) => api.mcp(signal), {
			ok: (r) => (mcp = { key, ready: r.ready, tools: r.tools, failed: r.servers.filter(s => s.status === "error").length, total: r.servers.length }),
			fail: () => { if (mcp?.key === key) mcp = null; },
		});
	});
	const mcpHere = $derived(mcp && mcp.key === (app.serverId ?? "") ? mcp : null);
	const mcpTip = $derived(
		mcpHere
			? [
					mcpHere.total ? t("연결된 MCP 서버 {n}개 · 도구 {tools}개", { n: mcpHere.ready, tools: mcpHere.tools }) : t("등록된 MCP 서버가 없습니다"),
					mcpHere.failed ? t("연결에 실패한 서버 {n}개", { n: mcpHere.failed }) : "",
					t("눌러서 관리"),
				].filter(Boolean).join("\n")
			: "",
	);
	// Helper roles `delegate` can start here: the global ones plus the ones in this conversation's folder. Hidden while the
	// `delegate` tool is off (nothing could start them); dimmed when there are none, like the other items.
	let roles = $state<{ key: string; global: string[]; project: string[] } | null>(null);
	const rolesCwd = $derived((pane.id ? app.session(pane.id)?.cwd : null) || app.workdirAbs);
	const rolesKey = $derived(`${app.serverId}:${rolesCwd}`);
	$effect(() => {
		const key = rolesKey;
		const cwd = rolesCwd;
		const api = app.api;
		app.skillsTick; // role files are watched with the skills, so a change on disk (or from another client) bumps this
		if (!api) return;
		return abortable((signal) => api.subagents(cwd, signal), {
			ok: (r) => (roles = { key, global: r.subagents.filter(d => d.enabled && d.scope === "global" && !d.overridden).map(d => d.name), project: r.subagents.filter(d => d.enabled && d.scope === "project").map(d => d.name) }),
			fail: () => { if (roles?.key === key) roles = null; },
		});
	});
	const rolesHere = $derived(roles && roles.key === rolesKey && !(app.toolsInfo?.disabled ?? []).includes("delegate") ? roles : null);
	const rolesCount = $derived(rolesHere ? rolesHere.global.length + rolesHere.project.length : 0);
	const rolesTip = $derived(
		rolesHere
			? [
					rolesCount ? t("도우미 역할 {n}개 (전역 {g} · 프로젝트 {p})", { n: rolesCount, g: rolesHere.global.length, p: rolesHere.project.length }) : t("등록된 도우미 역할이 없습니다."),
					rolesHere.project.length ? `${t("프로젝트")}: ${list(rolesHere.project)}` : "",
					rolesHere.global.length ? `${t("전역")}: ${list(rolesHere.global)}` : "",
					t("눌러서 관리"),
				].filter(Boolean).join("\n")
			: "",
	);
	const skillNames = $derived(fresh && fresh.key === cwdKey ? fresh.names : null);
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
					t("이 프로젝트에서 쓰는 스킬 {n}개", { n: skillNames.length }),
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

	const footer = $derived(app.prefs.footer);
	const visible = $derived(visibleFooter(footer));
	// Whether any folded count item exists at all (otherwise the "more" button would open nothing).
	const hasMore = $derived(
		visible.some((id) => (id === "agents" && !!ctxFiles) || (id === "skills" && !!skillCount) || (id === "mcp" && !!mcpHere && (mcpHere.ready > 0 || mcpHere.failed > 0)) || (id === "roles" && rolesCount > 0) || (id === "commands" && !!tplNames?.length)),
	);

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
<div class="statusline mono" data-part="statusline" data-layout={footer.layout} data-align={footer.align} data-expanded={expanded} role="group" aria-label={t("세션 통계")}>
	{#each extensions.statuses as item (`${item.owner}:${item.id}`)}
		<StatusItem title={item.owner}>{item.text}</StatusItem>
	{/each}
	{#each visible as id (id)}
		{#if id === "elapsed"}
			{#if elapsed}
				<StatusItem icon="clock" label={t("작업 경과 시간 {v}", { v: elapsed })} title={t("작업 경과 시간")}>{elapsed}</StatusItem>
			{/if}
		{:else if id === "agents"}
			{#if ctxFiles}
				<StatusItem more icon="prompt" empty={ctxFiles === 0} onclick={() => (openKey = ctxKey)} label={t("AGENTS.md {n}개", { n: ctxFiles })} title={filesTip}>{t("{n}개", { n: ctxFiles })}</StatusItem>
			{/if}
		{:else if id === "skills"}
			{#if skillCount}
				<StatusItem more icon="skill" empty={skillCount === 0} onclick={() => app.openSkills(pane.id)} label={t("스킬 {n}개", { n: skillCount })} title={skillsTip}>{t("{n}개", { n: skillCount })}</StatusItem>
			{/if}
		{:else if id === "mcp"}
			{#if mcpHere && (mcpHere.ready > 0 || mcpHere.failed > 0)}
				<StatusItem more icon="plug" empty={mcpHere.ready === 0 && !mcpHere.failed} level={mcpHere.failed > 0 ? "danger" : ""} onclick={() => app.openMcp()} label={t("MCP 서버 {n}개", { n: mcpHere.ready })} title={mcpTip}>{t("{n}개", { n: mcpHere.ready })}</StatusItem>
			{/if}
		{:else if id === "roles"}
			{#if rolesHere && rolesCount > 0}
				<StatusItem more icon="bot" empty={rolesCount === 0} onclick={() => app.openSubagents(pane.id)} label={t("도우미 역할 {n}개", { n: rolesCount })} title={rolesTip}>{t("{n}개", { n: rolesCount })}</StatusItem>
			{/if}
		{:else if id === "commands"}
			{#if tplNames && tplNames.length > 0}
				<StatusItem more icon="list" empty={tplNames.length === 0} onclick={() => app.openCommands(pane.id)} label={t("확장 명령 {n}개", { n: tplNames.length })} title={tplTip}>{t("{n}개", { n: tplNames.length })}</StatusItem>
			{/if}
		{:else if id === "context"}
			<!-- Shown even before there is a figure ("—"), so the line does not jump when the first reply arrives. -->
			<StatusItem level={level} empty={ctx === null} label={t("컨텍스트 사용량 {v}", { v: ctx === null ? t("측정 전") : win ? `${pct(ctxPct)}%` : compact(ctx) })} title={ctxTip}>
				{#snippet mark()}
					<svg class="ring" viewBox="0 0 18 18" aria-hidden="true">
						<circle cx="9" cy="9" r="7" class="track" />
						<circle cx="9" cy="9" r="7" class="fill" stroke-dasharray={ring} stroke-dashoffset={ring * (1 - Math.min(100, ctxPct) / 100)} />
					</svg>
				{/snippet}
				{ctx === null ? "—" : win ? `${pct(ctxPct)}%` : compact(ctx)}
			</StatusItem>
		{:else if id === "cache"}
			<StatusItem icon="cache" level={hitLevel} empty={hit === null} label={t("캐시 적중률 {v}", { v: hit === null ? t("측정 전") : `${pct(hit)}%` })} title={hitTip}>{hit === null ? "—" : `${pct(hit)}%`}</StatusItem>
		{:else if id === "speed"}
			<StatusItem icon="gauge" level={tpsLevel} empty={tps === null} unit="tps" label={t("출력 속도 {v}", { v: tps === null ? t("측정 전") : `${speed(tps)} tps` })} title={tpsTip}>{tps === null ? "—" : speed(tps)}</StatusItem>
		{/if}
	{/each}
	{#if hasMore}<button class="morebtn" type="button" aria-expanded={expanded} aria-label={expanded ? t("부가 항목 접기") : t("부가 항목 더보기")} onclick={() => (expanded = !expanded)}>{expanded ? "−" : "⋯"}</button>{/if}
</div>

{#if openKey && openKey === ctxKey && app.api}
	{#key openKey}
		<SessionContext sessionId={pane.id} cwd={app.workdirAbs} api={app.api} onclose={() => (openKey = null)} />
	{/key}
{/if}

<style>
	/* Plain text and icons under the input: no pills. Only the context ring turns amber/red as it fills. Items are StatusItem. */
	.statusline {
		display: flex;
		justify-content: center;
		align-items: center;
		column-gap: 12px;
		row-gap: 4px;
		min-height: 26px;
		flex-wrap: wrap;
		padding: 8px 16px 0; /* the same 16px column as the messages and the composer */
		font-size: var(--fs-xs); /* 12px: 11px was unreadable on a phone */
		line-height: 16px;
		color: var(--text-dim); /* 4.5:1 or better on the page in both themes (the old faint grey was 2.3 to 2.7) */
		user-select: none;
	}
	.morebtn {
		display: none;
		min-width: 24px;
		height: 24px;
		padding: 0 4px;
		border-radius: var(--radius-sm);
		font: inherit;
		line-height: 16px;
		color: inherit;
		flex: none;
		/* "⋯" sits on the math axis, above the box's centre: measured at 4x its ink was 0.62px high; the 1px moves it down
		   onto the row the items' values sit on (scripts/ui-ink.py, morebtn) */
		padding-top: 1px;
	}
	.morebtn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.statusline :global(.ring) {
		width: 13px;
		height: 13px;
		transform: rotate(-90deg);
		flex: none;
	}
	.statusline :global(.ring circle) {
		fill: none;
		stroke-width: 2.2;
	}
	.statusline :global(.ring .track) {
		stroke: color-mix(in srgb, currentColor 25%, transparent);
	}
	.statusline :global(.ring .fill) {
		stroke: currentColor;
		stroke-linecap: round;
		transition: stroke-dashoffset var(--motion-slow) var(--ease);
	}
	.statusline[data-align="start"] {
		justify-content: flex-start;
	}
	/* One row that scrolls sideways instead of wrapping: wrapping makes the composer jump when an item appears (`safe` keeps the first item reachable). */
	.statusline[data-layout="scroll"] {
		flex-wrap: nowrap;
		justify-content: safe center;
		overflow-x: auto;
		overflow-y: hidden;
		scrollbar-width: none;
	}
	.statusline[data-layout="scroll"][data-align="start"] {
		justify-content: flex-start;
	}
	.statusline[data-layout="scroll"]::-webkit-scrollbar {
		display: none;
	}
	.statusline[data-layout="scroll"] > :global(*) {
		flex: none;
	}
	/* narrow pane: tighter spacing, and one row only. Wrapping made the composer jump when a status was added; what does not
	   fit scrolls sideways instead (`safe` keeps the first item reachable when the row overflows). */
	@container (max-width: 600px) {
		.statusline :global(.more) {
			display: none;
		}
		.statusline[data-expanded="true"] :global(.more) {
			display: inline-flex;
		}
		.statusline[data-expanded="true"] {
			flex-wrap: wrap;
		}
		.morebtn {
			display: inline-flex;
			align-items: center;
			justify-content: center;
		}
	}
	@container (max-width: 420px) {
		.statusline {
			column-gap: 8px;
			padding: 4px 16px 0;
		}
		.statusline[data-layout="auto"] {
			flex-wrap: nowrap;
			justify-content: safe center;
			overflow-x: auto;
			overflow-y: hidden;
			scrollbar-width: none;
		}
		.statusline[data-layout="auto"][data-align="start"] {
			justify-content: flex-start;
		}
		.statusline[data-layout="auto"]::-webkit-scrollbar {
			display: none;
		}
		.statusline[data-layout="auto"] > :global(*) {
			flex: none;
		}
		.statusline :global(.ring) {
			width: 11px;
			height: 11px;
		}
	}
</style>
