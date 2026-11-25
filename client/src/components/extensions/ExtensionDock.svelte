<script lang="ts">
	import { manifestName } from "../../lib/extensions/translations";
	import IconButton from "../ui/IconButton.svelte";
	import Segmented from "../ui/Segmented.svelte";
	import { t } from "../../lib/i18n";
	import { extensions, type ExtensionPanel } from "../../lib/extensions/host.svelte";
	import { app } from "../../lib/store.svelte";
	import { viewport } from "../../lib/viewport.svelte";
	import ExtensionSurface from "./ExtensionSurface.svelte";
	import { EdgeResizeController } from "../../lib/shell/sidebar-resize.svelte";
	import { verticalFade } from "../../lib/edge-fade";

	/**
	 * `side` panels: a dock at the right of the conversation area, one tab per shown panel. On desktop it shares the
	 * left sidebar's edge-drag collapse/expand model (no close button; dragging past the edge snaps it into a slim edge
	 * handle and pulling it back snaps it open). On a narrow screen it takes the whole stage with a close button.
	 */
	const DOCK_MIN_W = 200;
	const key = (p: ExtensionPanel) => `${p.owner}:${p.id}`;
	const ownerName = (owner: string) => ((m) => (m ? manifestName(m) : owner))(extensions.installed.find((e) => e.package.manifest.id === owner)?.package.manifest);
	const shown = $derived(extensions.panels.filter((p) => p.placement === "side" && p.open && extensions.installed.some((e) => e.package.manifest.id === p.owner && e.state === "active")));
	let picked = $state<string | null>(null);
	const current = $derived(shown.find((p) => key(p) === picked) ?? shown.at(-1));
	const collapsed = $derived(!viewport.narrow && app.sidebar.dockCollapsed);
	/** What the user dragged, per panel; a `ui.place` call (bumping `placed`) goes back to the extension's width. */
	let dragged = $state<Record<string, { w: number; placed: number }>>({});
	const width = $derived.by(() => {
		if (!current) return 0;
		const d = dragged[key(current)];
		return d && d.placed === current.placed ? d.w : (current.size?.width ?? 360);
	});
	// a panel that was just shown or re-placed comes to the front (and unfolds the dock after initial mount)
	let seeded = false;
	let before = new Map<string, number>();
	$effect(() => {
		for (const p of shown) {
			const k = key(p);
			const prev = before.get(k);
			if (prev === undefined) {
				picked = k;
				if (seeded) app.sidebar.setDockCollapsed(false);
			} else if (prev !== p.placed && seeded) {
				picked = k;
				app.sidebar.setDockCollapsed(false);
			}
		}
		before = new Map(shown.map((p) => [key(p), p.placed]));
		seeded = true;
	});

	const resize = new EdgeResizeController(
		{
			isCollapsed: () => app.sidebar.dockCollapsed,
			setCollapsed: (v, persist = true) => app.sidebar.setDockCollapsed(v, persist),
			shownWidth: () => width,
			setWidth: (w) => {
				if (!current) return;
				dragged = { ...dragged, [key(current)]: { w: Math.round(w), placed: current.placed } };
			},
		},
		{
			side: "right",
			collapsedWidth: 0,
			minWidth: DOCK_MIN_W,
			maxWidth: () => (typeof window === "undefined" ? 800 : Math.max(DOCK_MIN_W, Math.round(window.innerWidth * 0.7))),
		},
	);

	function hide(p: ExtensionPanel) {
		try { extensions.setPanelOpen(p.owner, p.id, false); } catch { /* gone */ }
	}
</script>

