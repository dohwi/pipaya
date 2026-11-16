<script lang="ts">
	import { onMount } from "svelte";
	import { app } from "../../lib/store.svelte";
	import { t } from "../../lib/i18n";
	import { hostOf } from "../../lib/format";
	import { sessionTitle } from "../../lib/session-title";
	import { BRAND_LABEL } from "../../lib/brand";
	import { activityOf } from "../../lib/activity";
	import { formatCombo } from "../../lib/keys";
	import { toolSummary } from "../../lib/tools";
	import { graphRuns } from "../../lib/graph-runs.svelte";
	import { isMouseWheel, buildGraph, edgePath, fitView, modelName, related, type Card, type Graph, type GraphServer } from "../../lib/graph";
	import Icon from "../ui/Icon.svelte";
	import ModelLogo from "../models/ModelLogo.svelte";
	import AgentBadge from "../shell/AgentBadge.svelte";
	import GraphQuick from "./GraphQuick.svelte";

	/**
	 * The graph view: every saved server's open chats as columns (server → provider → model → chat → subagent), the lines
	 * between them moving while work flows. Drag the background to pan, a mouse wheel to zoom (a trackpad scrolls with
	 * two fingers and zooms with a pinch), a card to move it. One click on a chat opens it in a panel beside the
	 * canvas (read it, its tool calls, write to it); a double click goes to the chat itself.
	 */

	// ---- data: what every link keeps live, plus each server's delegate calls ----
	const servers = $derived<GraphServer[]>(
		app.servers.map((s) => {
			const link = app.links[s.id];
			const d = link?.data;
			return {
				id: s.id,
				name: s.name,
				host: hostOf(s.baseUrl),
				online: !!link?.online,
				sessions: d?.sessions ?? [],
				activity: (id: string) => (d ? activityOf(d, id) : "idle"),
				queued: (id: string) => d?.queued[id]?.length ?? 0,
				runs: graphRuns.runs[s.id] ?? null,
			};
		}),
	);
	$effect(() => {
		const map = new Map(app.servers.flatMap((s) => {
			const link = app.links[s.id];
			return link ? [[s.id, { api: link.api, data: link.data }] as const] : [];
		}));
		return graphRuns.follow(map);
	});

	// ---- layout: pins are cards moved by hand, kept on this device until "다시 배치" ----
	const PIN_KEY = "pipaya.graph.pins";
	const readPins = (): Record<string, { x: number; y: number }> => {
		try {
			return JSON.parse(localStorage.getItem(PIN_KEY) ?? "{}") ?? {};
		} catch {
			return {};
		}
	};
	let pins = $state(readPins());
	const savePins = () => {
		try {
			localStorage.setItem(PIN_KEY, JSON.stringify(pins));
		} catch {
			/* private mode: the pins last this visit */
		}
	};

	let measure: HTMLDivElement | undefined = $state();
	/** A card wider than its kind's width (a long model id): measured once per name on a hidden card with the real styles. */
	const widthCache = new Map<string, number>();
	function widthOf(c: Card): number {
		if (!measure || c.kind === "session") return 0;
		const key = `${c.kind}|${c.label}`;
		const hit = widthCache.get(key);
		if (hit !== undefined) return hit;
		const nm = measure.querySelector<HTMLElement>(`[data-kind="${c.kind}"]`);
		if (!nm) return 0;
		nm.textContent = c.label;
		const w = Math.ceil(nm.getBoundingClientRect().width) + 24 + 12 + 32 + 2; // mark + gap + padding + border
		widthCache.set(key, w);
		return w;
	}

	const graph: Graph = $derived(buildGraph(servers, { widths: widthOf, pins }));

	// ---- view: pan and zoom ----
	let viewEl: HTMLDivElement | undefined = $state();
	let view = $state({ k: 1, x: 24, y: 24 });
	/** Until the user pans, zooms or moves a card, the view keeps fitting the graph as it grows (the subagents arrive later). */
	let touched = false;
	/** Room the floating bar takes at the bottom of the view. */
	const BAR_H = 64;
	function fit() {
		if (viewEl) view = fitView(graph, viewEl.clientWidth, viewEl.clientHeight - BAR_H);
	}
	$effect(() => {
		void graph.width;
		void graph.height;
		if (!touched && graph.cards.size && viewEl && measure) fit();
	});
	const zoomAt = (k: number, cx: number, cy: number) => {
		touched = true;
		const nk = Math.min(2, Math.max(0.3, k));
		view = { k: nk, x: cx - ((cx - view.x) / view.k) * nk, y: cy - ((cy - view.y) / view.k) * nk };
	};
	/** One step of the zoom: a wheel notch, the +/- keys and buttons. */
	const ZOOM_STEP = 1.2;
	/** Pan just enough to bring a card fully into the canvas (the panel opening beside it narrows the canvas). */
	function reveal(id: string) {
		const c = graph.cards.get(id);
		if (!c || !viewEl) return;
		const pad = 24;
		const [l, r] = [(c.x - c.w / 2) * view.k + view.x, (c.x + c.w / 2) * view.k + view.x];
		const [t0, b0] = [(c.y - c.h / 2) * view.k + view.y, (c.y + c.h / 2) * view.k + view.y];
		const W = viewEl.clientWidth, H = viewEl.clientHeight - BAR_H;
		const dx = r > W - pad ? W - pad - r : l < pad ? pad - l : 0;
		const dy = b0 > H - pad ? H - pad - b0 : t0 < pad ? pad - t0 : 0;
		if (dx || dy) view = { ...view, x: view.x + dx, y: view.y + dy };
	}
	/** The canvas width: it narrows when the panel opens or is resized, and the open chat's card must stay in sight. */
	let viewW = $state(0);
	$effect(() => {
		const q = quick;
		if (!q || !viewW) return;
		reveal(`s:${q.server}/${q.session}`);
	});
	const zoomBy = (f: number) => viewEl && zoomAt(view.k * f, viewEl.clientWidth / 2, viewEl.clientHeight / 2);
	function wheel(e: WheelEvent) {
		e.preventDefault();
		const r = viewEl!.getBoundingClientRect();
		// a mouse wheel zooms; so does a pinch on a trackpad (it arrives as ctrl + wheel). Two fingers on a trackpad scroll.
		const [cx, cy] = [e.clientX - r.left, e.clientY - r.top];
		if (e.ctrlKey || e.metaKey) zoomAt(view.k * Math.exp(-e.deltaY / 300), cx, cy);
		// one notch, one step of the +/- buttons; units differ between browsers, the direction does not
		else if (isMouseWheel(e)) zoomAt(view.k * ZOOM_STEP ** -Math.sign(e.deltaY), cx, cy);
		else {
			touched = true;
			view = { ...view, x: view.x - e.deltaX, y: view.y - e.deltaY };
		}
	}

	// ---- pointer: pan the background, drag a card, click / double click a chat ----
	let hover = $state<string | null>(null);
	let selected = $state<string | null>(null);
	let quick = $state<{ server: string; session: string } | null>(null);
	/** card: the one being moved (mouse or pen only); tapped: the one under the pointer, which a click selects */
	let drag: { x: number; y: number; vx: number; vy: number; card: string | null; tapped: string | null; cx: number; cy: number; moved: boolean } | null = null;
	let dragging = $state<string | null>(null);
	let panning = $state(false);
	/** One click waits this long to see whether it becomes a double click. */
	const DOUBLE_MS = 250;
	let clickTimer: ReturnType<typeof setTimeout> | undefined;

	/** Fingers on the canvas: two make a pinch, which zooms about their midpoint and pans with it. */
	const fingers = new Map<number, { x: number; y: number }>();
	let pinch: { d: number; mx: number; my: number } | null = null;
	const pinchOf = () => {
		const [a, b] = [...fingers.values()];
		return { d: Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1, mx: (a!.x + b!.x) / 2, my: (a!.y + b!.y) / 2 };
	};

	const cardAt = (target: EventTarget | null) => (target as HTMLElement | null)?.closest<HTMLElement>("[data-card]")?.dataset.card ?? null;
	function down(e: PointerEvent) {
		if (e.button !== 0 || (e.target as HTMLElement).closest(".bar")) return;
		if (e.pointerType === "touch") {
			fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (fingers.size === 2) {
				// the second finger turns the drag into a pinch; nothing is clicked or moved
				drag = null;
				dragging = null;
				panning = false;
				clearTimeout(clickTimer);
				pinch = pinchOf();
				viewEl!.setPointerCapture(e.pointerId);
				return;
			}
			if (fingers.size > 2) return;
		}
		// a finger on a card pans like one on the background: on a phone the canvas is mostly cards
		const id = e.pointerType === "touch" ? null : cardAt(e.target);
		const tapped = cardAt(e.target);
		const c = id ? graph.cards.get(id) : undefined;
		drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, card: id, tapped, cx: c?.x ?? 0, cy: c?.y ?? 0, moved: false };
		try {
			viewEl!.setPointerCapture(e.pointerId);
		} catch {
			/* a pointer already gone (a synthetic or cancelled one): no capture needed */
		}
	}
	function move(e: PointerEvent) {
		if (fingers.has(e.pointerId)) fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pinch && fingers.size === 2) {
			const now = pinchOf();
			const r = viewEl!.getBoundingClientRect();
			view = { ...view, x: view.x + now.mx - pinch.mx, y: view.y + now.my - pinch.my };
			zoomAt((view.k * now.d) / pinch.d, now.mx - r.left, now.my - r.top);
			pinch = now;
			return;
		}
		if (!drag) {
			if (e.pointerType === "mouse") hover = cardAt(e.target);
			return;
		}
		if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 3) {
			drag.moved = true;
			touched = true;
			if (drag.card) dragging = drag.card;
			else panning = true;
		}
		if (!drag.moved) return;
		if (drag.card) pins = { ...pins, [drag.card]: { x: drag.cx + (e.clientX - drag.x) / view.k, y: drag.cy + (e.clientY - drag.y) / view.k } };
		else view = { ...view, x: drag.vx + e.clientX - drag.x, y: drag.vy + e.clientY - drag.y };
	}
	function up(e: PointerEvent) {
		fingers.delete(e.pointerId);
		if (pinch) {
			// the pinch ends with its first lifted finger; the other does not start a pan
			if (!fingers.size) pinch = null;
			return;
		}
		const d = drag;
		drag = null;
		panning = false;
		if (dragging) {
			dragging = null;
			savePins();
		}
		if (!d || d.moved) return;
		const c = d.tapped ? graph.cards.get(d.tapped) : undefined;
		selected = c?.id ?? null;
		if (c?.kind !== "session") return;
		clearTimeout(clickTimer);
		clickTimer = setTimeout(() => (quick = { server: c.server, session: c.session!.id }), DOUBLE_MS);
	}
	function dbl(e: MouseEvent) {
		// the canvas holds the pointer capture, so the event's target is the canvas: find the card under the pointer
		const c = graph.cards.get(cardAt(document.elementFromPoint(e.clientX, e.clientY)) ?? "");
		if (c?.kind !== "session") return;
		clearTimeout(clickTimer);
		quick = null;
		app.openIn(c.server, { session: c.session!.id });
	}
	function arrange() {
		pins = {};
		savePins();
	}
	function key(e: KeyboardEvent) {
		if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest("input, textarea, button, aside")) return;
		const c = selected ? graph.cards.get(selected) : undefined;
		if (e.key === "Escape" && (selected || quick)) {
			e.preventDefault();
			if (quick) quick = null;
			else selected = null;
		} else if (e.key === "Enter" && c?.kind === "session") {
			e.preventDefault();
			if (e.shiftKey) app.openIn(c.server, { session: c.session!.id });
			else quick = { server: c.server, session: c.session!.id };
		} else if (e.key === "f") fit();
		else if (e.key === "+" || e.key === "=") zoomBy(ZOOM_STEP);
		else if (e.key === "-") zoomBy(1 / ZOOM_STEP);
	}
	onMount(() => () => clearTimeout(clickTimer));

	// ---- focus: the cards a pointer is about stand out, the rest steps back ----
	const focus = $derived(hover && !dragging && graph.cards.has(hover) ? related(graph, hover) : null);

	// ---- text ----
	let now = $state(Date.now());
	$effect(() => {
		const id = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(id);
	});
	function ago(at: number): string {
		const sec = Math.max(0, Math.round((now - at) / 1000));
		if (sec < 60) return t("방금");
		const min = Math.floor(sec / 60);
		if (min < 60) return t("{n}분 전", { n: min });
		const hour = Math.floor(min / 60);
		if (hour < 24) return t("{n}시간 전", { n: hour });
		return t("{n}일 전", { n: Math.floor(hour / 24) });
	}
	const toolNow = (c: Card) => app.links[c.server]?.data.tool[c.session!.id];
	const summary = $derived.by(() => {
		const up = servers.filter((v) => v.online).length;
		const chats = servers.reduce((n, v) => n + v.sessions.filter((s) => !s.closed).length, 0);
		const runs = servers.reduce((n, v) => n + (v.runs?.length ?? 0), 0);
		return [
			t("서버 {n}개", { n: up === servers.length ? servers.length : `${up}/${servers.length}` }),
			t("대화 {n}개", { n: chats }),
			t("서브에이전트 위임 {n}회", { n: runs }),
		].join(" · ");
	});
	const keyHint = $derived(app.prefs.bindings.openGraph ? ` (${formatCombo(app.prefs.bindings.openGraph)})` : "");
