<script lang="ts">
	import { manifestName } from "../../lib/extensions/translations";
	import { errorText } from "../../lib/api";
	import IconButton from "../ui/IconButton.svelte";
	import FilterChip from "../ui/FilterChip.svelte";
	import Modal from "../ui/Modal.svelte";
	import { t } from "../../lib/i18n";
	import { slidingIndicator } from "../../lib/sliding-indicator";
	import { rovingKeys } from "../../lib/roving";
	import { onDestroy } from "svelte";
	import Icon from "../ui/Icon.svelte";
	import Accordion from "../ui/Accordion.svelte";
	import { extensions, type ExtensionPanel } from "../../lib/extensions/host.svelte";
	import ExtensionSurface from "./ExtensionSurface.svelte";

	/** `panel`: the launcher and the modal. `composer` / `sidebar`: the foldable sections of that place. */
	let { placement = "panel" }: { placement?: "panel" | "composer" | "sidebar" } = $props();
	let error = $state("");
	const panelKey = (panel: ExtensionPanel) => `${panel.owner}:${panel.id}`;
	const ownerName = (owner: string) => ((m) => (m ? manifestName(m) : owner))(extensions.installed.find((entry) => entry.package.manifest.id === owner)?.package.manifest);
	const available = $derived(extensions.panels.filter((panel) =>
		(panel.placement ?? "panel") === placement &&
		extensions.installed.some((entry) => entry.package.manifest.id === panel.owner && entry.state === "active")
	));
	const failing = $derived(available.filter((panel) => panel.tone === "danger"));
	const selected = $derived(available.find((panel) => panelKey(panel) === extensions.activePanel));
	const modalOpen = $derived(placement === "panel" && extensions.panelOpen && !!selected);

	// Badge rail: scrolls sideways when there are more panels than fit; arrows and edge fades follow the scroll position.
	let rail = $state<HTMLElement>();
	let canPrev = $state(false);
	let canNext = $state(false);

	function updateEdges() {
		if (!rail) return;
		canPrev = rail.scrollLeft > 1;
		canNext = rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 1;
	}
	function page(direction: -1 | 1) {
		rail?.scrollBy({ left: direction * Math.max(120, rail.clientWidth * 0.7), behavior: "smooth" });
	}
	function wheel(event: WheelEvent) {
		// a vertical wheel scrolls the rail sideways, but only while it actually overflows
		if (!rail || event.ctrlKey || (!canPrev && !canNext) || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
		event.preventDefault();
		rail.scrollLeft += event.deltaY;
	}
	const showOwner = (panel: ExtensionPanel) => ownerName(panel.owner).trim().toLowerCase() !== panel.title.trim().toLowerCase();

	$effect(() => {
		available.length;
		modalOpen;
		if (!rail) return;
		updateEdges();
		const observer = new ResizeObserver(updateEdges);
		observer.observe(rail);
		for (const child of Array.from(rail.children)) observer.observe(child);
		return () => observer.disconnect();
	});
	// keep the selected badge in view when it changes (also when opened from elsewhere)
	$effect(() => {
		selected;
		const target = rail?.querySelector<HTMLElement>('[aria-current="page"]');
		if (!rail || !target) return;
		const left = target.offsetLeft - (rail.clientWidth - target.offsetWidth) / 2;
		rail.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
	});

	function open(panel = selected ?? available[0]) {
		error = "";
		if (!panel) return;
		try {
			extensions.openPanel(panel.owner, panel.id);
		} catch (cause) {
			error = `${ownerName(panel.owner)} (${panel.owner}): ${errorText(cause)}`;
		}
	}

	function toggle(panel: ExtensionPanel, open: boolean) {
		try { extensions.setPanelOpen(panel.owner, panel.id, open); } catch { /* removed meanwhile */ }
	}

	$effect(() => {
		if (placement !== "panel") return;
		if (extensions.panelOpen && !selected) {
			const starting = extensions.panels.some(panel => panelKey(panel) === extensions.activePanel &&
				extensions.installed.some(entry => entry.package.manifest.id === panel.owner && entry.state === "starting"));
			// Startup may request ui.open before registration becomes visible. Wait
			// for activation rather than discarding that request.
			if (starting) return;
			// A removed or inactive selection must not reopen another extension.
			extensions.closePanel();
			extensions.activePanel = null;
		}
	});

	onDestroy(() => {
		if (placement === "panel" && extensions.panelOpen) {
			extensions.closePanel();
		}
	});
</script>

{#if placement !== "panel"}
	{#if available.length}
		<div class="composer-panels" class:in-sidebar={placement === "sidebar"}>
			{#each available as panel (panelKey(panel))}
				<Accordion variant="box" open={panel.open} onchange={(v) => toggle(panel, v)}>
					{#snippet head()}
						<span class="summary-title">{panel.title}</span>
						<span class="owner">{ownerName(panel.owner)}</span>
					{/snippet}
					<ExtensionSurface {panel} />
				</Accordion>
			{/each}
		</div>
	{/if}
{:else}
	{#if available.length || error}
	<div class="panel-toolbar">
		<button class="launcher" class:danger={failing.length > 0} type="button" aria-haspopup="dialog" disabled={!available.length} onclick={() => open(failing[0])}
			title={failing.length ? t("오류: {names}", { names: failing.map((panel) => ownerName(panel.owner)).join(", ") }) : undefined}>
			<Icon name="widgets" /><span>{t("확장 화면")}</span><span class="cbadge" class:danger={failing.length > 0}>{failing.length ? "!" : available.length}</span>
		</button>
		{#if !available.length}<span class="toolbar-hint">{t("켜진 확장 화면이 없습니다.")}</span>{/if}
		<div class="feedback" aria-live="polite" aria-atomic="true">{error}</div>
	</div>
	{/if}

	{#if modalOpen && selected}
		<Modal
			onclose={() => extensions.closePanel()}
			title={`${t("확장 화면")} · ${ownerName(selected.owner)}`}
			sub={t("확장에서 제공하는 별도 화면입니다.")}
			divider
			width={selected.size?.width ? `${selected.size.width}px` : "3xl"}
			height={selected.size?.height ? `${selected.size.height}px` : "760px"}
			maxHeight="calc(var(--dvh) * 0.9)"
			layer={3}
			portal
			safeArea
		>
			<!-- Keep extension panel keystrokes from leaking into global app shortcuts while preserving Tab/Esc on Modal. -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="workspace" onkeydown={(e) => { if (e.key !== "Escape" && e.key !== "Tab") e.stopPropagation(); }} onkeyup={(e) => e.stopPropagation()}>
				{#if available.length}
					<nav class="tabbar" aria-label={t("확장 화면 선택")}>
						<span class="cbadge total" aria-hidden="true">{available.length}</span>
						<div class="railwrap">
						<IconButton icon="chevron-left" label={t("이전 화면 보기")} class={["step prev", { idle: !canPrev }]} tabindex={-1} disabled={!canPrev} onclick={() => page(-1)} />
						<div
							class="rail"
							class:fade-l={canPrev}
							class:fade-r={canNext}
							bind:this={rail}
							onscroll={updateEdges}
							onwheel={wheel}
							use:slidingIndicator={{ selector: ".fchip.on", variant: "accent" }}
							use:rovingKeys={{ item: ".fchip" }}
						>
							{#each available as panel (panelKey(panel))}
								<FilterChip size="lg" current danger={panel.tone === "danger"} on={selected === panel} onclick={() => open(panel)}>
									<span class="nav-title">{panel.title}</span>
									{#if showOwner(panel)}<span class="owner railowner">{ownerName(panel.owner)}</span>{/if}
								</FilterChip>
							{/each}
						</div>
						<IconButton icon="chevron-right" label={t("다음 화면 보기")} class={["step next", { idle: !canNext }]} tabindex={-1} disabled={!canNext} onclick={() => page(1)} />
						</div>
					</nav>
				{/if}
				<div class="panel-body">
					<div class="feedback" aria-live="polite" aria-atomic="true">{error}</div>
					{#key panelKey(selected)}
						<section aria-label={selected.title}>
							<div class="surface-heading">
								{#if showOwner(selected)}<span class="eyebrow">{ownerName(selected.owner)}</span>{/if}
								<h3>{selected.title}</h3>
								{#if selected.description}<p>{selected.description}</p>{/if}
							</div>
							<ExtensionSurface panel={selected} />
						</section>
					{/key}
				</div>
			</div>
		</Modal>
	{/if}
{/if}

<style>
	.panel-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; }
	.launcher { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; padding: 8px 12px; color: var(--text-dim); background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius-pill); font-size: var(--fs-xs); white-space: nowrap; }
	@media (hover: hover) {
		.launcher:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); color: var(--text); }
	}
	.launcher:disabled { color: var(--disabled-fg); cursor: not-allowed; }
	.launcher :global(svg) { flex: none; width: 15px; height: 15px; stroke-width: 1.8; }
	.launcher.danger { color: var(--danger); border-color: var(--danger); }
	.toolbar-hint { font-size: var(--fs-2xs); color: var(--text-faint); }
	.feedback { color: var(--danger); font-size: var(--fs-xs); line-height: 1.6; overflow-wrap: anywhere; }
	.feedback:empty { display: none; }
	.workspace { display: flex; flex-direction: column; flex: 1; min-height: 0; background: var(--bg); }
	.tabbar { flex: none; display: flex; align-items: center; gap: 4px; padding: 8px 12px 8px 20px; background: var(--bg-side); border-bottom: 1px solid var(--border); }
	.total { margin-right: 4px; }
	/* the arrows float over the ends of the rail, so they take no room while there is nothing to scroll */
	.railwrap { position: relative; flex: 1; min-width: 0; display: flex; }
	.rail { position: relative; flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; padding: 4px; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scroll-snap-type: x proximity; scrollbar-width: none; }
	.rail::-webkit-scrollbar { display: none; }
	.rail.fade-l { mask-image: linear-gradient(to right, transparent, #000 28px); }
	.rail.fade-r { mask-image: linear-gradient(to left, transparent, #000 28px); }
	.rail.fade-l.fade-r { mask-image: linear-gradient(to right, transparent, #000 28px, #000 calc(100% - 28px), transparent); }
	:global(.iconbtn.step) { position: absolute; top: calc(50% - 14px); /* centred on the rail (a -12px margin left it 2px low) */ z-index: 2; width: 28px; height: 28px; background: var(--bg-side); box-shadow: 0 0 0 1px var(--border); transition: opacity var(--motion-fast) var(--ease-std); }
	:global(.iconbtn.step.prev) { left: 0; }
	:global(.iconbtn.step.next) { right: 0; }
	:global(.iconbtn.step svg) { width: 15px; height: 15px; }
	/* only the arrow that can scroll is shown */
	:global(.iconbtn.step.idle) { opacity: 0; pointer-events: none; }
	.nav-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-xs); font-weight: 600; }
	.owner { font-size: var(--fs-2xs); color: var(--text-faint); overflow-wrap: anywhere; }
	.railowner { flex: none; max-width: 90px; padding-left: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-left: 1px solid var(--border); }
	.panel-body { flex: 1; min-width: 0; min-height: 0; padding: 24px; overflow-y: auto; overscroll-behavior: contain; }
	.panel-body > .feedback { margin-bottom: 16px; }
	.surface-heading { margin-bottom: 24px; padding-bottom: 20px; border-bottom: 1px solid var(--border); }
	.eyebrow { font-family: var(--mono); font-size: var(--fs-2xs); color: var(--text-faint); overflow-wrap: anywhere; }
	h3 { margin: 8px 0 0; font-size: var(--fs-2xl); font-weight: 650; letter-spacing: -0.03em; overflow-wrap: anywhere; }
	.surface-heading p { margin: 8px 0 0; color: var(--text-dim); font-size: var(--fs-xs); line-height: 1.7; overflow-wrap: anywhere; }
	.composer-panels { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
	.summary-title { flex: 1; min-width: 0; color: var(--text-dim); font-size: var(--fs-xs); font-weight: 600; overflow-wrap: anywhere; }
	.composer-panels .owner { max-width: 40%; }
	.composer-panels.in-sidebar { max-height: calc(var(--dvh) * 0.45); overflow-y: auto; padding: 0 8px 8px; }
	@media (max-width: 640px) {
		.tabbar { padding: 8px 12px; }
		:global(.iconbtn.step) { display: none; }
		.panel-body { flex: 1; padding: 20px 16px; }
		.surface-heading { margin-bottom: 20px; }
	}
</style>
