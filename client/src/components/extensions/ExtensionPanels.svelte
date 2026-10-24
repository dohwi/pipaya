<script lang="ts">
	import FilterChip from "../FilterChip.svelte";
	import { t } from "../../lib/i18n";
	import { closeAnimated } from "../../lib/motion";
	import { slidingIndicator } from "../../lib/sliding-indicator";
	import { rovingKeys } from "../../lib/roving";
	import { onDestroy } from "svelte";
	import Icon from "../Icon.svelte";
	import Accordion from "../Accordion.svelte";
	import { extensions, type ExtensionPanel } from "../../lib/extensions/host.svelte";
	import ExtensionSurface from "./ExtensionSurface.svelte";

	let { placement = "panel" }: { placement?: "panel" | "composer" } = $props();
	let dialog = $state<HTMLDialogElement>();
	let launcher = $state<HTMLButtonElement>();
	let error = $state("");
	let cancelClose: (() => void) | undefined;
	let expanded = $state.raw<Set<string>>(new Set());
	const uid = $props.id();
	const titleId = `${uid}-title`;
	const panelKey = (panel: ExtensionPanel) => `${panel.owner}:${panel.id}`;
	const ownerName = (owner: string) => extensions.installed.find((entry) => entry.package.manifest.id === owner)?.package.manifest.name ?? owner;
	const available = $derived(extensions.panels.filter((panel) =>
		(panel.placement ?? "panel") === placement &&
		extensions.installed.some((entry) => entry.package.manifest.id === panel.owner && entry.state === "active")
	));
	const failing = $derived(available.filter((panel) => panel.tone === "danger"));
	const selected = $derived(available.find((panel) => panelKey(panel) === extensions.activePanel));

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
		if (!rail || (!canPrev && !canNext) || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
		event.preventDefault();
		rail.scrollLeft += event.deltaY;
	}
	const showOwner = (panel: ExtensionPanel) => ownerName(panel.owner).trim().toLowerCase() !== panel.title.trim().toLowerCase();

	$effect(() => {
		available.length;
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
			error = `${ownerName(panel.owner)} (${panel.owner}): ${cause instanceof Error ? cause.message : String(cause)}`;
		}
	}

	function dialogKey(event: KeyboardEvent) {
		event.stopPropagation();
		if (event.key !== "Tab" || !dialog) return;
		const items = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex="0"]'))
			.filter(el => el.tabIndex >= 0 && el.getClientRects().length && !el.closest('[inert]'));
		const first = items[0], last = items.at(-1);
		if (!first || !last) { event.preventDefault(); return; }
		if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
			event.preventDefault(); last.focus();
		} else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
			event.preventDefault(); first.focus();
		}
	}

	function toggle(key: string, open: boolean) {
		const next = new Set(expanded);
		if (open) next.add(key);
		else next.delete(key);
		expanded = next;
	}

	$effect(() => {
		if (placement !== "panel" || !dialog) return;
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
		if (extensions.panelOpen && selected) {
			cancelClose?.();
			cancelClose = undefined;
			if (!dialog.open) {
				try {
					dialog.showModal();
				} catch (cause) {
					error = t("확장 화면을 열지 못했습니다: {error}", { error: cause instanceof Error ? cause.message : String(cause) });
					extensions.closePanel();
				}
			}
		} else if (dialog.open && !("closing" in dialog.dataset)) {
			cancelClose = closeAnimated(dialog);
			launcher?.focus({ preventScroll: true });
		}
	});

	onDestroy(() => {
		if (dialog?.open) {
			dialog.close();
			extensions.closePanel();
		}
	});
</script>

