<script lang="ts">
	import IconButton from "../IconButton.svelte";
	import { t } from "../../lib/i18n";
	import { extensions, type ExtensionPanel } from "../../lib/extensions/host.svelte";
	import type { UIPanelPosition } from "../../lib/extensions/ui";
	import ExtensionSurface from "./ExtensionSurface.svelte";

	/**
	 * `floating` panels: small windows over the app that never block it. The title bar drags a window; the corner
	 * resizes it; the extension's `size` and `position` are where it starts (and where `ui.place` puts it back).
	 * Positions are kept inside the window.
	 */
	const key = (p: ExtensionPanel) => `${p.owner}:${p.id}`;
	const ownerName = (owner: string) => extensions.installed.find((e) => e.package.manifest.id === owner)?.package.manifest.name ?? owner;
	const shown = $derived(extensions.panels.filter((p) => p.placement === "floating" && p.open && extensions.installed.some((e) => e.package.manifest.id === p.owner && e.state === "active")));
	type Box = { x: number; y: number; w: number; h: number; placed: number };
	let boxes = $state<Record<string, Box>>({});
	/** Stacking: the window touched last is on top. */
	let order = $state<string[]>([]);
	let vw = $state(typeof window === "undefined" ? 1280 : window.innerWidth);
	let vh = $state(typeof window === "undefined" ? 800 : window.innerHeight);
	const M = 12;

	function start(p: ExtensionPanel): Box {
		const w = Math.min(p.size?.width ?? 380, vw - 2 * M);
		const h = Math.min(p.size?.height ?? 320, vh - 2 * M);
		const at: UIPanelPosition = p.position ?? "bottom-right";
		const pos = typeof at === "object" ? at
			: at === "center" ? { x: (vw - w) / 2, y: (vh - h) / 2 }
			: { x: at.endsWith("left") ? M : vw - w - M, y: at.startsWith("top") ? M + 48 : vh - h - M - 72 };
		return { ...pos, w, h, placed: p.placed };
	}
	const clampBox = (b: Box): Box => {
		const w = Math.max(200, Math.min(b.w, vw - 2 * M)), h = Math.max(120, Math.min(b.h, vh - 2 * M));
		return { ...b, w, h, x: Math.min(Math.max(M, b.x), vw - w - M), y: Math.min(Math.max(M, b.y), vh - h - M) };
	};
	const boxOf = (p: ExtensionPanel): Box => {
		const b = boxes[key(p)];
		return clampBox(b && b.placed === p.placed ? b : start(p));
	};
	function raise(p: ExtensionPanel) {
		const k = key(p);
		if (order.at(-1) !== k) order = [...order.filter((x) => x !== k), k];
	}

	let drag: { k: string; mode: "move" | "size"; x: number; y: number; from: Box } | null = null;
	function down(e: PointerEvent, p: ExtensionPanel, mode: "move" | "size") {
		if (mode === "move" && (e.target as HTMLElement).closest("button")) return;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		raise(p);
		drag = { k: key(p), mode, x: e.clientX, y: e.clientY, from: boxOf(p) };
		document.body.style.userSelect = "none";
	}
	function move(e: PointerEvent) {
		if (!drag) return;
		const dx = e.clientX - drag.x, dy = e.clientY - drag.y, f = drag.from;
		boxes = { ...boxes, [drag.k]: drag.mode === "move" ? { ...f, x: f.x + dx, y: f.y + dy } : { ...f, w: f.w + dx, h: f.h + dy } };
	}
	function up() {
		drag = null;
		document.body.style.userSelect = "";
	}
	function hide(p: ExtensionPanel) {
		try { extensions.setPanelOpen(p.owner, p.id, false); } catch { /* gone */ }
	}
</script>

<svelte:window bind:innerWidth={vw} bind:innerHeight={vh} />

{#each shown as p (key(p))}
	{@const b = boxOf(p)}
	<section class="float" data-part="floating" aria-label={p.title}
		style:left="{b.x}px" style:top="{b.y}px" style:width="{b.w}px" style:height="{b.h}px" style:z-index={30 + Math.max(0, order.indexOf(key(p)))}
		onpointerdowncapture={() => raise(p)}>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<header onpointerdown={(e) => down(e, p, "move")} onpointermove={move} onpointerup={up} onpointercancel={up}>
			<span class="title">{p.title}</span>
			<span class="owner">{ownerName(p.owner)}</span>
			<IconButton icon="x" label={t("확장 창 닫기")} onclick={() => hide(p)} />
		</header>
		<div class="body"><ExtensionSurface panel={p} /></div>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="corner" title={t("끌어서 크기 조절")} onpointerdown={(e) => down(e, p, "size")} onpointermove={move} onpointerup={up} onpointercancel={up}></div>
	</section>
{/each}

<style>
	.float { position: fixed; display: flex; flex-direction: column; min-width: 0; background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--radius-panel); box-shadow: var(--shadow); overflow: hidden; }
	header { flex: none; display: flex; align-items: center; gap: 8px; padding: 4px 4px 4px 12px; background: var(--bg-side); border-bottom: 1px solid var(--border); cursor: grab; touch-action: none; }
	header:active { cursor: grabbing; }
	.title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-xs); font-weight: 650; }
	.owner { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; color: var(--text-faint); }
	.body { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 12px; }
	.corner { position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; touch-action: none; background: linear-gradient(135deg, transparent 50%, var(--border-strong) 50%, var(--border-strong) 60%, transparent 60%, transparent 70%, var(--border-strong) 70%, var(--border-strong) 80%, transparent 80%); }
</style>
