<script lang="ts">
	import IconButton from "../IconButton.svelte";
	import { t } from "../../lib/i18n";
	import { extensions, type ExtensionPanel } from "../../lib/extensions/host.svelte";
	import { viewport } from "../../lib/viewport.svelte";
	import ExtensionSurface from "./ExtensionSurface.svelte";

	/**
	 * `side` panels: a dock at the right of the conversation area, one tab per shown panel. Its width starts at the
	 * panel's `size.width` (default 360px) and the user can drag the edge. On a narrow screen it takes the whole stage.
	 */
	const key = (p: ExtensionPanel) => `${p.owner}:${p.id}`;
	const ownerName = (owner: string) => extensions.installed.find((e) => e.package.manifest.id === owner)?.package.manifest.name ?? owner;
	const shown = $derived(extensions.panels.filter((p) => p.placement === "side" && p.open && extensions.installed.some((e) => e.package.manifest.id === p.owner && e.state === "active")));
	let picked = $state<string | null>(null);
	const current = $derived(shown.find((p) => key(p) === picked) ?? shown.at(-1));
	/** What the user dragged, per panel; a `ui.place` call (bumping `placed`) goes back to the extension's width. */
	let dragged = $state<Record<string, { w: number; placed: number }>>({});
	const width = $derived.by(() => {
		if (!current) return 0;
		const d = dragged[key(current)];
		return d && d.placed === current.placed ? d.w : (current.size?.width ?? 360);
	});
	// a panel that was just shown comes to the front
	let before = new Set<string>();
	$effect(() => {
		const now = new Set(shown.map(key));
		for (const k of now) if (!before.has(k)) picked = k;
		before = now;
	});

	let from: { x: number; w: number } | null = null;
	function down(e: PointerEvent) {
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		from = { x: e.clientX, w: width };
		document.body.style.userSelect = "none";
	}
	function move(e: PointerEvent) {
		if (!from || !current) return;
		const w = Math.round(Math.min(Math.max(200, from.w + from.x - e.clientX), window.innerWidth * 0.7));
		dragged = { ...dragged, [key(current)]: { w, placed: current.placed } };
	}
	function up() {
		from = null;
		document.body.style.userSelect = "";
	}
	function keyResize(e: KeyboardEvent) {
		const d = e.key === "ArrowLeft" ? 16 : e.key === "ArrowRight" ? -16 : 0;
		if (!d || !current) return;
		e.preventDefault();
		dragged = { ...dragged, [key(current)]: { w: Math.max(200, width + d * (e.shiftKey ? 4 : 1)), placed: current.placed } };
	}
	function hide(p: ExtensionPanel) {
		try { extensions.setPanelOpen(p.owner, p.id, false); } catch { /* gone */ }
	}
</script>

{#if current}
	<aside class="dock" class:narrow={viewport.narrow} data-part="dock" style:--dock-w="{width}px" aria-label={t("확장 패널")}>
		{#if !viewport.narrow}
			<!-- A window splitter (WAI-ARIA): focusable, with value attributes and arrow-key handling (keyResize). -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
			<div class="edge" role="separator" aria-orientation="vertical" aria-label={t("확장 패널 너비 조절")} aria-valuenow={width} tabindex="0"
				onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up} onkeydown={keyResize}></div>
		{/if}
		<header>
			<div class="tabs" role="tablist">
				{#each shown as p (key(p))}
					<button role="tab" class="tab" class:on={p === current} aria-selected={p === current} title={ownerName(p.owner)} onclick={() => (picked = key(p))}>{p.title}</button>
				{/each}
			</div>
			<IconButton icon="x" label={t("확장 패널 닫기")} onclick={() => hide(current)} />
		</header>
		<div class="body">
			{#key key(current)}
				{#if current.description}<p class="desc">{current.description}</p>{/if}
				<ExtensionSurface panel={current} />
			{/key}
		</div>
	</aside>
{/if}

<style>
	.dock { position: relative; flex: none; width: min(var(--dock-w), 70vw); min-width: 200px; display: flex; flex-direction: column; min-height: 0; background: var(--bg-side); border-left: 1px solid var(--border); }
	.dock.narrow { position: absolute; inset: 0; z-index: 25; width: auto; border-left: none; }
	.edge { position: absolute; z-index: 2; top: 0; bottom: 0; left: -4px; width: 8px; cursor: col-resize; touch-action: none; }
	.edge:hover, .edge:focus-visible { background: linear-gradient(90deg, transparent 3px, var(--accent) 3px, var(--accent) 5px, transparent 5px); outline: none; opacity: 0.6; }
	header { flex: none; display: flex; align-items: center; gap: 6px; padding: 6px 6px 6px 10px; border-bottom: 1px solid var(--border); }
	.tabs { flex: 1; min-width: 0; display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; }
	.tab { flex: none; max-width: 180px; padding: 5px 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-xs); font-weight: 600; color: var(--text-dim); border-radius: var(--radius-sm); }
	.tab:hover { background: var(--bg-hover); color: var(--text); }
	.tab.on { background: var(--bg-active); color: var(--text); }
	.body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 14px; }
	.desc { margin: 0 0 12px; font-size: var(--fs-xs); color: var(--text-dim); line-height: 1.6; overflow-wrap: anywhere; }
</style>