{#if current}
	<aside
		class="dock"
		class:narrow={viewport.narrow}
		class:collapsed
		class:resizing={resize.resizing}
		class:folding={resize.resizing && resize.foldingPreview}
		data-part="dock"
		style:--dock-w="{width}px"
		aria-label={t("확장 패널")}
	>
		{#if !viewport.narrow}
			<!-- A window splitter (WAI-ARIA): stays mounted when collapsed so pulling or clicking the right edge unfolds the dock. -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
			<div
				class="edge"
				role="separator"
				aria-orientation="vertical"
				aria-label={t("확장 패널 너비 조절")}
				aria-valuemin={DOCK_MIN_W}
				aria-valuenow={collapsed ? 0 : width}
				tabindex="0"
				title={collapsed ? t("끌어서 펼치기 · 클릭으로 펼치기") : t("끌어서 너비 조절 · 밀어넣어 접기 · 클릭으로 접기/펼치기")}
				onpointerdown={resize.down}
				onpointermove={resize.move}
				onpointerup={resize.up}
				onpointercancel={resize.up}
				onkeydown={resize.key}
			></div>
		{/if}
		<div class="dock-content" inert={collapsed}>
			<header class:with-close={viewport.narrow}>
				<div class="tabs">
					<Segmented tabs variant="underline" full={false} label={t("확장 패널")} value={key(current)} onchange={(id) => (picked = id)}
						options={shown.map((p) => ({ id: key(p), label: p.title, title: ownerName(p.owner) }))} />
				</div>
				{#if viewport.narrow}
					<IconButton icon="x" label={t("확장 패널 닫기")} onclick={() => hide(current)} />
				{/if}
			</header>
			<div class="bodywrap vfade">
				<div class="body" use:verticalFade>
					{#key key(current)}
						{#if current.description}<p class="desc">{current.description}</p>{/if}
						<ExtensionSurface panel={current} />
					{/key}
				</div>
			</div>
		</div>
	</aside>
{/if}

<style>
	.dock { position: relative; flex: none; width: min(var(--dock-w), 70vw); min-width: 200px; display: flex; flex-direction: column; min-height: 0; background: var(--bg-side); border-left: 1px solid var(--border); transition: width var(--motion-normal) var(--ease-std); }
	.dock.resizing { transition: none; }
	.dock.collapsed { width: 0; min-width: 0; border-left: none; overflow: visible; }
	.dock.narrow { position: absolute; inset: 0; z-index: var(--z-dock); width: auto; min-width: 0; border-left: none; transition: none; }
	.dock.narrow .body { padding-bottom: calc(12px + var(--sab)); }
	.dock-content { display: flex; flex-direction: column; flex: 1; min-height: 0; width: 100%; transition: opacity var(--motion-fast) var(--ease-std); }
	.dock.collapsed .dock-content { display: none; }
	.dock.folding .dock-content { opacity: 0.65; }
	.edge { position: absolute; z-index: var(--z-popover); top: 0; bottom: 0; left: -4px; /* centres the 9px hit strip over the 1px left border */ width: 9px; cursor: col-resize; touch-action: none; }
	.dock.collapsed .edge { left: -8px; /* sits flush inside the viewport right edge so the 8px handle stays grabbable */ width: 8px; }
	.edge::before { content: ""; position: absolute; top: calc(50% - 16px); left: 3px; /* centres the 4px grabber on the 2px hairline at left: 4px */ width: 4px; height: 32px; border-radius: 2px; background: var(--accent); opacity: 0; transition: opacity var(--motion-fast) var(--ease-std), background var(--motion-fast) var(--ease-std); }
	.edge::after { content: ""; position: absolute; top: 0; bottom: 0; left: 4px; width: 2px; background: var(--accent); opacity: 0; transition: opacity var(--motion-fast) var(--ease-std); }
	.dock.collapsed .edge::before { left: auto; right: 2px; background: var(--text-faint); opacity: 0.45; }
	.dock.collapsed .edge::after { left: auto; right: 0; }
	.edge:focus-visible { outline: none; }
	.edge:focus-visible::after,
	.dock.resizing .edge::after { opacity: 0.6; }
	.edge:focus-visible::before,
	.dock.resizing .edge::before { background: var(--accent); opacity: 0.9; }
	@media (hover: hover) {
		.edge:hover::after { opacity: 0.6; }
		.edge:hover::before { background: var(--accent); opacity: 0.9; }
	}
	/* the header's hairline runs under the close button too */
	header { flex: none; display: flex; align-items: center; gap: 4px; padding: 0; box-sizing: content-box; min-height: 44px; border-bottom: 1px solid var(--border); /* the app header's box (44px + 1px hairline), so the lines meet across the dock edge */ }
	header.with-close { padding-right: 12px; }
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