{#if placement === "composer"}
	{#if available.length}
		<div class="composer-panels">
			{#each available as panel (panelKey(panel))}
				<Accordion variant="box" open={expanded.has(panelKey(panel))} onchange={(v) => toggle(panelKey(panel), v)}>
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
		<button class="launcher" class:danger={failing.length > 0} bind:this={launcher} type="button" aria-haspopup="dialog" disabled={!available.length} onclick={() => open(failing[0])}
			title={failing.length ? t("오류: {names}", { names: failing.map((panel) => ownerName(panel.owner)).join(", ") }) : undefined}>
			<Icon name="widgets" /><span>{t("확장 화면")}</span><span class="count" class:danger={failing.length > 0}>{failing.length ? "!" : available.length}</span>
		</button>
		{#if !available.length}<span class="toolbar-hint">{t("활성 확장 화면이 없습니다.")}</span>{/if}
		<div class="feedback" aria-live="polite" aria-atomic="true">{error}</div>
	</div>
	{/if}

	<dialog
		bind:this={dialog}
		aria-labelledby={titleId}
		oncancel={(event) => { event.preventDefault(); extensions.closePanel(); }}
		onclose={() => { if (!dialog?.open) extensions.closePanel(); }}
		onkeydown={dialogKey}
		onkeyup={(event) => event.stopPropagation()}
	>
		<div class="panel-shell">
			<header>
				<div class="heading">
					<h2 id={titleId}>{t("확장 화면")}{selected ? ` · ${ownerName(selected.owner)}` : ""}</h2>
					<p>{t("확장에서 제공하는 별도 화면입니다.")}</p>
				</div>
				<button class="iconbtn close" type="button" aria-label={t("확장 화면 닫기")} onclick={() => extensions.closePanel()}><Icon name="x" /></button>
			</header>
			<div class="workspace">
				{#if available.length}
					<nav class="tabbar" aria-label={t("확장 화면 선택")}>
						<span class="total" aria-hidden="true">{available.length}</span>
						<div class="railwrap">
						<button class="iconbtn step prev" type="button" tabindex="-1" aria-label={t("이전 화면 보기")} class:idle={!canPrev} disabled={!canPrev} onclick={() => page(-1)}><Icon name="chevron-left" /></button>
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
						<button class="iconbtn step next" type="button" tabindex="-1" aria-label={t("다음 화면 보기")} class:idle={!canNext} disabled={!canNext} onclick={() => page(1)}><Icon name="chevron-right" /></button>
						</div>
					</nav>
				{/if}
				<div class="panel-body">
					<div class="feedback" aria-live="polite" aria-atomic="true">{error}</div>
					{#if extensions.panelOpen && selected}
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
					{:else}
						<div class="empty"><Icon name="widgets" /><h3>{t("활성 확장 화면이 없습니다.")}</h3><p>{t("화면을 제공하는 확장을 활성화하면 여기에 표시됩니다.")}</p></div>
					{/if}
				</div>
			</div>
		</div>
	</dialog>
{/if}

<style>
	.panel-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; }
	.launcher { display: inline-flex; align-items: center; gap: 8px; padding: 7px 12px; color: var(--text-dim); background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius-pill); font-size: var(--fs-xs); }
	.launcher:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); color: var(--text); }
	.launcher:disabled { opacity: 0.55; cursor: not-allowed; }
	.launcher :global(svg), .empty :global(svg) { stroke-width: 1.8; }
	.launcher :global(svg) { flex: none; width: 15px; height: 15px; }
	.count { display: grid; place-items: center; min-width: 20px; padding: 1px 5px; border-radius: var(--radius-pill); background: var(--bg-active); font-family: var(--mono); font-size: 10px; }
	.launcher.danger { color: var(--danger); border-color: var(--danger); }
	.count.danger { background: var(--danger); color: #fff; }
	.toolbar-hint { font-size: var(--fs-2xs); color: var(--text-faint); }
	.feedback { color: var(--danger); font-size: var(--fs-xs); line-height: 1.6; overflow-wrap: anywhere; }
	.feedback:empty { display: none; }
	dialog { width: min(1000px, 96vw); height: min(760px, calc(var(--dvh) * 0.9)); max-width: 96vw; max-height: calc(var(--dvh) * 0.9); padding: 0; margin: auto; overflow: hidden; color: var(--text); background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--radius-panel); box-shadow: var(--shadow); }
	dialog::backdrop { background: var(--scrim); backdrop-filter: blur(5px); }
	.panel-shell { height: 100%; display: flex; flex-direction: column; min-height: 0; }
	header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 20px 24px; background: var(--bg-side); border-bottom: 1px solid var(--border); }
	.heading { min-width: 0; }
	h2 { margin: 0; font-size: var(--fs-base); font-weight: 650; overflow-wrap: anywhere; }
	.heading p { margin: 5px 0 0; font-size: var(--fs-2xs); color: var(--text-faint); }
	.close { flex-shrink: 0; }
	.workspace { display: flex; flex-direction: column; flex: 1; min-height: 0; }
	.tabbar { flex: none; display: flex; align-items: center; gap: 6px; padding: 10px 14px 10px 20px; background: var(--bg-side); border-bottom: 1px solid var(--border); }
	.total { display: grid; place-items: center; flex: none; min-width: 22px; height: 22px; padding: 0 6px; margin-right: 4px; border-radius: var(--radius-pill); background: var(--bg-active); color: var(--text-faint); font-family: var(--mono); font-size: var(--fs-2xs); }
	/* the arrows float over the ends of the rail, so they take no room while there is nothing to scroll */
	.railwrap { position: relative; flex: 1; min-width: 0; display: flex; }
	.rail { position: relative; flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; padding: 2px; overflow-x: auto; overscroll-behavior-x: contain; scroll-snap-type: x proximity; scrollbar-width: none; }
	.rail::-webkit-scrollbar { display: none; }
	.rail.fade-l { mask-image: linear-gradient(to right, transparent, #000 28px); }
	.rail.fade-r { mask-image: linear-gradient(to left, transparent, #000 28px); }
	.rail.fade-l.fade-r { mask-image: linear-gradient(to right, transparent, #000 28px, #000 calc(100% - 28px), transparent); }
	.step { position: absolute; top: 50%; z-index: 2; width: 28px; height: 28px; margin-top: -14px; background: var(--bg-side); box-shadow: 0 0 0 1px var(--border); transition: opacity var(--motion-fast) var(--ease-std); }
	.step.prev { left: 0; }
	.step.next { right: 0; }
	.step :global(svg) { width: 15px; height: 15px; }
	/* only the arrow that can scroll is shown */
	.step.idle { opacity: 0; pointer-events: none; }
	.nav-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-xs); font-weight: 600; }
	.owner { font-size: 10px; color: var(--text-faint); overflow-wrap: anywhere; }
	.railowner { flex: none; max-width: 90px; padding-left: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-left: 1px solid var(--border); }
	.panel-body { min-width: 0; min-height: 0; padding: 28px; overflow-y: auto; overscroll-behavior: contain; }
	.panel-body > .feedback { margin-bottom: 16px; }
	.surface-heading { margin-bottom: 24px; padding-bottom: 20px; border-bottom: 1px solid var(--border); }
	.eyebrow { font-family: var(--mono); font-size: 10px; color: var(--text-faint); overflow-wrap: anywhere; }
	h3 { margin: 8px 0 0; font-size: var(--fs-2xl); font-weight: 650; letter-spacing: -0.03em; overflow-wrap: anywhere; }
	.surface-heading p, .empty p { margin: 9px 0 0; color: var(--text-dim); font-size: var(--fs-xs); line-height: 1.7; overflow-wrap: anywhere; }
	.empty { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; min-height: 260px; }
	.empty :global(svg) { width: 28px; height: 28px; margin-bottom: 10px; color: var(--text-faint); }
	.empty h3 { font-size: var(--fs-base); }
	.composer-panels { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
	.summary-title { flex: 1; min-width: 0; color: var(--text-dim); font-size: var(--fs-xs); font-weight: 600; overflow-wrap: anywhere; }
	.composer-panels .owner { max-width: 40%; }
	@media (max-width: 640px) {
		header { padding: 16px; }
		.tabbar { padding: 8px 12px; }
		.step { display: none; }
		.panel-body { flex: 1; padding: 20px 16px; }
		.surface-heading { margin-bottom: 20px; }
	}

</style>
