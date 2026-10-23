<script module lang="ts">
	let seq = 0;
	// Only one detail popover may be visible at a time.
	let closeActive: (() => void) | null = null;
</script>

<script lang="ts">
	import { t } from "../../lib/i18n";
	import type { UIGaugeNode } from "../../lib/extensions/ui";
	let { node }: { node: UIGaugeNode } = $props();

	const WIDTH = 2.4;
	const FIRST = 16;
	const STEP = 3.4;
	const NAMED = new Set(["accent", "ok", "warn", "danger"]);

	const rings = $derived(node.rings.map((ring, index) => {
		const max = ring.max ?? 100;
		const known = ring.value !== null;
		const ratio = known ? Math.min(Math.max(ring.value! / max, 0), 1) : 0;
		const color = ring.color ?? "accent";
		return {
			radius: FIRST - index * STEP,
			known,
			dash: `${(ratio * 100).toFixed(3)} 100`,
			named: NAMED.has(color) ? color : "",
			hex: NAMED.has(color) ? undefined : color,
			label: ring.label ?? node.label,
			max,
			value: ring.value,
			text: known ? `${Math.round(ratio * 100)}%` : t("알 수 없음"),
		};
	}));
	const innerRadius = $derived(rings.at(-1)!.radius);
	// Largest square that fits inside the innermost ring, centred.
	const iconSide = $derived((innerRadius - WIDTH / 2 - 1.5) * 1.4142);
	const iconPos = $derived(18 - iconSide / 2);
	// Unknown is already shown by the dashed ring; the dash text is only a fallback when there is no popover.
	const display = $derived(node.display ?? (rings[0]!.known || node.details ? "" : "—"));
	const staleText = () => t("오래된 데이터");
	const unknownText = () => t("확인 불가");
	const details = $derived(node.details);
	// "N초 전 업데이트됨": ticks once a second, but only while the popover is open.
	let now = $state(Date.now());
	const updatedAt = $derived(details?.updatedAt);
	function ago(ms: number): string {
		const sec = Math.floor(Math.max(0, ms) / 1000);
		if (sec < 60) return t("{n}초 전", { n: sec });
		const min = Math.floor(sec / 60);
		if (min < 60) return t("{n}분 전", { n: min });
		const hour = Math.floor(min / 60);
		return hour < 24 ? t("{n}시간 전", { n: hour }) : t("{n}일 전", { n: Math.floor(hour / 24) });
	}
	const updatedText = $derived(updatedAt === undefined ? "" : t("{ago} 업데이트됨", { ago: ago(now - updatedAt) }));
	const rows = $derived((details?.rows ?? []).map((row, index, all) => {
		const max = row.max ?? 100;
		const known = row.value !== null;
		const ratio = known ? Math.min(Math.max(row.value! / max, 0), 1) : 0;
		const color = row.color ?? "accent";
		return {
			heading: row.group !== undefined && row.group !== all[index - 1]?.group ? row.group : undefined,
			label: row.label,
			caption: row.caption,
			known,
			percent: (ratio * 100).toFixed(2),
			text: known ? `${Math.round(ratio * 100)}%` : unknownText(),
			named: NAMED.has(color) ? color : "",
			hex: NAMED.has(color) ? undefined : color,
		};
	}));
	// With details the rich popover replaces the native tooltip to avoid a double tooltip.
	const title = $derived(details ? undefined : [node.hint, node.stale ? staleText() : ""].filter(Boolean).join(" · ") || undefined);
	const summary = $derived(rows.map((r) => `${r.label}: ${r.text}${r.caption ? ` (${r.caption})` : ""}`).join(", "));
	const description = $derived([node.hint, node.stale && updatedAt === undefined ? staleText() : "", details ? [details.title, summary].filter(Boolean).join(": ") : ""].filter(Boolean).join(". ") || undefined);
	const size = $derived(node.size ?? "small");

	const popId = `gauge-detail-${++seq}`;
	const OPEN_DELAY = 80;
	const CLOSE_DELAY = 120;
	const MARGIN = 8;
	const GAP = 6;
	let gaugeEl = $state<HTMLElement>();
	let popEl = $state<HTMLElement>();
	let open = $state(false);
	let placement = $state<"below" | "above">("below");
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pointerDown = false;

	function clear() {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	}
	function show() {
		clear();
		if (!details || open) return;
		if (closeActive && closeActive !== hide) closeActive();
		closeActive = hide;
		open = true;
	}
	function hide() {
		clear();
		open = false;
		if (closeActive === hide) closeActive = null;
	}
	function later(action: () => void, delay: number) {
		clear();
		timer = setTimeout(action, delay);
	}
	function place() {
		if (!gaugeEl || !popEl) return;
		const rect = gaugeEl.getBoundingClientRect();
		const vw = document.documentElement.clientWidth;
		const vh = window.innerHeight;
		const width = popEl.offsetWidth;
		const height = popEl.offsetHeight;
		const left = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, MARGIN), Math.max(MARGIN, vw - width - MARGIN));
		const below = rect.bottom + GAP;
		const above = rect.top - GAP - height;
		const fitsBelow = below + height <= vh - MARGIN;
		const flip = !fitsBelow && (above >= MARGIN || rect.top > vh - rect.bottom);
		placement = flip ? "above" : "below";
		const top = flip ? Math.max(MARGIN, above) : below;
		popEl.style.left = `${Math.round(left)}px`;
		popEl.style.top = `${Math.round(top)}px`;
		popEl.style.maxHeight = `${Math.max(80, vh - top - MARGIN)}px`;
		popEl.style.visibility = "visible";
	}
	// Move the popover out of the navbar slot so its overflow/transform cannot clip or offset it. Inside a modal
	// <dialog> (extension screen) it must live in that dialog: the dialog is in the top layer, so nothing in <body> can
	// be drawn above it whatever its z-index.
	function portal(el: HTMLElement) {
		(gaugeEl?.closest("dialog") ?? document.body).appendChild(el);
		return { destroy: () => el.remove() };
	}
	$effect(() => {
		if (!open || updatedAt === undefined) return;
		now = Date.now();
		const id = setInterval(() => { now = Date.now(); }, 1000);
		return () => clearInterval(id);
	});
	$effect(() => {
		if (!open || !popEl) return;
		place();
		const dismiss = () => hide();
		const onScroll = (event: Event) => { if (!popEl?.contains(event.target as Node)) hide(); };
		const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };
		const onOutside = (event: PointerEvent) => {
			const target = event.target as Node;
			if (!gaugeEl?.contains(target) && !popEl?.contains(target)) hide();
		};
		window.addEventListener("resize", dismiss);
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("keydown", onKey);
		window.addEventListener("pointerdown", onOutside, true);
		return () => {
			window.removeEventListener("resize", dismiss);
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("pointerdown", onOutside, true);
		};
	});
	$effect(() => {
		if (!details && open) hide();
	});
	$effect(() => () => hide());

	const hovering = (event: PointerEvent) => event.pointerType !== "touch";
	function onEnter(event: PointerEvent) { if (hovering(event)) later(show, OPEN_DELAY); }
	function onLeave(event: PointerEvent) { if (hovering(event)) later(hide, CLOSE_DELAY); }
	function onPointerDown(event: PointerEvent) {
		pointerDown = true;
		if (event.pointerType === "touch" && details) {
			if (open) hide();
			else show();
		}
	}
	function onFocus() {
		// Pointer-driven focus is handled by hover/tap; only keyboard focus opens here.
		if (!pointerDown) show();
	}
	function onBlur() {
		pointerDown = false;
		later(hide, CLOSE_DELAY);
	}
