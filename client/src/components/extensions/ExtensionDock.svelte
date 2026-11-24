<script lang="ts">
	import { manifestName } from "../../lib/extensions/translations";
	import IconButton from "../ui/IconButton.svelte";
	import Segmented from "../ui/Segmented.svelte";
	import { t } from "../../lib/i18n";
	import { extensions, type ExtensionPanel } from "../../lib/extensions/host.svelte";
	import { viewport } from "../../lib/viewport.svelte";
	import ExtensionSurface from "./ExtensionSurface.svelte";
	import { released } from "../../lib/pointer";
	import { verticalFade } from "../../lib/edge-fade";

	/**
	 * `side` panels: a dock at the right of the conversation area, one tab per shown panel. Its width starts at the
	 * panel's `size.width` (default 360px) and the user can drag the edge. On a narrow screen it takes the whole stage.
	 */
	const key = (p: ExtensionPanel) => `${p.owner}:${p.id}`;
	const ownerName = (owner: string) => ((m) => (m ? manifestName(m) : owner))(extensions.installed.find((e) => e.package.manifest.id === owner)?.package.manifest);
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
		if (released(e)) return up();
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
			<div class="tabs">
				<Segmented tabs variant="underline" full={false} label={t("확장 패널")} value={key(current)} onchange={(id) => (picked = id)}
					options={shown.map((p) => ({ id: key(p), label: p.title, title: ownerName(p.owner) }))} />
			</div>
			<IconButton icon="x" label={t("확장 패널 닫기")} onclick={() => hide(current)} />
		</header>
		<div class="bodywrap vfade">
		<div class="body" use:verticalFade>
			{#key key(current)}
				{#if current.description}<p class="desc">{current.description}</p>{/if}
				<ExtensionSurface panel={current} />
			{/key}
		</div>
		</div>
	</aside>
{/if}

<style>
	.dock { position: relative; flex: none; width: min(var(--dock-w), 70vw); min-width: 200px; display: flex; flex-direction: column; min-height: 0; background: var(--bg-side); border-left: 1px solid var(--border); }
	.dock.narrow { position: absolute; inset: 0; z-index: var(--z-dock); width: auto; border-left: none; }
	.dock.narrow .body { padding-bottom: calc(12px + var(--sab)); }
	.edge { position: absolute; z-index: 2; top: 0; bottom: 0; left: -4px; width: 8px; cursor: col-resize; touch-action: none; }
	.edge:focus-visible { background: linear-gradient(90deg, transparent 3px, var(--accent) 3px, var(--accent) 5px, transparent 5px); outline: none; opacity: 0.6; }
	@media (hover: hover) { .edge:hover { background: linear-gradient(90deg, transparent 3px, var(--accent) 3px, var(--accent) 5px, transparent 5px); opacity: 0.6; } }
	/* the header's hairline runs under the close button too */
	header { flex: none; display: flex; align-items: center; gap: 4px; padding: 0 12px 0 0; box-sizing: content-box; min-height: 44px; border-bottom: 1px solid var(--border); /* the app header's box (44px + 1px hairline), so the lines meet across the dock edge */ }
	/* the 19px glyph of the 38px button lands on the body's 12px right edge: 12 - 9.5 bleed */
	header :global(.iconbtn:last-child) { margin-right: -9.5px; }
	header :global(.iconbtn:last-child:focus-visible) { outline-offset: -2px; }
	.tabs { flex: 1; min-width: 0; }
	/* the tabs fill the 44px header, and the header's own border is the hairline: the tabs' inset one would draw a second, 1px above it */
	.tabs :global(.utabs) { box-shadow: none; }
	.tabs :global(.utabs > button) { height: 44px; }
	.tabs :global(.utabs > button) { max-width: 180px; overflow: hidden; text-overflow: ellipsis; }
	.bodywrap { flex: 1; min-height: 0; --fade-bg: var(--bg-side); }
	.body { flex: 1; min-height: 0; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; padding: 12px; }
	.desc { margin: 0 0 12px; font-size: var(--fs-xs); color: var(--text-dim); line-height: 1.6; overflow-wrap: anywhere; }

	/* persistent side panel: the scrollbar thumb shows only while hovered or focused (no layout shift) */
	@media (hover: hover) and (pointer: fine) {
		.body {
			scrollbar-color: transparent transparent;
		}
		.body:hover,
		.body:focus-within {
			scrollbar-color: var(--border-strong) transparent;
		}
		.body::-webkit-scrollbar-thumb {
			background: transparent;
		}
		.body:hover::-webkit-scrollbar-thumb,
		.body:focus-within::-webkit-scrollbar-thumb {
			background: var(--border-strong);
		}
	}
</style>