</script>

<!-- A region the keyboard can reach: F fits, +/- zoom, Enter opens the selected chat (Shift+Enter: the chat itself). -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<section class="graph" aria-label={t("그래프 뷰")} tabindex="0" onkeydown={key}>
	<header class="head">
		<div class="ttl">
			<span class="t">{t("그래프 뷰")}</span>
			<span class="sub mono">{summary}</span>
		</div>
		<button class="close" onclick={() => app.toggleGraph(false)} aria-label={t("그래프 뷰 닫기")} title={t("그래프 뷰 닫기") + keyHint}><Icon name="x" /></button>
	</header>

	<div class="body">
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="view"
		class:panning
		bind:this={viewEl}
		bind:clientWidth={viewW}
		onpointerdown={down}
		onpointermove={move}
		onpointerup={up}
		onpointercancel={up}
		onpointerleave={() => (hover = null)}
		ondblclick={dbl}
		onwheel={wheel}
		style:background-size="{32 * view.k}px {32 * view.k}px"
		style:background-position="{view.x}px {view.y}px"
	>
		<div class="world" style:transform="translate({Math.round(view.x)}px, {Math.round(view.y)}px) scale({view.k})">
			{#if graph.bands.length > 1}
				{#each graph.bands as b (b.server)}
					<div class="band" class:down={!b.online} style:top="{b.y0 - 24}px" style:height="{b.y1 - b.y0 + 48}px" style:width="{graph.width + 48}px"></div>
				{/each}
			{/if}
			<svg class="edges" aria-hidden="true">
				<defs>
					<marker id="gv-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L8 4L0 8z" /></marker>
				</defs>
				{#each graph.edges as e (e.id)}
					{@const a = graph.cards.get(e.from)}
					{@const b = graph.cards.get(e.to)}
					{#if a && b}
						{@const on = !focus || (focus.has(e.from) && focus.has(e.to))}
						{@const d = edgePath(a, b)}
						<g class="e-{e.kind}" class:live={e.live} class:dim={!on} class:hot={!!focus && on}>
							<path class="base" {d} marker-end={e.kind === "tree" ? undefined : "url(#gv-arrow)"} style:stroke-width={e.kind === "delegate" && !e.live ? 1.25 + Math.min(2, Math.log2(e.weight) * 0.5) : undefined} />
							{#if e.live}<path class="flow" {d} />{/if}
						</g>
					{/if}
				{/each}
			</svg>
			{#each [...graph.cards.values()] as c (c.id)}
				<div
					class="card {c.kind} {c.kind === 'session' ? c.activity : ''}"
					class:down={c.kind === "server" && !c.online}
					class:run={c.kind === "subagent" && !!c.running}
					class:dim={!!focus && !focus.has(c.id)}
					class:sel={selected === c.id}
					class:dragging={dragging === c.id}
					data-card={c.id}
					style:width="{c.w}px"
					style:height="{c.h}px"
					style:transform="translate({c.x - c.w / 2}px, {c.y - c.h / 2}px)"
				>
					{#if c.kind === "server"}
						<span class="lead"><Icon name="server" /></span>
						<span class="nm">{c.label}</span>
						<span class="meta"><span>{c.host}</span><i>·</i>{#if c.online}<span>{t("대화 {n}개", { n: c.count })}</span>{:else}<em class="bad">{t("연결 안 됨")}</em>{/if}</span>
					{:else if c.kind === "provider"}
						<span class="lead"><Icon name="plug" /></span>
						<span class="nm">{c.label}</span>
						<span class="meta"><span>{t("모델 {n}개", { n: c.children.length })}</span><i>·</i><span>{t("대화 {n}개", { n: c.count })}</span></span>
					{:else if c.kind === "model"}
						<span class="lead"><ModelLogo conn={app.links[c.server]?.conn} provider={c.provider} model={c.label} size={24} colored /></span>
						<span class="nm mono">{c.label}</span>
						<span class="meta"><span>{c.brand ? BRAND_LABEL[c.brand] : c.provider}</span><i>·</i><span>{t("대화 {n}개", { n: c.count })}</span></span>
					{:else if c.kind === "subagent"}
						{@const m = c.models?.[0]}
						<span class="lead"><Icon name="bot" /></span>
						<span class="nm">{c.label}</span>
						<span class="meta">
							{#if c.running}<em class="run">{t("실행 중 {n}", { n: c.running })}</em><i>·</i>{/if}
							{#if m}
								<span class="model" title={c.models!.map((x) => `${modelName(x.model)} ${t("{n}회", { n: x.n })}`).join(" · ")}>
									<ModelLogo conn={app.links[c.server]?.conn} provider={m.model.split("/")[0]} model={modelName(m.model)} size={14} colored />
									<span class="mono">{modelName(m.model)}</span>
									{#if c.asked}<span class="pick" title={t("에이전트가 모델을 직접 골랐습니다 ({n}회)", { n: c.asked })}><Icon name="sparkles" /></span>{/if}
									{#if c.models!.length > 1}<span class="more">{t("외 {n}", { n: c.models!.length - 1 })}</span>{/if}
								</span><i>·</i>
							{/if}
							<span>{t("{n}회", { n: c.count })}</span>
							{#if c.free}<i>·</i><span title={t("역할 파일 없이 에이전트가 이름을 정한 서브에이전트입니다. 읽기 전용 도구만 쓰고 작업 내용이 곧 지침입니다")}>{t("즉석")}</span>{/if}
						</span>
					{:else}
						{@const s = c.session!}
						{@const tool = toolNow(c)}
						{@const busy = c.activity === "working" || c.activity === "asking"}
						<span class="lead"><AgentBadge id={s.id} server={c.server} state={c.activity} size={24} /></span>
						<span class="nm">{s.name ? `@${s.name}` : sessionTitle(s.title)}</span>
						{#if !busy}<span class="when">{ago(s.updatedAt)}</span>{/if}
						<span class="title">{sessionTitle(s.title)}</span>
						{#if busy}
							<span class="doing" class:ask={c.activity === "asking"}>
								{#if c.activity === "asking"}
									<Icon name="alert" /><span class="what">{t("답을 기다립니다")}</span>
								{:else if tool}
									<Icon name="bolt" /><b>{tool.name}</b><span class="what">{toolSummary(tool.name, tool.args)}</span>
								{:else}
									<Icon name="brain" /><span class="what">{t("생각 중")}</span>
								{/if}
								{#if c.queued}<span class="q" title={t("전달 대기 중인 메시지")}><Icon name="list" />{c.queued}</span>{/if}
							</span>
						{/if}
					{/if}
				</div>
			{/each}
		</div>

		{#if !graph.cards.size}
			<p class="empty">{t("저장된 서버가 없습니다")}</p>
		{/if}

		<div class="bar">
			<button class="tbtn" onclick={arrange} disabled={!Object.keys(pins).length} title={t("옮긴 카드를 제자리로")}><Icon name="columns" />{t("다시 배치")}</button>
			<span class="sep"></span>
			<button class="tbtn icon" onclick={() => zoomBy(1 / ZOOM_STEP)} aria-label={t("축소")} title={t("축소")}>−</button>
			<span class="pct mono">{Math.round(view.k * 100)}%</span>
			<button class="tbtn icon" onclick={() => zoomBy(ZOOM_STEP)} aria-label={t("확대")} title={t("확대")}><Icon name="plus" /></button>
			<button class="tbtn icon" onclick={fit} aria-label={t("전체 보기")} title={t("전체 보기 (F)")}><Icon name="expand" /></button>
		</div>
	</div>

	{#if quick}
		<!-- the chat beside the canvas: the canvas and its toolbar keep working; another chat card switches the panel -->
		<GraphQuick server={quick.server} session={quick.session} onclose={() => (quick = null)} />
	{/if}
	</div>

	<!-- hidden copies of the one-line names, to measure a long one -->
	<div class="measure" bind:this={measure} aria-hidden="true">
		{#each ["server", "provider", "model", "subagent"] as k (k)}<span class="nm" class:mono={k === "model"} data-kind={k}></span>{/each}
	</div>
</section>


<style>
	.graph {
		position: relative;
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		outline: none;
	}
	.head {
		flex: none;
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 8px 16px;
		border-bottom: 1px solid var(--border);
	}
	.ttl {
		min-width: 0;
		flex: 1;
		display: flex;
		flex-direction: column;
	}
	.ttl .t {
		font-size: var(--fs-md);
		font-weight: 600;
		line-height: 20px;
	}
	.ttl .sub {
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.close {
		flex: none;
		display: inline-grid;
		place-items: center;
		width: 32px;
		height: 32px;
		margin-right: -8px; /* the 16px glyph sits on the 16px gutter (DESIGN rule 5) */
		border-radius: var(--radius-sm);
		color: var(--text-dim);
		font-size: 16px;
	}
	@media (hover: hover) {
		.close:hover {
			background: var(--bg-hover);
			color: var(--text);
		}
	}

	/* ---- the canvas, and the chat panel beside it ---- */
	.body {
		position: relative;
		flex: 1;
		min-height: 0;
		display: flex;
	}
	.view {
		position: relative;
		flex: 1;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
		cursor: grab;
		touch-action: none;
		user-select: none;
		background-image: linear-gradient(to right, var(--grid-line) 1px, transparent 1px), linear-gradient(to bottom, var(--grid-line) 1px, transparent 1px);
	}
	.view.panning {
		cursor: grabbing;
	}
	.world {
		position: absolute;
		left: 0;
		top: 0;
		transform-origin: 0 0;
	}
	.band {
		position: absolute;
		left: -24px;
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		background: color-mix(in srgb, var(--text) 2%, transparent);
		pointer-events: none;
	}
	.band.down {
		border-style: dashed;
	}
	.empty {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		margin: 0;
		color: var(--text-faint);
		font-size: var(--fs-sm);
	}

	/* ---- lines ---- */
	.edges {
		position: absolute;
		left: 0;
		top: 0;
		width: 1px;
		height: 1px;
		overflow: visible;
		pointer-events: none;
	}
	.edges marker path {
		fill: var(--text-faint);
	}
	.edges path {
		fill: none;
		transition: stroke var(--motion-fast) var(--ease-std);
	}
	.edges g {
		transition: opacity var(--motion-fast) var(--ease-std);
	}
	.edges .base {
		stroke-width: 1.25;
		opacity: 0.55;
	}
	/* work flowing: short dashes travel from the source to the arrow head, so the direction reads without a legend */
	.edges .flow {
		stroke-width: 2;
		stroke-linecap: round;
		stroke-dasharray: 2 14;
		animation: flow 1.6s linear infinite;
		opacity: 0.9;
	}
	@keyframes flow {
		to {
			stroke-dashoffset: -16; /* one dash period (2 + 14) per loop: seamless */
		}
	}
	.e-tree path {
		stroke: var(--tree-line);
	}
	.e-tree .flow {
		animation-duration: 3.2s; /* structure: slow and quiet */
		opacity: 0.6;
	}
	.e-spawn path,
	.e-delegate path {
		stroke: var(--text-faint);
	}
	.e-spawn .base {
		stroke-width: 1.5;
	}
	.e-delegate.live path {
		stroke: var(--info);
	}
	.e-delegate.live .flow {
		stroke-width: 2.5;
		stroke-dasharray: 8 8;
		animation-duration: 0.6s;
	}
	.edges g.live .base {
		opacity: 0.8;
	}
	.edges g.dim {
		opacity: 0.15;
	}
	.edges g.dim .flow {
		animation-play-state: paused;
	}
	.edges g.hot .base {
		opacity: 1;
	}

	/* ---- cards: a 24px mark spanning two 20px lines, 12px gap, 16px inside the border (like a list card) ---- */
	.card {
		position: absolute;
		left: 0;
		top: 0;
		display: grid;
		grid-template-columns: 24px minmax(0, 1fr) auto;
		grid-template-rows: 20px 20px;
		grid-auto-rows: 40px;
		gap: 0 12px;
		align-content: start;
		align-items: center;
		padding: 15px 16px; /* 15 + the 1px border = 16 */
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		background: var(--bg);
		box-shadow: var(--shadow-soft);
		cursor: pointer;
		overflow: hidden;
		transition:
			opacity var(--motion-fast) var(--ease-std),
			border-color var(--motion-fast) var(--ease-std);
	}
	@media (hover: hover) {
		.card:hover {
			border-color: var(--text-faint);
		}
	}
	.card.dragging {
		z-index: 1;
		cursor: grabbing;
		border-color: var(--text-faint);
		box-shadow: var(--shadow);
	}
	.card.sel {
		border-color: var(--text);
		box-shadow:
			0 0 0 3px var(--accent-soft),
			var(--shadow-soft);
	}
	.card.dim {
		opacity: 0.45; /* still readable: the related cards stand out, the rest stays legible */
	}
	.lead {
		grid-row: 1 / 3;
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		font-size: 24px;
		color: var(--text-dim);
	}
	.server .lead {
		color: var(--ok);
	}
	.server.down .lead {
		color: var(--danger);
	}
	.run .lead {
		color: var(--info);
		animation: pulse var(--anim-working-duration) var(--anim-working-ease) infinite;
	}
	.nm {
		grid-column: 2;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-md);
		font-weight: 600;
		line-height: 20px;
	}
	.nm.mono {
		font-family: var(--mono);
		font-size: var(--fs-sm);
		font-weight: 500;
	}
	.meta {
		grid-column: 2 / 4;
		grid-row: 2;
		display: flex;
		align-items: center;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		font-size: var(--fs-xs);
		line-height: 20px;
		color: var(--text-faint);
	}
	.meta > * {
		flex: none;
	}
	.meta i {
		margin: 0 8px;
		font-style: normal;
		opacity: 0.6; /* a quiet dot between facts */
	}
	.meta em {
		font-style: normal;
		font-weight: 600;
	}
	.meta .bad {
		color: var(--danger);
	}
	.meta .run {
		color: var(--info);
	}
	.meta .model {
		flex: 0 1 auto; /* the model name gives way first */
		display: inline-flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
	}
	.meta .model .mono {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		font-family: var(--mono);
		color: var(--text-dim);
	}
	.meta .pick {
		flex: none;
		display: inline-grid;
		place-items: center;
		width: 14px;
		height: 14px;
		font-size: 12px;
		color: var(--warn);
	}
	.meta .more {
		flex: none;
	}

	/* a chat: name and time, its title, and while it works what it is on */
	.when {
		grid-column: 3;
		grid-row: 1;
		font-size: var(--fs-xs);
		line-height: 16px;
		color: var(--text-faint);
		white-space: nowrap;
	}
	.done .when {
		color: var(--ok); /* the time takes the logo's colour: no badge */
	}
	.failed .when {
		color: var(--danger);
	}
	.title {
		grid-column: 2 / 4;
		grid-row: 2;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-sm);
		line-height: 20px;
		color: var(--text-dim);
	}
	.doing {
		grid-column: 1 / 4;
		grid-row: 3;
		align-self: end;
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		height: 28px;
		padding: 0 8px;
		border-radius: var(--radius-sm);
		background: var(--bg-set);
		font-family: var(--mono);
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-faint);
	}
	.doing > :global(.ic) {
		flex: none;
		font-size: 14px;
		color: var(--info);
		animation: pulse var(--anim-working-duration) var(--anim-working-ease) infinite;
	}
	.doing.ask > :global(.ic) {
		color: var(--warn);
	}
	.doing b {
		flex: none;
		font-weight: 600;
		color: var(--text-dim);
	}
	.doing .what {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.doing .q {
		margin-left: auto;
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-weight: 600;
		color: var(--text-dim);
	}
	.doing .q :global(.ic) {
		font-size: 12px;
		color: var(--text-faint);
	}
	@keyframes pulse {
		50% {
			opacity: var(--anim-working-dim);
		}
	}

	/* ---- the floating bar ---- */
	.bar {
		position: absolute;
		right: 16px;
		bottom: 16px;
		z-index: 2;
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 4px;
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--bg-elev);
		box-shadow: var(--shadow-soft);
		cursor: default;
	}
	.bar .sep {
		width: 1px;
		height: 20px;
		margin: 0 4px;
		background: var(--border);
	}
	.tbtn {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		height: 32px;
		padding: 0 12px 0 8px;
		border-radius: var(--radius-sm);
		color: var(--text-dim);
		font-size: var(--fs-xs);
		font-weight: 600;
		line-height: 16px;
	}
	.tbtn.icon {
		width: 32px;
		padding: 0;
		justify-content: center;
		font-size: 16px;
	}
	.tbtn :global(.ic) {
		font-size: 16px;
	}
	@media (hover: hover) {
		.tbtn:hover:not(:disabled) {
			background: var(--bg-hover);
			color: var(--text);
		}
	}
	.tbtn:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.pct {
		min-width: 44px;
		text-align: center;
		font-size: var(--fs-2xs);
		color: var(--text-dim);
	}

	.measure {
		position: absolute;
		left: -9999px;
		top: 0;
		visibility: hidden;
		pointer-events: none;
	}
	.measure .nm {
		display: inline-block;
		overflow: visible;
	}
	@media (prefers-reduced-motion: reduce) {
		.edges .flow,
		.run .lead,
		.doing > :global(.ic) {
			animation: none;
		}
	}
</style>