</script>

<!-- A read-only gauge with a tooltip or details popover is focusable so keyboard users can reach it. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	bind:this={gaugeEl}
	class="gauge size-{size}"
	class:stale={node.stale}
	role="group"
	aria-label={node.label}
	{...{ "aria-description": description }}
	aria-describedby={open ? popId : undefined}
	{title}
	tabindex={title || details ? 0 : undefined}
	onpointerenter={onEnter}
	onpointerleave={onLeave}
	onpointerdown={onPointerDown}
	onpointerup={() => setTimeout(() => { pointerDown = false; }, 0)}
	onfocus={onFocus}
	onblur={onBlur}
>
	<div class="circle">
		<svg class="rings" viewBox="0 0 36 36" aria-hidden="true" focusable="false">
			{#each rings as ring}
				<circle class="track" cx="18" cy="18" r={ring.radius} />
				{#if ring.known}
					<circle class="arc {ring.named}" cx="18" cy="18" r={ring.radius} pathLength="100" style:stroke={ring.hex} stroke-dasharray={ring.dash} />
				{:else}
					<circle class="unknown" cx="18" cy="18" r={ring.radius} />
				{/if}
			{/each}
			{#if node.icon}
				<svg x={iconPos} y={iconPos} width={iconSide} height={iconSide} viewBox={node.icon.viewBox} class="glyph">
					{#each node.icon.paths as path}
						<path d={path.d} fill={path.fill ?? "currentColor"} fill-rule={path.fillRule ?? "nonzero"} />
					{/each}
				</svg>
			{/if}
		</svg>
		{#if node.stale}<span class="badge" aria-hidden="true">!</span>{/if}
		{#each rings as ring}
			<span
				class="sr-only"
				role="progressbar"
				aria-label={ring.label}
				aria-valuemin="0"
				aria-valuemax={ring.max}
				aria-valuenow={ring.known ? ring.value : undefined}
				aria-valuetext={ring.text}
			></span>
		{/each}
	</div>
	{#if display}<span class="display" aria-hidden="true">{display}</span>{/if}
</div>


{#if open && details}
	<div
		use:portal
		bind:this={popEl}
		id={popId}
		class="popover {placement}"
		role="tooltip"
		style="visibility: hidden"
		onpointerenter={() => clear()}
		onpointerleave={onLeave}
	>
		{#if details.title}<div class="pop-title">{details.title}</div>{/if}
		{#if node.stale && updatedAt === undefined}<div class="pop-stale">{staleText()}</div>{/if}
		{#each rows as row}
			{#if row.heading}<div class="pop-group">{row.heading}</div>{/if}
			<div class="pop-row">
				<div class="pop-line">
					<span class="pop-label">{row.label}</span>
					<span class="pop-value" class:unknown={!row.known}>{row.text}</span>
				</div>
				<div class="pop-track" class:unknown={!row.known}>
					{#if row.known}<div class="pop-fill {row.named}" style:width="{row.percent}%" style:background={row.hex}></div>{/if}
				</div>
				{#if row.caption}<div class="pop-caption">{row.caption}</div>{/if}
			</div>
		{/each}
		{#if updatedText}<div class="pop-updated" class:stale={node.stale}>{updatedText}</div>{/if}
	</div>
{/if}

<style>
	.gauge { position: relative; display: inline-flex; align-items: center; gap: 3px; flex: none; max-width: 100%; border-radius: 6px; -webkit-tap-highlight-color: transparent; }
	/* Keyboard focus only, and subtle: a thin tinted ring, never a heavy box. */
	.gauge:focus:not(:focus-visible) { outline: none; }
	.gauge:focus-visible { outline: 1.5px solid color-mix(in srgb, var(--accent) 55%, transparent); outline-offset: 1px; }
	.gauge.stale { opacity: 0.65; }
	.circle { position: relative; flex: none; width: 26px; height: 26px; }
	.size-medium .circle { width: 48px; height: 48px; }
	.rings { display: block; width: 100%; height: 100%; overflow: visible; }
	circle { fill: none; stroke-width: 2.4; }
	.track { stroke: var(--border-strong); }
	.arc { stroke: var(--accent); transform: rotate(-90deg); transform-origin: 18px 18px; }
	.arc.accent { stroke: var(--accent); }
	.arc.ok { stroke: var(--ok); }
	.arc.warn { stroke: var(--warn); }
	.arc.danger { stroke: var(--danger); }
	.unknown { stroke: var(--text-faint); stroke-dasharray: 2 4; }
	.glyph { color: var(--text-dim); overflow: hidden; }
	.display { font-size: 10px; font-variant-numeric: tabular-nums; white-space: nowrap; color: var(--text-dim); }
	.size-medium .display { font-size: var(--fs-xs); }
	.badge { position: absolute; right: 0; top: 0; width: 9px; height: 9px; line-height: 9px; text-align: center; border-radius: 50%; font-size: 7px; overflow: hidden; color: var(--bg); background: var(--warn); }
	.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
	.popover {
		position: fixed; top: 0; left: 0; z-index: var(--z-tooltip); box-sizing: border-box;
		min-width: min(240px, calc(var(--vw) - 16px)); max-width: min(320px, calc(var(--vw) - 16px)); overflow-y: auto;
		padding: 10px 12px; border-radius: var(--radius); border: 1px solid var(--border-strong);
		background: var(--bg-elev); color: var(--text); box-shadow: var(--shadow);
		font-size: var(--fs-xs); line-height: 1.4; text-align: left; white-space: normal;
		transform-origin: top center; animation: pop-in var(--motion-normal) var(--ease);
	}
	.popover.above { transform-origin: bottom center; }
	@keyframes pop-in { from { opacity: 0; transform: translateY(-4px) scale(0.96); } to { opacity: 1; transform: none; } }
	@media (prefers-reduced-motion: reduce) {
		.popover { animation: none; }
		.pop-fill { transition: none !important; }
	}
	.pop-title { font-weight: 600; font-size: var(--fs-sm); margin-bottom: 6px; overflow-wrap: anywhere; }
	.pop-stale { margin-bottom: 6px; padding: 2px 6px; border-radius: 5px; font-size: var(--fs-2xs); color: var(--warn); background: var(--warn-soft); }
	.pop-updated { margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--border-strong); font-size: var(--fs-2xs); font-variant-numeric: tabular-nums; color: var(--text-faint); }
	.pop-updated.stale { color: var(--warn); }
	.pop-group { margin: 8px 0 4px; font-size: var(--fs-2xs); font-weight: 600; letter-spacing: 0.02em; color: var(--text-faint); overflow-wrap: anywhere; }
	.pop-group:first-child { margin-top: 0; }
	.pop-row { margin: 0 0 8px; }
	.pop-row:last-child { margin-bottom: 0; }
	.pop-line { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 3px; }
	.pop-label { min-width: 0; overflow-wrap: anywhere; color: var(--text); }
	.pop-value { flex: none; font-variant-numeric: tabular-nums; color: var(--text-dim); text-align: right; }
	.pop-value.unknown { color: var(--text-faint); }
	.pop-track { height: 6px; border-radius: var(--radius-pill); overflow: hidden; background: var(--border-strong); }
	.pop-track.unknown { background: transparent; border: 1px dashed var(--text-faint); opacity: 0.6; box-sizing: border-box; }
	.pop-fill { height: 100%; border-radius: var(--radius-pill); background: var(--accent); transition: width var(--motion-normal) var(--ease-std); }
	.pop-fill.ok { background: var(--ok); }
	.pop-fill.warn { background: var(--warn); }
	.pop-fill.danger { background: var(--danger); }
	.pop-caption { margin-top: 2px; font-size: var(--fs-2xs); color: var(--text-dim); overflow-wrap: anywhere; }
	@media (max-width: 600px) {
		.size-small { flex-direction: column; gap: 0; justify-content: center; }
		.size-small .circle { width: 22px; height: 22px; }
		.size-small .display { font-size: 8px; line-height: 9px; }
		.badge { width: 8px; height: 8px; line-height: 8px; font-size: 6px; }
	}
</style>
